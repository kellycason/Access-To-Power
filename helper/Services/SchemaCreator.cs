using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using AccessToPower.Helper.Models;

namespace AccessToPower.Helper.Services;

/// <summary>
/// Helper-side port of src/services/schemaCreator.ts. Reads an approved
/// <see cref="MigrationPlan"/> and provisions the publisher, solution, tables,
/// columns, and N:1 lookups in Dataverse via the Web API.
///
/// Hosted-app fetch() to *.dynamics.com is blocked by CSP <c>connect-src 'none'</c>,
/// so the hosted app uploads the plan and launches this helper to do the work.
/// </summary>
public sealed class SchemaCreator
{
    private readonly DataverseClient _dv;
    private readonly Action<ProgressEvent> _report;

    public SchemaCreator(DataverseClient dv, Action<ProgressEvent> report)
    {
        _dv = dv;
        _report = report;
    }

    public async Task RunAsync(MigrationPlan plan, string publisherPrefix, string solutionUniqueName, CancellationToken ct)
    {
        Report("phase", "Ensuring publisher and solution…");
        var publisherId = await EnsurePublisherAsync(publisherPrefix, Capitalize(publisherPrefix), ct).ConfigureAwait(false);
        await EnsureSolutionAsync(solutionUniqueName, solutionUniqueName, publisherId, ct).ConfigureAwait(false);

        var migrateTables = plan.TableMappings.Where(t => t.Action == "Migrate").ToList();

        Report("phase", $"Creating {migrateTables.Count} tables…");

        // Pass 1: entities with primary-name attribute only.
        for (var i = 0; i < migrateTables.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var t = migrateTables[i];
            if (t.TargetMode == "existing")
            {
                // The user picked an existing table on purpose -- bring it
                // along into the new solution so the migration ships as a
                // single coherent unit. Idempotent (silently skips if it's
                // already a member, e.g. when also adding new columns later).
                await AddEntityShellToSolutionAsync(t.DataverseSchemaName, solutionUniqueName, ct).ConfigureAwait(false);
                Report("table:done", $"Using existing table {t.DataverseSchemaName} (added to solution).", t.DataverseSchemaName);
                continue;
            }
            var pct = (int)Math.Round(100.0 * i / Math.Max(1, migrateTables.Count));
            Report("table:start", $"Creating table {t.DataverseSchemaName}", t.DataverseSchemaName, pct);
            await CreateEntityIfMissingAsync(t, publisherPrefix, solutionUniqueName, ct).ConfigureAwait(false);
        }

        // Pass 2: non-lookup attributes per entity.
        Report("phase", "Creating columns…");
        foreach (var t in migrateTables)
        {
            ct.ThrowIfCancellationRequested();
            if (t.TargetMode == "existing")
            {
                var newFields = t.Fields
                    .Where(f => f.Action == "Map" && f.TargetMode == "new" && f.DataverseType != "Lookup")
                    .ToList();
                if (newFields.Count == 0)
                {
                    Report("log", $"Using existing columns on {t.DataverseSchemaName}.");
                    continue;
                }
                // Shell already added in Pass 1; the AddSolutionComponent call
                // is idempotent so a second invocation is harmless. Custom
                // attributes against system / managed tables (e.g. "product")
                // require this membership -- without it Dataverse rejects
                // attribute creation with 0x8004f026 "isparentcustomizable".
                await AddEntityShellToSolutionAsync(t.DataverseSchemaName, solutionUniqueName, ct).ConfigureAwait(false);

                Report("log", $"Adding {newFields.Count} new column(s) to existing table {t.DataverseSchemaName}…");
                foreach (var f in newFields)
                {
                    await CreateAttributeIfMissingAsync(t.DataverseSchemaName, f, solutionUniqueName, ct).ConfigureAwait(false);
                }
                continue;
            }
            foreach (var f in t.Fields)
            {
                if (f.Action != "Map") continue;
                if (f.IsAlternateKey && IsPrimaryKey(t, f)) continue;
                if (f.DataverseType == "Lookup") continue;
                // Only skip the column if it was actually used as the primary
                // name AND is text-like. If CreateTableAsync's backstop
                // overrode a non-Text/Memo PrimaryNameAccessColumn with the
                // synthetic <prefix>_name, the original column (e.g. an
                // Integer "AuthorOrder") still needs to be created as a
                // regular attribute — otherwise row inserts blow up with
                // "property does not exist on type".
                if (!string.IsNullOrEmpty(t.PrimaryNameAccessColumn)
                    && string.Equals(f.AccessColumn, t.PrimaryNameAccessColumn, StringComparison.OrdinalIgnoreCase)
                    && (string.Equals(f.DataverseType, "String", StringComparison.Ordinal)
                        || string.Equals(f.DataverseType, "Memo", StringComparison.Ordinal)))
                {
                    continue;
                }
                await CreateAttributeIfMissingAsync(t.DataverseSchemaName, f, solutionUniqueName, ct).ConfigureAwait(false);
            }
        }

        // Pass 3: relationships (lookups). Create new lookup columns even on
        // "existing" (OOB) child tables -- CreateLookupIfMissingAsync is
        // idempotent, and Pass 2 LookupResolver PATCHes @odata.bind payloads
        // that target these columns. Skipping would leave the FK column
        // absent and crash Pass 2 with "undeclared property 'acp_xxxid'".
        Report("phase", "Creating relationships…");
        foreach (var rel in plan.Manifest.Relationships)
        {
            ct.ThrowIfCancellationRequested();
            var parentMap = migrateTables.FirstOrDefault(t => t.AccessTable == rel.ParentTable);
            var childMap = migrateTables.FirstOrDefault(t => t.AccessTable == rel.ChildTable);
            if (parentMap is null || childMap is null) continue;
            if (rel.ChildColumns.Count != 1)
            {
                Report("log", $"Skipping composite FK {rel.Name} ({rel.ChildColumns.Count} columns).", severity: "warn");
                continue;
            }
            var childCol = rel.ChildColumns[0];

            // Bug A fix: prefer the user's mapping for this FK column. If the user
            // mapped the FK column as a Lookup with a specific schema name, honor it.
            var fkField = childMap.Fields.FirstOrDefault(f =>
                string.Equals(f.AccessColumn, childCol, StringComparison.OrdinalIgnoreCase));
            string lookupSchema;
            string lookupDisplay;
            if (fkField is not null && fkField.DataverseType == "Lookup" && !string.IsNullOrWhiteSpace(fkField.DataverseSchemaName))
            {
                lookupSchema = fkField.DataverseSchemaName;
                lookupDisplay = string.IsNullOrWhiteSpace(fkField.DataverseDisplayName)
                    ? DisplayLookupName(LookupBaseName(childCol))
                    : fkField.DataverseDisplayName;
            }
            else
            {
                var lookupName = LookupBaseName(childCol);
                lookupSchema = $"{publisherPrefix}_{Slug(lookupName)}";
                lookupDisplay = DisplayLookupName(lookupName);
            }
            await CreateLookupIfMissingAsync(
                childMap.DataverseSchemaName,
                parentMap.DataverseSchemaName,
                lookupSchema,
                lookupDisplay,
                solutionUniqueName,
                ct).ConfigureAwait(false);
        }

        // Pass 4: alternate keys (text PKs, business keys).
        // Must run AFTER attributes exist. Skip integer/autonumber PKs because
        // those columns are not created (Dataverse generates the GUID itself —
        // see IsPrimaryKey filter in attribute pass).
        Report("phase", "Creating alternate keys…");
        foreach (var t in migrateTables)
        {
            ct.ThrowIfCancellationRequested();
            if (t.TargetMode == "existing") continue;
            foreach (var f in t.Fields)
            {
                if (f.Action != "Map") continue;
                if (!f.IsAlternateKey) continue;
                if (IsPrimaryKey(t, f)) continue;        // not created → no alt-key possible
                if (f.DataverseType == "Lookup") continue; // alt-keys on lookups have stricter rules; skip for safety
                await CreateAlternateKeyIfMissingAsync(t.DataverseSchemaName, f, solutionUniqueName, ct).ConfigureAwait(false);
            }
        }

        Report("publish", "Publishing customizations…");
        await _dv.SendMetadataAsync(HttpMethod.Post, "PublishAllXml", "{}", solutionUniqueName, ct).ConfigureAwait(false);

        Report("phase", "Schema creation complete.", progress: 100);
    }

