using System.Net.Http;
using System.Text;
using System.Text.Json;
using AccessToPower.Helper.Models;

namespace AccessToPower.Helper.Services;

/// <summary>
/// Provisions a basic Dataverse model-driven app over the migrated tables.
///
/// Runs in the helper (not the SPA) because the SPA host is cross-origin
/// from the Dataverse environment and cannot make POST/PATCH/action calls
/// to <c>/api/data/v9.2/EntityDefinitions</c>, <c>sitemaps</c>,
/// <c>appmodules</c>, <c>AddAppComponents</c>, or <c>PublishAllXml</c>.
/// </summary>
public sealed class ModelDrivenAppCreator
{
    private readonly DataverseClient _dv;
    private readonly Action<ProgressEvent> _report;

    public ModelDrivenAppCreator(DataverseClient dv, Action<ProgressEvent> report)
    {
        _dv = dv;
        _report = report;
    }

    public async Task<MdaResult> RunAsync(
        Guid jobId,
        MigrationPlan plan,
        string publisherPrefix,
        string solutionUniqueName,
        string appDisplayName,
        CancellationToken ct)
    {
        var migrate = plan.TableMappings.Where(t => string.Equals(t.Action, "Migrate", StringComparison.OrdinalIgnoreCase)).ToList();
        if (migrate.Count == 0)
            throw new InvalidOperationException("No tables marked Migrate; nothing to put in the app.");

        var prefix = new string((publisherPrefix ?? "acp").ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());
        if (string.IsNullOrEmpty(prefix)) prefix = "acp";

        var jobKey = jobId.ToString("N")[..8];
        var appUnique = $"{prefix}_mda_{jobKey}";
        var sitemapUnique = $"{prefix}_sitemap_{jobKey}";
        var appName = string.IsNullOrWhiteSpace(appDisplayName) ? $"{Capitalize(prefix)} Migration App" : appDisplayName;

        Report(5, "phase", "Resolving entity metadata ids…");
        var entities = new List<(string Logical, Guid MetadataId, string DisplayName, string PrimaryNameAttribute, TableMapping Mapping)>();
        for (int i = 0; i < migrate.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var t = migrate[i];
            var logical = (t.DataverseSchemaName ?? "").ToLowerInvariant();
            var pct = 5 + (int)(20.0 * (i + 1) / migrate.Count);
            Report(pct, "log", $"Looking up entity {logical}…", entityLogicalName: logical);
            using var doc = await _dv.GetJsonAsync(
                $"EntityDefinitions(LogicalName='{logical}')?$select=MetadataId,DisplayName,PrimaryNameAttribute",
                ct).ConfigureAwait(false);
            var root = doc.RootElement;
            var metaId = Guid.Parse(root.GetProperty("MetadataId").GetString()!);
            var displayLabel = TryGetUserLocalizedLabel(root, "DisplayName")
                ?? t.DataverseDisplayName
                ?? logical;
            var primaryName = root.TryGetProperty("PrimaryNameAttribute", out var pn) && pn.ValueKind == JsonValueKind.String
                ? pn.GetString() ?? $"{prefix}_name"
                : $"{prefix}_name";
            entities.Add((logical, metaId, displayLabel, primaryName, t));
        }

        Report(30, "phase", "Building sitemap XML…");
        var sitemapXml = BuildSitemapXml(prefix, appName, entities.Select(e => (e.Logical, e.MetadataId, e.DisplayName)));

        Report(40, "phase", "Creating sitemap record…");
        var sitemapId = await EnsureSitemapAsync(sitemapUnique, appName, sitemapXml, solutionUniqueName, ct).ConfigureAwait(false);

        Report(55, "phase", "Creating app module…");
        var appModule = await EnsureAppModuleAsync(appUnique, appName, sitemapId, solutionUniqueName, ct).ConfigureAwait(false);
        var appModuleId = appModule.AppModuleId;
        appUnique = appModule.AppUniqueName;

        Report(65, "phase", $"Linking {entities.Count} entities to the app…");
        for (int i = 0; i < entities.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var e = entities[i];
            var pct = 65 + (int)(15.0 * (i + 1) / entities.Count);
            await AddAppComponentAsync(appModuleId, componentType: 1, objectId: e.MetadataId, ct).ConfigureAwait(false);
            Report(pct, "log", $"Linked entity {e.Logical}.", entityLogicalName: e.Logical);
        }

        Report(82, "phase", "Building forms with migrated columns…");
        for (int i = 0; i < entities.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var e = entities[i];
            var pct = 82 + (int)(3.0 * (i + 1) / entities.Count);
            try
            {
                var added = await UpdateMainFormAsync(e.Logical, e.PrimaryNameAttribute, e.Mapping, solutionUniqueName, ct).ConfigureAwait(false);
                Report(pct, "log", $"Form for {e.Logical}: {added} field(s) on layout.", entityLogicalName: e.Logical);
            }
            catch (Exception ex)
            {
                // Form update is best-effort — if it fails, the entity is still
                // accessible in the app via the default (Name + Owner only) form.
                Report(pct, "log", $"Could not update form for {e.Logical}: {ex.Message}", severity: "warn", entityLogicalName: e.Logical);
            }
        }

        Report(85, "phase", "Building main views with migrated columns…");
        for (int i = 0; i < entities.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var e = entities[i];
            var pct = 85 + (int)(2.0 * (i + 1) / entities.Count);
            try
            {
                var added = await UpdateMainViewAsync(e.Logical, e.PrimaryNameAttribute, e.Mapping, solutionUniqueName, ct).ConfigureAwait(false);
                Report(pct, "log", $"View for {e.Logical}: {added} column(s) on layout.", entityLogicalName: e.Logical);
            }
            catch (Exception ex)
            {
                Report(pct, "log", $"Could not update view for {e.Logical}: {ex.Message}", severity: "warn", entityLogicalName: e.Logical);
            }
        }

        Report(88, "phase", "Linking sitemap to app…");
        await AddAppComponentAsync(appModuleId, componentType: 62, objectId: sitemapId, ct).ConfigureAwait(false);

        Report(95, "phase", "Publishing…");
        await PublishAllAsync(ct).ConfigureAwait(false);

        // The play URL on the env. Caller writes it to the job annotation.
        var envUrl = _dv.GetType().GetField("_envUrl", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)
            ?.GetValue(_dv) as string ?? "";
        var playUrl = string.IsNullOrEmpty(envUrl)
            ? $"main.aspx?appid={appModuleId}"
            : $"{envUrl.TrimEnd('/')}/main.aspx?appid={appModuleId}";

        Report(100, "done", $"App ready: {playUrl}");

        return new MdaResult
        {
            AppModuleId = appModuleId,
            AppUniqueName = appUnique,
            PlayUrl = playUrl,
        };
    }