    /* --------- publisher / solution --------- */

    private async Task<string> EnsurePublisherAsync(string prefix, string friendlyName, CancellationToken ct)
    {
        var path = $"publishers?$filter=customizationprefix eq '{prefix}'&$select=publisherid&$top=1";
        using (var doc = await _dv.GetJsonAsync(path, ct).ConfigureAwait(false))
        {
            if (doc.RootElement.TryGetProperty("value", out var arr) && arr.GetArrayLength() > 0)
            {
                Report("log", $"Publisher '{prefix}' already exists.");
                return arr[0].GetProperty("publisherid").GetString() ?? "";
            }
        }
        var ovp = 10000 + new Random().Next(80000);
        var body = JsonSerializer.Serialize(new
        {
            uniquename = prefix,
            friendlyname = friendlyName,
            customizationprefix = prefix,
            customizationoptionvalueprefix = ovp,
        });
        using (var resp = await _dv.SendMetadataAsync(HttpMethod.Post, "publishers", body, null, ct).ConfigureAwait(false))
        {
            // POST publishers returns 204 No Content; ignore body, look up by prefix.
            _ = resp;
        }
        Report("log", $"Created publisher '{prefix}'.");
        using var doc2 = await _dv.GetJsonAsync(path, ct).ConfigureAwait(false);
        return doc2.RootElement.GetProperty("value")[0].GetProperty("publisherid").GetString() ?? "";
    }