    private void Report(int progress, string kind, string message, string? severity = null, string? entityLogicalName = null)
    {
        _report(new ProgressEvent
        {
            Kind = kind,
            Message = message,
            Progress = progress,
            Severity = severity,
            EntityLogicalName = entityLogicalName,
        });
    }

    private async Task<Guid> EnsureSitemapAsync(string uniqueName, string friendlyName, string xml, string? solutionUniqueName, CancellationToken ct)
    {
        var safe = uniqueName.Replace("'", "''");
        using var existing = await _dv.GetJsonAsync(
            $"sitemaps?$select=sitemapid&$filter=sitemapnameunique eq '{Uri.EscapeDataString(safe)}'&$top=1", ct).ConfigureAwait(false);
        var arr = existing.RootElement.GetProperty("value");
        if (arr.GetArrayLength() > 0)
        {
            var id = Guid.Parse(arr[0].GetProperty("sitemapid").GetString()!);
            var patchBody = JsonSerializer.Serialize(new { sitemapxml = xml });
            using var patchResp = await _dv.SendMetadataAsync(HttpMethod.Patch, $"sitemaps({id:D})", patchBody, solutionUniqueName, ct).ConfigureAwait(false);
            patchResp.Dispose();
            return id;
        }

        var body = JsonSerializer.Serialize(new
        {
            sitemapname = friendlyName,
            sitemapnameunique = uniqueName,
            sitemapxml = xml,
        });
        using var resp = await _dv.SendMetadataAsync(HttpMethod.Post, "sitemaps", body, solutionUniqueName, ct).ConfigureAwait(false);
        return ExtractEntityId(resp, "sitemap");
    }

    private async Task<(Guid AppModuleId, string AppUniqueName)> EnsureAppModuleAsync(string uniqueName, string friendlyName, Guid sitemapId, string? solutionUniqueName, CancellationToken ct)
    {
        var iconWebResourceId = await EnsureAppIconWebResourceAsync(uniqueName, friendlyName, solutionUniqueName, ct).ConfigureAwait(false);
        var publisherId = await GetPublisherIdForSolutionAsync(solutionUniqueName, ct).ConfigureAwait(false);

        Exception? lastCreateError = null;
        foreach (var candidate in UniqueNameCandidates(uniqueName))
        {
            var safe = candidate.Replace("'", "''");
            using var existing = await _dv.GetJsonAsync(
                $"appmodules?$select=appmoduleid&$filter=uniquename eq '{Uri.EscapeDataString(safe)}'&$top=1", ct).ConfigureAwait(false);
            var arr = existing.RootElement.GetProperty("value");
            if (arr.GetArrayLength() > 0)
                return (Guid.Parse(arr[0].GetProperty("appmoduleid").GetString()!), candidate);

            // NOTE: appmodule has no direct sitemapid navigation property — the
            // sitemap is associated via AddAppComponents (componenttype 62), which
            // the caller does after this method returns.
            var body = JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["name"] = friendlyName,
                ["uniquename"] = candidate,
                ["description"] = "Auto-generated by Access-To-Power.",
                ["formfactor"] = 1,
                ["clienttype"] = 4,
                ["appmoduleversion"] = "1.0.0.0",
                ["isdefault"] = false,
                ["isfeatured"] = false,
                ["navigationtype"] = 0,
                ["webresourceid"] = iconWebResourceId.ToString("D"),
                ["publisher_appmodule_appmodule@odata.bind"] = $"/publishers({publisherId:D})",
            });