    private async Task EnsureSolutionAsync(string uniqueName, string friendlyName, string publisherId, CancellationToken ct)
    {
        var path = $"solutions?$filter=uniquename eq '{uniqueName}'&$select=solutionid&$top=1";
        using var doc = await _dv.GetJsonAsync(path, ct).ConfigureAwait(false);
        if (doc.RootElement.TryGetProperty("value", out var arr) && arr.GetArrayLength() > 0)
        {
            Report("log", $"Solution '{uniqueName}' already exists.");
            return;
        }
        var body = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["uniquename"] = uniqueName,
            ["friendlyname"] = friendlyName,
            ["version"] = "1.0.0.0",
            ["publisherid@odata.bind"] = $"/publishers({publisherId})",
        });
        await _dv.SendMetadataAsync(HttpMethod.Post, "solutions", body, null, ct).ConfigureAwait(false);
        Report("log", $"Created solution '{uniqueName}'.");
    }

    /* --------- entities --------- */

    private async Task CreateEntityIfMissingAsync(TableMapping t, string prefix, string solutionUniqueName, CancellationToken ct)
    {
        var logical = t.DataverseSchemaName.ToLowerInvariant();
        var exists = await _dv.ExistsAsync($"EntityDefinitions(LogicalName='{logical}')?$select=LogicalName", ct).ConfigureAwait(false);
        if (exists)
        {
            // Hard fail when the migration plan says "create new" but the table already lives in
            // this environment. Silently reusing it would mix Access data with whatever is already
            // in there (we have hit this before — leftover acp_order rows from prior runs got
            // augmented instead of replaced, producing duplicate / unresolved lookups).
            // The end user must either pick "Use existing table" in the Map step or choose a
            // different schema name / publisher prefix.
            var modeIsExisting = string.Equals(t.TargetMode, "existing", StringComparison.OrdinalIgnoreCase);
            if (!modeIsExisting)
            {
                throw new InvalidOperationException(
                    $"Table '{logical}' already exists in this Dataverse environment, but the migration plan " +
                    $"says to create it as a new table for Access table '{t.AccessTable}'. " +
                    $"Go back to the Map step and either choose 'Use existing table' to map into '{logical}', " +
                    $"or pick a different schema name / publisher prefix so a fresh table can be created.");
            }
            Report("log", $"Entity {logical} already exists (use-existing mode).");
            return;
        }

        // Pick the primary name field. Must be a non-PK, non-Lookup field
        // mapped to a String/Memo/etc. — picking a Lookup would create the
        // entity with a String attribute at the same logical name as the
        // intended FK lookup, blocking Pass 3 from creating the relationship
        // ("already exists" → no lookup created → row patch fails with
        // "undeclared property"). Junction tables (e.g. BookAuthors with only
        // ID + BookID + AuthorID) typically end up with no good candidate;
        // fall back to a synthetic "<prefix>_name" attribute in that case.
        FieldMapping? primaryNameField = null;
        if (!string.IsNullOrEmpty(t.PrimaryNameAccessColumn))
        {
            primaryNameField = t.Fields.FirstOrDefault(f =>
                string.Equals(f.AccessColumn, t.PrimaryNameAccessColumn, StringComparison.OrdinalIgnoreCase));
        }
        if (primaryNameField is { DataverseType: "Lookup" })
        {
            // Defensive: planBuilder should already filter FKs out of the
            // primary-name selection, but make sure we don't honor it here.
            Report("log", $"Primary name '{primaryNameField.AccessColumn}' is a Lookup column on '{t.AccessTable}'; using '{prefix}_name' instead.", severity: "warn");
            primaryNameField = null;
        }
        if (primaryNameField is not null
            && !string.Equals(primaryNameField.DataverseType, "String", StringComparison.Ordinal)
            && !string.Equals(primaryNameField.DataverseType, "Memo", StringComparison.Ordinal))
        {
            // Defensive: Dataverse's primary-name attribute is always a String.
            // If the plan somehow selected a non-text column (Integer, Date,
            // Boolean, etc.), every row insert would fail with "Cannot convert
            // <type> to String". Fall back to a synthetic name column.
            Report("log", $"Primary name '{primaryNameField.AccessColumn}' is a {primaryNameField.DataverseType} column on '{t.AccessTable}'; using '{prefix}_name' instead.", severity: "warn");
            primaryNameField = null;
        }
        var primaryNameSchema = primaryNameField?.DataverseSchemaName ?? $"{prefix}_name";
        var primaryNameDisplay = primaryNameField?.DataverseDisplayName ?? "Name";

        // Dataverse auto-creates the entity primary key as `${logical}id`.
        // If the chosen primary name field collides with that, fall back to
        // `${prefix}_name` so the entity create body doesn't double-declare
        // the same column (SQL error 0x80040216).
        var reservedPkLogical = $"{logical}id";
        if (string.Equals(primaryNameSchema.ToLowerInvariant(), reservedPkLogical, StringComparison.Ordinal))
        {
            Report("log", $"Primary name field '{primaryNameSchema}' collides with auto-generated PK; using '{prefix}_name' instead.");
            primaryNameSchema = $"{prefix}_name";
            primaryNameDisplay = "Name";
        }

        var body = new JsonObject
        {
            ["@odata.type"] = "Microsoft.Dynamics.CRM.EntityMetadata",
            ["SchemaName"] = t.DataverseSchemaName,
            ["LogicalName"] = logical,
            ["DisplayName"] = Label(t.DataverseDisplayName),
            ["DisplayCollectionName"] = Label(string.IsNullOrEmpty(t.DataversePluralName) ? t.DataverseDisplayName : t.DataversePluralName),
            ["OwnershipType"] = "UserOwned",
            ["HasActivities"] = false,
            ["HasNotes"] = false,
            ["IsActivity"] = false,
            ["Attributes"] = new JsonArray(new JsonObject
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.StringAttributeMetadata",
                ["SchemaName"] = primaryNameSchema,
                ["LogicalName"] = primaryNameSchema.ToLowerInvariant(),
                ["DisplayName"] = Label(primaryNameDisplay),
                ["RequiredLevel"] = new JsonObject { ["Value"] = "ApplicationRequired" },
                ["MaxLength"] = Math.Min(primaryNameField?.MaxLength ?? 200, 4000),
                ["FormatName"] = new JsonObject { ["Value"] = "Text" },
                ["IsPrimaryName"] = true,
            }),
        };
        await _dv.SendMetadataAsync(HttpMethod.Post, "EntityDefinitions", body.ToJsonString(), solutionUniqueName, ct).ConfigureAwait(false);
        Report("table:done", $"Created {logical}.", logical);
    }

    /* --------- attributes --------- */

    private static bool IsPrimaryKey(TableMapping t, FieldMapping f)
    {
        var col = t.Fields.FirstOrDefault(x => x.AccessColumn == f.AccessColumn);
        return col is not null && col.IsAlternateKey && col.DataverseType == "Integer";
    }

    private async Task CreateAttributeIfMissingAsync(string entitySchema, FieldMapping f, string solutionUniqueName, CancellationToken ct)
    {
        var entityLogical = entitySchema.ToLowerInvariant();
        var attrLogical = f.DataverseSchemaName.ToLowerInvariant();
        // Dataverse auto-creates `${entityLogical}id` as the entity's primary
        // key. Attempting to create another attribute with that exact logical
        // name fails with SQL error 0x80040216 ("Column name ... specified
        // more than once"). Skip with a warning so the migration continues —
        // the original Access value is still recoverable via the idmap.
        if (string.Equals(attrLogical, $"{entityLogical}id", StringComparison.Ordinal))
        {
            Report("column", $"Skipping {entityLogical}.{attrLogical} — reserved for auto-generated primary key. Update plan to use a different schema name for column '{f.AccessColumn}'.");
            return;
        }
        // NoteAttachment isn't a Dataverse column at all — the data loader
        // writes per-row bytes as an `annotation` entity instead. Nothing to
        // create in the schema phase.
        if (string.Equals(f.DataverseType, "NoteAttachment", StringComparison.Ordinal))
        {
            Report("column", $"{entityLogical}.{attrLogical} → annotation (no column created).");
            return;
        }
        var existsPath = $"EntityDefinitions(LogicalName='{entityLogical}')/Attributes(LogicalName='{attrLogical}')?$select=LogicalName";
        if (await _dv.ExistsAsync(existsPath, ct).ConfigureAwait(false))
        {
            Report("column", $"{entityLogical}.{attrLogical} already exists.");
            return;
        }

        var reqLevel = f.IsRequired ? "ApplicationRequired" : "None";
        JsonObject? body = f.DataverseType switch
        {
            "String" => new JsonObject
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.StringAttributeMetadata",
                ["SchemaName"] = f.DataverseSchemaName,
                ["LogicalName"] = attrLogical,
                ["DisplayName"] = Label(f.DataverseDisplayName),
                ["RequiredLevel"] = new JsonObject { ["Value"] = reqLevel },
                ["MaxLength"] = Math.Min(Math.Max(f.MaxLength ?? 255, 1), 4000),
                ["FormatName"] = new JsonObject { ["Value"] = "Text" },
            },
            "Memo" => new JsonObject
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.MemoAttributeMetadata",
                ["SchemaName"] = f.DataverseSchemaName,
                ["LogicalName"] = attrLogical,
                ["DisplayName"] = Label(f.DataverseDisplayName),
                ["RequiredLevel"] = new JsonObject { ["Value"] = reqLevel },
                ["MaxLength"] = 1048576,
                ["Format"] = "TextArea",
            },
            "Integer" => new JsonObject
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
                ["SchemaName"] = f.DataverseSchemaName,
                ["LogicalName"] = attrLogical,
                ["DisplayName"] = Label(f.DataverseDisplayName),
                ["RequiredLevel"] = new JsonObject { ["Value"] = reqLevel },
                ["Format"] = "None",
                ["MinValue"] = -2147483648,
                ["MaxValue"] = 2147483647,
            },
            "BigInt" => new JsonObject
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.BigIntAttributeMetadata",
                ["SchemaName"] = f.DataverseSchemaName,
                ["LogicalName"] = attrLogical,
                ["DisplayName"] = Label(f.DataverseDisplayName),
                ["RequiredLevel"] = new JsonObject { ["Value"] = reqLevel },
            },
            "Decimal" => new JsonObject
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.DecimalAttributeMetadata",
                ["SchemaName"] = f.DataverseSchemaName,
                ["LogicalName"] = attrLogical,
                ["DisplayName"] = Label(f.DataverseDisplayName),
                ["RequiredLevel"] = new JsonObject { ["Value"] = reqLevel },
                ["Precision"] = Math.Min(Math.Max(f.Precision ?? 2, 0), 10),
                ["MinValue"] = -100000000000L,
                ["MaxValue"] = 100000000000L,
            },
            "Money" => new JsonObject
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.MoneyAttributeMetadata",
                ["SchemaName"] = f.DataverseSchemaName,
                ["LogicalName"] = attrLogical,
                ["DisplayName"] = Label(f.DataverseDisplayName),
                ["RequiredLevel"] = new JsonObject { ["Value"] = reqLevel },
                ["PrecisionSource"] = 2,
                ["MinValue"] = -922337203685477L,
                ["MaxValue"] = 922337203685477L,
            },
            "Double" => new JsonObject
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.DoubleAttributeMetadata",
                ["SchemaName"] = f.DataverseSchemaName,
                ["LogicalName"] = attrLogical,
                ["DisplayName"] = Label(f.DataverseDisplayName),
                ["RequiredLevel"] = new JsonObject { ["Value"] = reqLevel },
                ["Precision"] = 5,
                ["MinValue"] = -100000000000L,
                ["MaxValue"] = 100000000000L,
            },
            "DateTime" => new JsonObject
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
                ["SchemaName"] = f.DataverseSchemaName,
                ["LogicalName"] = attrLogical,
                ["DisplayName"] = Label(f.DataverseDisplayName),
                ["RequiredLevel"] = new JsonObject { ["Value"] = reqLevel },
                ["Format"] = "DateAndTime",
                ["DateTimeBehavior"] = new JsonObject { ["Value"] = "UserLocal" },
            },
            "DateOnly" => new JsonObject
            {
                // DateOnly behavior is permanent at create — Dataverse will
                // not let us change Format/DateTimeBehavior after the fact.
                // Scan-phase sampling must be confident before choosing this.
                ["@odata.type"] = "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
                ["SchemaName"] = f.DataverseSchemaName,
                ["LogicalName"] = attrLogical,
                ["DisplayName"] = Label(f.DataverseDisplayName),
                ["RequiredLevel"] = new JsonObject { ["Value"] = reqLevel },
                ["Format"] = "DateOnly",
                ["DateTimeBehavior"] = new JsonObject { ["Value"] = "DateOnly" },
            },
            "Boolean" => new JsonObject
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
                ["SchemaName"] = f.DataverseSchemaName,
                ["LogicalName"] = attrLogical,
                ["DisplayName"] = Label(f.DataverseDisplayName),
                ["RequiredLevel"] = new JsonObject { ["Value"] = reqLevel },
                ["DefaultValue"] = false,
                ["OptionSet"] = new JsonObject
                {
                    ["@odata.type"] = "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata",
                    ["TrueOption"] = new JsonObject { ["Value"] = 1, ["Label"] = Label("Yes") },
                    ["FalseOption"] = new JsonObject { ["Value"] = 0, ["Label"] = Label("No") },
                },
            },
            "Choice" => BuildChoiceAttribute(f, attrLogical, reqLevel),
            "File" => BuildFileAttribute(f, attrLogical, reqLevel),
            "Image" => BuildImageAttribute(f, attrLogical, reqLevel),
            _ => null,
        };

        if (body is null)
        {
            Report("log", $"Unsupported type {f.DataverseType} for {attrLogical}, skipped.", severity: "warn");
            return;
        }

        try
        {
            await _dv.SendMetadataAsync(
                HttpMethod.Post,
                $"EntityDefinitions(LogicalName='{entityLogical}')/Attributes",
                body.ToJsonString(),
                solutionUniqueName,
                ct).ConfigureAwait(false);
            Report("column", $"Created {entityLogical}.{attrLogical}");
        }
        catch (HttpRequestException ex) when (IsAlreadyExistsError(ex))
        {
            Report("column", $"{entityLogical}.{attrLogical} already exists.");
        }
    }

    /* --------- lookups --------- */

    /// <summary>
    /// Builds an inline-OptionSet PicklistAttributeMetadata payload for a
    /// Choice column. The plan carries the materialized integer values (so
    /// the data loader can translate row labels to ints deterministically).
    /// If the plan didn't materialize options we emit a placeholder option
    /// so the attribute is still created — empty option sets are rejected
    /// by Dataverse.
    /// </summary>
    private JsonObject BuildChoiceAttribute(FieldMapping f, string attrLogical, string reqLevel)
    {
        var options = new JsonArray();
        if (f.ChoiceOptions is { Count: > 0 })
        {
            foreach (var opt in f.ChoiceOptions)
            {
                options.Add(new JsonObject
                {
                    ["@odata.type"] = "Microsoft.Dynamics.CRM.OptionMetadata",
                    ["Value"] = opt.Value,
                    ["Label"] = Label(string.IsNullOrWhiteSpace(opt.Label) ? $"Option {opt.Value}" : opt.Label),
                });
            }
        }
        else
        {
            // Defensive fallback: Dataverse rejects an OptionSet with zero
            // options. Emit a single placeholder so the column still creates;
            // the user can extend the option set post-migration in the maker
            // portal if a value list slips through without labels.
            options.Add(new JsonObject
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.OptionMetadata",
                ["Value"] = 100000000,
                ["Label"] = Label("(unspecified)"),
            });
        }

        return new JsonObject
        {
            ["@odata.type"] = "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
            ["SchemaName"] = f.DataverseSchemaName,
            ["LogicalName"] = attrLogical,
            ["DisplayName"] = Label(f.DataverseDisplayName),
            ["RequiredLevel"] = new JsonObject { ["Value"] = reqLevel },
            ["OptionSet"] = new JsonObject
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.OptionSetMetadata",
                ["IsGlobal"] = false,
                ["OptionSetType"] = "Picklist",
                ["Options"] = options,
            },
        };
    }

    /// <summary>
    /// Builds a FileAttributeMetadata payload — a Dataverse File column for
    /// arbitrary blob storage. Bytes are uploaded out-of-band by DataLoader
    /// via PATCH /entitySet({id})/{column}/$value after each row insert.
    /// MaxSizeInKB is set from the plan (scan-time max + 1 MB slack) or
    /// defaults to 32 MB if unknown.
    /// </summary>
    private static JsonObject BuildFileAttribute(FieldMapping f, string attrLogical, string reqLevel)
    {
        // Dataverse caps File columns at 131072 KB (128 MB).
        var maxKb = Math.Min(Math.Max(f.BinaryMaxSizeKb ?? 32768, 1), 131072);
        return new JsonObject
        {
            ["@odata.type"] = "Microsoft.Dynamics.CRM.FileAttributeMetadata",
            ["SchemaName"] = f.DataverseSchemaName,
            ["LogicalName"] = attrLogical,
            ["DisplayName"] = Label(f.DataverseDisplayName),
            ["RequiredLevel"] = new JsonObject { ["Value"] = reqLevel },
            ["MaxSizeInKB"] = maxKb,
        };
    }

    /// <summary>
    /// Builds an ImageAttributeMetadata payload — a Dataverse Image column
    /// that stores both a thumbnail and the full-resolution image. Bytes
    /// are uploaded out-of-band by DataLoader via
    /// PATCH /entitySet({id})/{column}/$value after each row insert.
    /// </summary>
    private static JsonObject BuildImageAttribute(FieldMapping f, string attrLogical, string reqLevel)
    {
        // Dataverse caps Image columns at 30720 KB (30 MB).
        var maxKb = Math.Min(Math.Max(f.BinaryMaxSizeKb ?? 10240, 1), 30720);
        return new JsonObject
        {
            ["@odata.type"] = "Microsoft.Dynamics.CRM.ImageAttributeMetadata",
            ["SchemaName"] = f.DataverseSchemaName,
            ["LogicalName"] = attrLogical,
            ["DisplayName"] = Label(f.DataverseDisplayName),
            ["RequiredLevel"] = new JsonObject { ["Value"] = reqLevel },
            // First Image attribute on the entity is auto-marked as primary;
            // setting false explicitly avoids surprises when migrating a
            // table with multiple image columns.
            ["IsPrimaryImage"] = false,
            ["CanStoreFullImage"] = true,
            ["MaxSizeInKB"] = maxKb,
        };
    }

    private async Task CreateLookupIfMissingAsync(
        string childEntity, string parentEntity, string lookupSchema, string displayName,
        string solutionUniqueName, CancellationToken ct)
    {
        var childLogical = childEntity.ToLowerInvariant();
        var parentLogical = parentEntity.ToLowerInvariant();
        var attrLogical = lookupSchema.ToLowerInvariant();
        var existsPath = $"EntityDefinitions(LogicalName='{childLogical}')/Attributes(LogicalName='{attrLogical}')?$select=LogicalName";
        if (await _dv.ExistsAsync(existsPath, ct).ConfigureAwait(false))
        {
            Report("lookup", $"{childLogical}.{attrLogical} already exists.");
            return;
        }

        var relSchema = Truncate($"{parentLogical}_{childLogical}_{attrLogical}", 100);
        var body = new JsonObject
        {
            ["@odata.type"] = "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
            ["SchemaName"] = relSchema,
            ["ReferencedEntity"] = parentLogical,
            ["ReferencingEntity"] = childLogical,
            ["Lookup"] = new JsonObject
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
                ["SchemaName"] = lookupSchema,
                ["LogicalName"] = attrLogical,
                ["DisplayName"] = Label(displayName),
                ["RequiredLevel"] = new JsonObject { ["Value"] = "None" },
            },
            ["AssociatedMenuConfiguration"] = new JsonObject
            {
                ["Behavior"] = "UseCollectionName",
                ["Group"] = "Details",
                ["Order"] = 10000,
            },
            ["CascadeConfiguration"] = new JsonObject
            {
                ["Assign"] = "NoCascade",
                ["Delete"] = "RemoveLink",
                ["Merge"] = "NoCascade",
                ["Reparent"] = "NoCascade",
                ["Share"] = "NoCascade",
                ["Unshare"] = "NoCascade",
            },
        };
        try
        {
            await _dv.SendMetadataAsync(HttpMethod.Post, "RelationshipDefinitions", body.ToJsonString(), solutionUniqueName, ct).ConfigureAwait(false);
            Report("lookup", $"Created {childLogical}.{attrLogical} -> {parentLogical}");

            // Bug B fix: MSCRM.SolutionUniqueName on RelationshipDefinitions only
            // registers the new lookup attribute as a solution component, not the
            // relationship itself. Explicitly add the relationship via AddSolutionComponent.
            try
            {
                var relMetaResp = await _dv.GetJsonAsync(
                    $"RelationshipDefinitions(SchemaName='{relSchema}')?$select=MetadataId",
                    ct).ConfigureAwait(false);
                using (relMetaResp)
                {
                    var metaId = relMetaResp.RootElement.TryGetProperty("MetadataId", out var m) ? m.GetString() : null;
                    if (!string.IsNullOrEmpty(metaId))
                    {
                        var addBody = JsonSerializer.Serialize(new
                        {
                            ComponentId = metaId,
                            ComponentType = 10, // Entity Relationship
                            SolutionUniqueName = solutionUniqueName,
                            AddRequiredComponents = false,
                            DoNotIncludeSubcomponents = true,
                        });
                        await _dv.SendMetadataAsync(HttpMethod.Post, "AddSolutionComponent", addBody, null, ct).ConfigureAwait(false);
                        Report("log", $"Added relationship {relSchema} to solution {solutionUniqueName}.");
                    }
                }
            }
            catch (Exception addEx)
            {
                // When the lookup attribute was created with a MSCRM.SolutionUniqueName
                // header, Dataverse auto-adds the underlying relationship to that
                // solution. A follow-up AddSolutionComponent then either 404s
                // (relationship not found by SchemaName because it was just
                // added under a different cased name) or returns a "duplicate"
                // error. Both mean "already a member" — silence them.
                var msg = addEx.Message ?? string.Empty;
                if (msg.Contains("404", StringComparison.Ordinal) ||
                    msg.Contains("Not Found", StringComparison.OrdinalIgnoreCase) ||
                    msg.Contains("0x80060891", StringComparison.OrdinalIgnoreCase) ||
                    msg.Contains("already", StringComparison.OrdinalIgnoreCase) ||
                    msg.Contains("duplicate", StringComparison.OrdinalIgnoreCase))
                {
                    Report("log", $"Relationship {relSchema} is already in solution {solutionUniqueName}.");
                }
                else
                {
                    Report("log", $"Could not add relationship {relSchema} to solution: {msg}", severity: "warn");
                }
            }
        }
        catch (HttpRequestException ex) when (IsAlreadyExistsError(ex))
        {
            Report("lookup", $"{childLogical}.{attrLogical} already exists.");
        }
    }

    /* --------- helpers --------- */

    /// <summary>
    /// Adds an existing entity (system or otherwise) to the unmanaged solution
    /// as a "shell" component. Required before adding custom attributes to a
    /// system table — without it, attribute creation fails with 0x8004f026
    /// "isparentcustomizable". Idempotent.
    /// </summary>
    private async Task AddEntityShellToSolutionAsync(string entitySchema, string solutionUniqueName, CancellationToken ct)
    {
        var logical = entitySchema.ToLowerInvariant();
        try
        {
            using var doc = await _dv.GetJsonAsync(
                $"EntityDefinitions(LogicalName='{logical}')?$select=MetadataId",
                ct).ConfigureAwait(false);
            var metaId = doc.RootElement.TryGetProperty("MetadataId", out var m) ? m.GetString() : null;
            if (string.IsNullOrEmpty(metaId)) return;
            var body = JsonSerializer.Serialize(new
            {
                ComponentId = metaId,
                ComponentType = 1, // Entity
                SolutionUniqueName = solutionUniqueName,
                AddRequiredComponents = false,
                DoNotIncludeSubcomponents = true,
            });
            await _dv.SendMetadataAsync(HttpMethod.Post, "AddSolutionComponent", body, null, ct).ConfigureAwait(false);
            Report("log", $"Added shell of {logical} to solution {solutionUniqueName}.");
        }
        catch (Exception ex)
        {
            Report("log", $"Could not add shell of {logical} to solution: {ex.Message}", severity: "warn");
        }
    }

    /// <summary>
    /// Creates a single-column alternate key on an entity if one doesn't
    /// already cover the same attribute. Used to back business-key columns
    /// (Access text PKs, customer codes, etc.) so re-runs can upsert without
    /// duplicating rows. Idempotent.
    /// </summary>
    private async Task CreateAlternateKeyIfMissingAsync(
        string entitySchema,
        FieldMapping f,
        string solutionUniqueName,
        CancellationToken ct)
    {
        var entityLogical = entitySchema.ToLowerInvariant();
        var attrLogical = f.DataverseSchemaName.ToLowerInvariant();

        try
        {
            using var doc = await _dv.GetJsonAsync(
                $"EntityDefinitions(LogicalName='{entityLogical}')/Keys?$select=LogicalName,KeyAttributes",
                ct).ConfigureAwait(false);

            if (doc.RootElement.TryGetProperty("value", out var arr))
            {
                foreach (var existing in arr.EnumerateArray())
                {
                    if (!existing.TryGetProperty("KeyAttributes", out var ka)) continue;
                    if (ka.ValueKind != JsonValueKind.Array) continue;
                    if (ka.GetArrayLength() != 1) continue;
                    var only = ka[0].GetString();
                    if (string.Equals(only, attrLogical, StringComparison.OrdinalIgnoreCase))
                    {
                        Report("log", $"Alternate key on {entityLogical}.{attrLogical} already exists.");
                        return;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Report("log", $"Could not enumerate keys on {entityLogical}: {ex.Message}", severity: "warn");
        }

        // Key schema name has the same prefix+segment rules as attributes;
        // reuse the column's prefix and tack on a "_ak" suffix (kept under 50).
        var prefix = attrLogical.Split('_', 2)[0];
        var baseSeg = attrLogical.Length > prefix.Length + 1 ? attrLogical[(prefix.Length + 1)..] : attrLogical;
        var keySegment = baseSeg.Length > 44 ? baseSeg[..44] : baseSeg;
        var keySchema = $"{prefix}_{keySegment}_ak";
        if (keySchema.Length > 50) keySchema = keySchema[..50];

        var body = new JsonObject
        {
            ["@odata.type"] = "Microsoft.Dynamics.CRM.EntityKeyMetadata",
            ["SchemaName"] = keySchema,
            ["DisplayName"] = Label($"{f.DataverseDisplayName} (Alt Key)"),
            ["KeyAttributes"] = new JsonArray(attrLogical),
        };
        try
        {
            await _dv.SendMetadataAsync(
                HttpMethod.Post,
                $"EntityDefinitions(LogicalName='{entityLogical}')/Keys",
                body.ToJsonString(),
                solutionUniqueName,
                ct).ConfigureAwait(false);
            Report("log", $"Created alternate key {keySchema} on {entityLogical}.{attrLogical}.");
        }
        catch (Exception ex) when (IsAlreadyExistsError(ex))
        {
            Report("log", $"Alternate key {keySchema} already exists on {entityLogical}.");
        }
        catch (Exception ex)
        {
            // Alt-key creation can fail for legitimate reasons (existing dup
            // values, attribute type not eligible). Warn but don't abort —
            // schema phase has already done all the heavy lifting.
            Report("log",
                $"Alternate key on {entityLogical}.{attrLogical} could not be created: {ex.Message}",
                severity: "warn");
        }
    }

    private void Report(string kind, string message, string? entityLogicalName = null, int? progress = null, string? severity = null)
    {
        _report(new ProgressEvent
        {
            Kind = kind,
            Message = message,
            EntityLogicalName = entityLogicalName,
            Progress = progress,
            Severity = severity,
        });
    }

    private static bool IsAlreadyExistsError(Exception e)
    {
        var msg = e.Message ?? string.Empty;
        return msg.Contains("0x80047013", StringComparison.OrdinalIgnoreCase)
            || msg.Contains("already exists", StringComparison.OrdinalIgnoreCase);
    }

    private static JsonObject Label(string text) => new()
    {
        ["@odata.type"] = "Microsoft.Dynamics.CRM.Label",
        ["LocalizedLabels"] = new JsonArray(new JsonObject
        {
            ["@odata.type"] = "Microsoft.Dynamics.CRM.LocalizedLabel",
            ["Label"] = text,
            ["LanguageCode"] = 1033,
        }),
    };

    private static string Slug(string name)
    {
        var clean = System.Text.RegularExpressions.Regex.Replace(name, "[^a-zA-Z0-9]+", "_");
        clean = clean.Trim('_').ToLowerInvariant();
        return clean.Length > 40 ? clean[..40] : clean;
    }

    private static string LookupBaseName(string accessForeignKeyColumn)
    {
        var trimmed = accessForeignKeyColumn.Trim();
        return System.Text.RegularExpressions.Regex.Replace(trimmed, "(?i)_?id$", "") is { Length: > 0 } s ? s : trimmed;
    }

    private static string DisplayLookupName(string name)
    {
        var s = name.Replace("_", " ").Replace("-", " ");
        s = System.Text.RegularExpressions.Regex.Replace(s, "([a-z])([A-Z])", "$1 $2");
        s = System.Text.RegularExpressions.Regex.Replace(s, "\\s+", " ").Trim();
        return s;
    }

    private static string Truncate(string s, int n) => s.Length > n ? s[..n] : s;
    private static string Capitalize(string s) => string.IsNullOrEmpty(s) ? s : char.ToUpper(s[0]) + s[1..];
}

public sealed class ProgressEvent
{
    public string Kind { get; init; } = "log";
    public string Message { get; init; } = "";
    public string? Severity { get; init; }
    public int? Progress { get; init; }
    public string? EntityLogicalName { get; init; }
}