            try
            {
                using var resp = await _dv.SendMetadataAsync(HttpMethod.Post, "appmodules", body, solutionUniqueName, ct).ConfigureAwait(false);
                return (ExtractEntityId(resp, "appmodule"), candidate);
            }
            catch (HttpRequestException ex) when (IsAppModuleUniqueNameTombstone(ex))
            {
                lastCreateError = ex;
                Report(58, "log", $"App unique name '{candidate}' is unavailable; trying another name.", severity: "warn");
            }
        }

        throw new InvalidOperationException($"Could not find an available app unique name based on '{uniqueName}'.", lastCreateError);
    }

    private static IEnumerable<string> UniqueNameCandidates(string baseName)
    {
        yield return baseName;
        for (var i = 2; i <= 25; i++)
            yield return $"{baseName}_{i}";
    }

    private static bool IsAppModuleUniqueNameTombstone(HttpRequestException ex)
        => ex.Message.Contains("0x80050135", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("-2147155681", StringComparison.OrdinalIgnoreCase);

    private async Task<Guid> GetPublisherIdForSolutionAsync(string? solutionUniqueName, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(solutionUniqueName))
            throw new InvalidOperationException("Target solution is required to resolve the app publisher.");

        var safe = solutionUniqueName.Replace("'", "''");
        using var doc = await _dv.GetJsonAsync(
            $"solutions?$select=_publisherid_value&$filter=uniquename eq '{Uri.EscapeDataString(safe)}'&$top=1", ct).ConfigureAwait(false);
        var arr = doc.RootElement.GetProperty("value");
        if (arr.GetArrayLength() == 0)
            throw new InvalidOperationException($"Target solution '{solutionUniqueName}' was not found.");

        var value = arr[0].GetProperty("_publisherid_value").GetString();
        if (!Guid.TryParse(value, out var publisherId) || publisherId == Guid.Empty)
            throw new InvalidOperationException($"Target solution '{solutionUniqueName}' does not have a publisher id.");

        return publisherId;
    }

    private async Task<Guid> EnsureAppIconWebResourceAsync(string appUniqueName, string appFriendlyName, string? solutionUniqueName, CancellationToken ct)
    {
        const string defaultIconName = "msdyn_/Images/AppModule_Default_Icon.png";
        var defaultIcon = await TryFindWebResourceByNameAsync(defaultIconName, ct).ConfigureAwait(false);
        if (defaultIcon is Guid existingDefaultIcon) return existingDefaultIcon;

        var iconName = $"{appUniqueName}_icon.svg";
        var existing = await TryFindWebResourceByNameAsync(iconName, ct).ConfigureAwait(false);
        if (existing is Guid existingIcon) return existingIcon;

        var svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect width=\"64\" height=\"64\" rx=\"12\" fill=\"#2563eb\"/><path d=\"M18 20h28v6H18zm0 10h28v6H18zm0 10h18v6H18z\" fill=\"#fff\"/></svg>";
        var content = Convert.ToBase64String(Encoding.UTF8.GetBytes(svg));
        var body = JsonSerializer.Serialize(new
        {
            name = iconName,
            displayname = $"{appFriendlyName} icon",
            description = "Auto-generated model-driven app icon.",
            webresourcetype = 11,
            content,
        });
        using var resp = await _dv.SendMetadataAsync(HttpMethod.Post, "webresourceset", body, solutionUniqueName, ct).ConfigureAwait(false);
        return ExtractEntityId(resp, "webresource");
    }

    private async Task<Guid?> TryFindWebResourceByNameAsync(string name, CancellationToken ct)
    {
        var safe = name.Replace("'", "''");
        using var existing = await _dv.GetJsonAsync(
            $"webresourceset?$select=webresourceid&$filter=name eq '{Uri.EscapeDataString(safe)}'&$top=1", ct).ConfigureAwait(false);
        var arr = existing.RootElement.GetProperty("value");
        if (arr.GetArrayLength() == 0) return null;
        return Guid.Parse(arr[0].GetProperty("webresourceid").GetString()!);
    }

    private async Task AddAppComponentAsync(Guid appModuleId, int componentType, Guid objectId, CancellationToken ct)
    {
        var component = componentType switch
        {
            1 => new Dictionary<string, object?>
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.entity",
                ["entityid"] = objectId.ToString("D"),
            },
            62 => new Dictionary<string, object?>
            {
                ["@odata.type"] = "Microsoft.Dynamics.CRM.sitemap",
                ["sitemapid"] = objectId.ToString("D"),
            },
            _ => throw new InvalidOperationException($"Unsupported app component type {componentType}.")
        };

        var body = JsonSerializer.Serialize(new
        {
            Components = new[] { component },
            AppId = appModuleId.ToString("D"),
        });
        try
        {
            using var resp = await _dv.SendMetadataAsync(HttpMethod.Post, "AddAppComponents", body, solutionUniqueName: null, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex) when (IsAlreadyExistsError(ex.Message))
        {
            // benign
        }
        catch (Exception ex) when (IsAlreadyExistsError(ex.Message))
        {
            // benign
        }
    }

    private async Task PublishAllAsync(CancellationToken ct)
    {
        using var resp = await _dv.SendMetadataAsync(HttpMethod.Post, "PublishAllXml", "{}", solutionUniqueName: null, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Locates the entity's default Main form (systemform type=2), rebuilds its
    /// formxml so the General tab includes every migrated field, and PATCHes
    /// it back. Returns the number of data fields placed on the layout.
    /// </summary>
    /// <remarks>
    /// A freshly-created custom entity ships with a Main form that contains
    /// only the primary name attribute + owner. Without this step the user
    /// opens the model-driven app and sees a record page that's missing
    /// every column they just migrated. We update the existing default form
    /// in place rather than create a new form so the entity's "default"
    /// form choice doesn't have to be flipped.
    /// </remarks>
    private async Task<int> UpdateMainFormAsync(
        string entityLogicalName,
        string primaryNameAttribute,
        TableMapping mapping,
        string? solutionUniqueName,
        CancellationToken ct)
    {
        // Find the default Main form. We pick the first system-managed Main form
        // we see — the one Dataverse generates on entity creation.
        var safeLogical = entityLogicalName.Replace("'", "''");
        using var listDoc = await _dv.GetJsonAsync(
            $"systemforms?$select=formid,name,formxml,iscustomizable&$filter=objecttypecode eq '{Uri.EscapeDataString(safeLogical)}' and type eq 2&$top=5",
            ct).ConfigureAwait(false);
        var arr = listDoc.RootElement.GetProperty("value");
        if (arr.GetArrayLength() == 0)
            throw new InvalidOperationException($"No Main form found for {entityLogicalName}.");

        var formId = Guid.Parse(arr[0].GetProperty("formid").GetString()!);

        // Build the list of attributes to drop on the form, in plan order.
        // Always lead with the primary name attribute so the record header has
        // a meaningful label. Skip lookups whose target wasn't migrated (no
        // attribute exists). Skip Uniqueidentifier — that's the primary key.
        var rows = new List<(string Logical, string Display, string ClassId, bool Required)>();

        rows.Add((primaryNameAttribute, "Name", ControlClassIdFor("String"), true));

        foreach (var f in mapping.Fields)
        {
            if (!string.Equals(f.Action, "Map", StringComparison.OrdinalIgnoreCase)) continue;
            if (string.IsNullOrWhiteSpace(f.DataverseSchemaName)) continue;
            var logical = f.DataverseSchemaName.ToLowerInvariant();
            if (string.Equals(logical, primaryNameAttribute, StringComparison.OrdinalIgnoreCase)) continue; // already added
            if (string.Equals(f.DataverseType, "Uniqueidentifier", StringComparison.OrdinalIgnoreCase)) continue;
            var classId = ControlClassIdFor(f.DataverseType);
            if (classId is null) continue; // unknown type — skip rather than corrupt the form
            var label = string.IsNullOrWhiteSpace(f.DataverseDisplayName) ? logical : f.DataverseDisplayName;
            rows.Add((logical, label, classId, f.IsRequired));
        }

        var formXml = BuildMainFormXml(rows);
        var patchBody = JsonSerializer.Serialize(new
        {
            formxml = formXml,
            formactivationstate = 1, // active
        });
        using var resp = await _dv.SendMetadataAsync(HttpMethod.Patch, $"systemforms({formId:D})", patchBody, solutionUniqueName, ct).ConfigureAwait(false);
        resp.Dispose();
        return rows.Count;
    }

    /// <summary>
    /// Minimal Main form XML: one tab "General", one section, one column per
    /// field. Dataverse fills in defaults (control bindings, classid resolution)
    /// when this is saved.
    /// </summary>
    private static string BuildMainFormXml(IReadOnlyList<(string Logical, string Display, string ClassId, bool Required)> rows)
    {
        var sb = new StringBuilder();
        sb.Append("<form>");
        sb.Append("<tabs>");
        sb.Append("<tab name=\"general_tab\" id=\"{").Append(Guid.NewGuid().ToString("D")).Append("}\" IsUserDefined=\"0\" verticallayout=\"true\" expanded=\"true\">");
        sb.Append("<labels><label description=\"General\" languagecode=\"1033\" /></labels>");
        sb.Append("<columns><column width=\"100%\">");
        sb.Append("<sections>");
        sb.Append("<section name=\"general_section\" showlabel=\"false\" showbar=\"false\" columns=\"1\" id=\"{").Append(Guid.NewGuid().ToString("D")).Append("}\" IsUserDefined=\"0\" layout=\"varwidth\">");
        sb.Append("<labels><label description=\"General\" languagecode=\"1033\" /></labels>");
        sb.Append("<rows>");
        foreach (var r in rows)
        {
            sb.Append("<row>");
            sb.Append("<cell id=\"{").Append(Guid.NewGuid().ToString("D")).Append("}\"");
            sb.Append(" rowspan=\"1\" colspan=\"1\" showlabel=\"true\">");
            sb.Append("<labels><label description=\"").Append(Esc(r.Display)).Append("\" languagecode=\"1033\" /></labels>");
            sb.Append("<control id=\"").Append(Esc(r.Logical)).Append("\" classid=\"").Append(r.ClassId).Append("\" datafieldname=\"").Append(Esc(r.Logical)).Append("\" disabled=\"false\" />");
            sb.Append("</cell>");
            sb.Append("</row>");
        }
        sb.Append("</rows>");
        sb.Append("</section>");
        sb.Append("</sections>");
        sb.Append("</column></columns>");
        sb.Append("</tab>");
        sb.Append("</tabs>");
        sb.Append("</form>");
        return sb.ToString();
    }

    /// <summary>
    /// Maps a plan's DataverseType union to the GUID-shaped classid the form
    /// XML expects. Anything not in this map is skipped so we don't corrupt
    /// the form with an unrenderable control.
    /// </summary>
    private static string? ControlClassIdFor(string dvType) => dvType switch
    {
        "String" => "{4273EDBD-AC1D-40d3-9FB2-095C621B552D}",
        "Memo" => "{E0DECE4B-6FC8-4A8F-A065-082708572369}",
        "Integer" => "{C6D124CA-7EDA-4a60-AEA9-7FB8D318B68F}",
        "BigInt" => "{f3015350-44a2-4aa0-97b5-00166532b5e9}",
        "Decimal" => "{C3EFE0C3-0EC6-42be-8349-CBD9079DFD8E}",
        "Money" => "{533B9E00-756B-4312-95A0-DC888637AC78}",
        "Double" => "{0D2C745A-E5A8-4c8f-BA63-C6D3BB604660}",
        "DateTime" => "{5B773807-9FB2-42db-97C3-7A91EFF8ADFF}",
        "DateOnly" => "{5B773807-9FB2-42db-97C3-7A91EFF8ADFF}",
        "Boolean" => "{B0C6723A-8503-4fd7-BB28-C8A06AC933C2}",
        "Lookup" => "{270BD3DB-D9AF-4782-9025-509E298DEC0A}",
        "Choice" => "{3EF39988-22BB-4f0b-BBBE-64B5A3748AEE}",
        _ => null,
    };

    /// <summary>
    /// Locates the entity's default public view (savedquery type=64) and
    /// rewrites its fetchxml + layoutxml so the migrated columns show up in
    /// the grid. Without this the user opens the model-driven app and the
    /// list page only shows Name + Created On.
    /// </summary>
    private async Task<int> UpdateMainViewAsync(
        string entityLogicalName,
        string primaryNameAttribute,
        TableMapping mapping,
        string? solutionUniqueName,
        CancellationToken ct)
    {
        var safeLogical = entityLogicalName.Replace("'", "''");
        // querytype=64 is the "Public View" used as the default for the entity
        // in model-driven apps. There can be several; we pick the one already
        // flagged as default. Falling back to the first if none is marked.
        using var listDoc = await _dv.GetJsonAsync(
            $"savedqueries?$select=savedqueryid,name,isdefault,layoutxml,fetchxml&$filter=returnedtypecode eq '{Uri.EscapeDataString(safeLogical)}' and querytype eq 64&$top=10",
            ct).ConfigureAwait(false);
        var arr = listDoc.RootElement.GetProperty("value");
        if (arr.GetArrayLength() == 0)
            throw new InvalidOperationException($"No public view (querytype=64) found for {entityLogicalName}.");

        // Pick the default one if present, else first.
        var pick = arr[0];
        for (int i = 0; i < arr.GetArrayLength(); i++)
        {
            var el = arr[i];
            if (el.TryGetProperty("isdefault", out var d) && d.ValueKind == JsonValueKind.True)
            {
                pick = el;
                break;
            }
        }
        var viewId = Guid.Parse(pick.GetProperty("savedqueryid").GetString()!);

        // Build the column list. Lead with the primary name (always linkable),
        // then mapped fields in plan order. Skip Memo (renders poorly in grids),
        // Uniqueidentifier (the PK), and anything with an unknown type.
        var cols = new List<(string Logical, int Width)>();
        cols.Add((primaryNameAttribute, 200));

        foreach (var f in mapping.Fields)
        {
            if (!string.Equals(f.Action, "Map", StringComparison.OrdinalIgnoreCase)) continue;
            if (string.IsNullOrWhiteSpace(f.DataverseSchemaName)) continue;
            var logical = f.DataverseSchemaName.ToLowerInvariant();
            if (string.Equals(logical, primaryNameAttribute, StringComparison.OrdinalIgnoreCase)) continue;
            if (string.Equals(f.DataverseType, "Uniqueidentifier", StringComparison.OrdinalIgnoreCase)) continue;
            if (string.Equals(f.DataverseType, "Memo", StringComparison.OrdinalIgnoreCase)) continue; // too wide for grid
            if (ControlClassIdFor(f.DataverseType) is null) continue;
            cols.Add((logical, ColumnWidthFor(f.DataverseType)));
            if (cols.Count >= 10) break; // 10 cols is plenty for a default grid
        }

        var layoutXml = BuildMainViewLayoutXml(entityLogicalName, primaryNameAttribute, cols);
        var fetchXml = BuildMainViewFetchXml(entityLogicalName, primaryNameAttribute, cols);

        var patchBody = JsonSerializer.Serialize(new
        {
            layoutxml = layoutXml,
            fetchxml = fetchXml,
        });
        using var resp = await _dv.SendMetadataAsync(HttpMethod.Patch, $"savedqueries({viewId:D})", patchBody, solutionUniqueName, ct).ConfigureAwait(false);
        resp.Dispose();
        return cols.Count;
    }

    private static string BuildMainViewLayoutXml(string entityLogical, string primaryName, IReadOnlyList<(string Logical, int Width)> cols)
    {
        var sb = new StringBuilder();
        sb.Append("<grid name=\"resultset\" object=\"1\" jump=\"").Append(Esc(primaryName)).Append("\" select=\"1\" preview=\"1\" icon=\"1\">");
        sb.Append("<row name=\"result\" id=\"").Append(Esc(entityLogical)).Append("id\">");
        foreach (var c in cols)
        {
            sb.Append("<cell name=\"").Append(Esc(c.Logical)).Append("\" width=\"").Append(c.Width).Append("\" />");
        }
        sb.Append("</row>");
        sb.Append("</grid>");
        return sb.ToString();
    }

    private static string BuildMainViewFetchXml(string entityLogical, string primaryName, IReadOnlyList<(string Logical, int Width)> cols)
    {
        var sb = new StringBuilder();
        sb.Append("<fetch version=\"1.0\" output-format=\"xml-platform\" mapping=\"logical\" distinct=\"false\" no-lock=\"false\">");
        sb.Append("<entity name=\"").Append(Esc(entityLogical)).Append("\">");
        foreach (var c in cols)
        {
            sb.Append("<attribute name=\"").Append(Esc(c.Logical)).Append("\" />");
        }
        // Always order by the primary name so the grid has a deterministic sort.
        sb.Append("<order attribute=\"").Append(Esc(primaryName)).Append("\" descending=\"false\" />");
        sb.Append("</entity>");
        sb.Append("</fetch>");
        return sb.ToString();
    }

    private static int ColumnWidthFor(string dvType) => dvType switch
    {
        "Boolean" => 100,
        "Integer" => 110,
        "BigInt" => 130,
        "Decimal" => 130,
        "Double" => 130,
        "Money" => 130,
        "DateTime" => 150,
        "DateOnly" => 130,
        "Choice" => 150,
        "Lookup" => 200,
        _ => 175,
    };

    private static bool IsAlreadyExistsError(string message)
        => message.Contains("already part of", StringComparison.OrdinalIgnoreCase)
        || message.Contains("already exist", StringComparison.OrdinalIgnoreCase);

    private static Guid ExtractEntityId(HttpResponseMessage resp, string label)
    {
        if (resp.Headers.TryGetValues("OData-EntityId", out var values))
        {
            var header = values.FirstOrDefault() ?? "";
            var match = System.Text.RegularExpressions.Regex.Match(header, @"\(([0-9a-fA-F-]{36})\)");
            if (match.Success && Guid.TryParse(match.Groups[1].Value, out var id)) return id;
        }
        throw new InvalidOperationException($"Created {label} but no OData-EntityId header.");
    }

    private static string? TryGetUserLocalizedLabel(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out var label)) return null;
        if (label.ValueKind != JsonValueKind.Object) return null;
        if (label.TryGetProperty("UserLocalizedLabel", out var ull)
            && ull.ValueKind == JsonValueKind.Object
            && ull.TryGetProperty("Label", out var lbl)
            && lbl.ValueKind == JsonValueKind.String)
        {
            return lbl.GetString();
        }
        if (label.TryGetProperty("LocalizedLabels", out var arr) && arr.ValueKind == JsonValueKind.Array && arr.GetArrayLength() > 0)
        {
            var first = arr[0];
            if (first.TryGetProperty("Label", out var l) && l.ValueKind == JsonValueKind.String)
                return l.GetString();
        }
        return null;
    }

    private static string BuildSitemapXml(string prefix, string areaTitle, IEnumerable<(string Logical, Guid MetadataId, string DisplayName)> entities)
    {
        var sb = new StringBuilder();
        sb.Append("<SiteMap>\n");
        sb.Append($"  <Area Id=\"{prefix}_area\" Title=\"{Esc(areaTitle)}\" ShowGroups=\"true\">\n");
        sb.Append($"    <Group Id=\"{prefix}_group\" Title=\"Migrated tables\">\n");
        foreach (var e in entities)
        {
            sb.Append($"      <SubArea Id=\"{prefix}_sub_{Sanitize(e.Logical)}\" Entity=\"{Esc(e.Logical)}\" Title=\"{Esc(e.DisplayName)}\" />\n");
        }
        sb.Append("    </Group>\n");
        sb.Append("  </Area>\n");
        sb.Append("</SiteMap>");
        return sb.ToString();
    }

    private static string Sanitize(string s)
    {
        var clean = new string(s.Select(c => char.IsLetterOrDigit(c) || c == '_' ? c : '_').ToArray());
        return clean.Length <= 32 ? clean : clean[..32];
    }

    private static string Esc(string s) => s
        .Replace("&", "&amp;")
        .Replace("<", "&lt;")
        .Replace(">", "&gt;")
        .Replace("\"", "&quot;")
        .Replace("'", "&apos;");

    private static string Capitalize(string s) => string.IsNullOrEmpty(s) ? s : char.ToUpperInvariant(s[0]) + s[1..];
}

public sealed class MdaResult
{
    public Guid AppModuleId { get; set; }
    public string AppUniqueName { get; set; } = "";
    public string PlayUrl { get; set; } = "";
}
