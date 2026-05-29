using System.Data;
using System.Data.OleDb;
using System.IO;
using AccessToPower.Helper.Models;

namespace AccessToPower.Helper.Services;

/// <summary>
/// Read-only ACE OLEDB reader. Opens the .accdb via ACE provider (no Access
/// app, no macro/VBA execution) and emits schema + a streaming row iterator.
/// </summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public sealed class AccessReader : IDisposable
{
    private readonly OleDbConnection _conn;
    private readonly string _path;
    private bool _disposed;

    public AccessReader(string accdbPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(accdbPath);
        if (!File.Exists(accdbPath))
            throw new FileNotFoundException("Access database not found.", accdbPath);

        _path = Path.GetFullPath(accdbPath);

        // Mode=Read forces read-only at the OLEDB layer.
        var connStr =
            $"Provider=Microsoft.ACE.OLEDB.16.0;Data Source={_path};Mode=Read;Persist Security Info=False;";
        _conn = new OleDbConnection(connStr);
        try
        {
            _conn.Open();
        }
        catch (OleDbException ex)
        {
            // 0x80004005 with "Not a valid password" or "could not decrypt"
            // surfaces here. Give a clean error rather than a raw OLEDB stack.
            var msg = ex.Message ?? "";
            if (msg.Contains("password", StringComparison.OrdinalIgnoreCase)
                || msg.Contains("decrypt", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    $"The Access database '{Path.GetFileName(_path)}' is password-protected. " +
                    "Remove or supply the password before migration (Access → File → Info → Decrypt Database).", ex);
            }
            throw new InvalidOperationException(
                "Could not open the Access database. Confirm the 64-bit Microsoft Access Database Engine is installed " +
                "and the file is not currently open in Microsoft Access.", ex);
        }
    }

    /// <summary>
    /// Returns user table names (excludes system tables MSys*, link tables, queries).
    /// </summary>
    public IReadOnlyList<string> GetUserTableNames()
    {
        var dt = _conn.GetSchema("Tables", new[] { null, null, null, "TABLE" });
        var names = new List<string>();
        foreach (DataRow row in dt.Rows)
        {
            var name = (string)row["TABLE_NAME"];
            if (name.StartsWith("MSys", StringComparison.OrdinalIgnoreCase)) continue;
            if (name.StartsWith("~", StringComparison.Ordinal)) continue;
            names.Add(name);
        }
        names.Sort(StringComparer.OrdinalIgnoreCase);
        return names;
    }

    /// <summary>
    /// Returns linked table names so the scan phase can warn the user. Linked
    /// tables point at external data (ODBC, SharePoint, another Access file)
    /// — their schema is visible but their rows live elsewhere and should not
    /// be migrated as if they were native tables.
    /// </summary>
    public IReadOnlyList<string> GetLinkedTableNames()
    {
        var names = new List<string>();
        foreach (var type in new[] { "LINK", "PASS-THROUGH" })
        {
            var dt = _conn.GetSchema("Tables", new[] { null, null, null, type });
            foreach (DataRow row in dt.Rows)
            {
                var name = (string)row["TABLE_NAME"];
                if (name.StartsWith("MSys", StringComparison.OrdinalIgnoreCase)) continue;
                names.Add(name);
            }
        }
        names.Sort(StringComparer.OrdinalIgnoreCase);
        return names;
    }

    /// <summary>
    /// Reads schema metadata for one table. Does not read rows.
    /// </summary>
    public AccessTable ReadTableSchema(string tableName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(tableName);

        var table = new AccessTable { Name = tableName };
        var quoted = QuoteIdentifier(tableName);

        // Row count
        using (var cmd = new OleDbCommand($"SELECT COUNT(*) FROM {quoted}", _conn))
        {
            table.RowCount = Convert.ToInt64(cmd.ExecuteScalar() ?? 0L, System.Globalization.CultureInfo.InvariantCulture);
        }

        // Columns via schema rowset
        var colsDt = _conn.GetSchema("Columns", new[] { null, null, tableName, null });
        var pkCols = ReadPrimaryKeyColumns(tableName);
        var ordered = colsDt.AsEnumerable()
            .OrderBy(r => Convert.ToInt32(r["ORDINAL_POSITION"], System.Globalization.CultureInfo.InvariantCulture));

        foreach (var row in ordered)
        {
            var col = new AccessColumn
            {
                Name = (string)row["COLUMN_NAME"],
                IsRequired = !(row["IS_NULLABLE"] is bool b ? b : true),
                MaxLength = row["CHARACTER_MAXIMUM_LENGTH"] is int len ? len : null,
                Precision = row["NUMERIC_PRECISION"] is short p ? p : (row["NUMERIC_PRECISION"] is int pi ? pi : null),
                Scale = row["NUMERIC_SCALE"] is short s ? s : (row["NUMERIC_SCALE"] is int si ? si : null),
                DefaultValue = row["COLUMN_DEFAULT"] as string,
                Description = row["DESCRIPTION"] as string,
            };

            var oleType = (OleDbType)Convert.ToInt32(row["DATA_TYPE"], System.Globalization.CultureInfo.InvariantCulture);
            col.DataType = MapOleDbType(oleType, col.MaxLength);
            col.IsPrimaryKey = pkCols.Contains(col.Name, StringComparer.OrdinalIgnoreCase);
            // COLUMN_FLAGS bit 0x60 (96) typically indicates AutoNumber in Jet/ACE.
            if (row["COLUMN_FLAGS"] is long flags && (flags & 0x60) == 0x60)
                col.IsAutoNumber = true;

            // Unsupported types -> issue + still emit so user can see them
            if (col.DataType is "OleObject" or "Binary" or "Attachment")
            {
                col.Issues ??= new();
                col.Issues.Add(new ManifestIssue
                {
                    Severity = "Warning",
                    Category = "UnsupportedType",
                    Message = $"Column '{col.Name}' is of type {col.DataType}; data will not migrate. Schema-only.",
                    Table = tableName,
                    Column = col.Name,
                });
            }
            else if (col.DataType == "Unknown")
            {
                // Most common cause: Access Multi-Valued Lookup (MVL) or
                // Lookup Wizard column. ACE OLEDB surfaces these as a chapter
                // rowset that the streaming reader can't materialize as a
                // scalar. Full Choice conversion requires DAO (guide Part 7);
                // for now we surface the column so the customer knows manual
                // remediation may be needed post-migration.
                col.Issues ??= new();
                col.Issues.Add(new ManifestIssue
                {
                    Severity = "Warning",
                    Category = "UnsupportedType",
                    Message =
                        $"Column '{col.Name}' has an unrecognized type — typically an Access " +
                        "Multi-Valued Lookup or Lookup Wizard column. Data will not migrate; " +
                        "consider converting to a Dataverse Choice column manually post-migration.",
                    Table = tableName,
                    Column = col.Name,
                });
            }

            table.Columns.Add(col);
        }

        if (pkCols.Count == 0)
        {
            table.Issues ??= new();
            table.Issues.Add(new ManifestIssue
            {
                Severity = "Warning",
                Category = "MissingPrimaryKey",
                Message = $"Table '{tableName}' has no primary key. A surrogate key will be generated in Dataverse.",
                Table = tableName,
            });
        }

        table.Indexes = ReadIndexes(tableName);

        return table;
    }

    /// <summary>
    /// Reads non-PK indexes via the OleDb Indexes schema rowset. Composite
    /// indexes appear as multiple rows with shared INDEX_NAME and ascending
    /// ORDINAL_POSITION. PK indexes are skipped because they're already
    /// reflected on individual columns via <c>IsPrimaryKey</c>.
    /// </summary>
    private List<AccessIndex> ReadIndexes(string tableName)
    {
        var result = new List<AccessIndex>();
        var dt = _conn.GetOleDbSchemaTable(OleDbSchemaGuid.Indexes, new object?[] { null, null, null, null, tableName });
        if (dt is null) return result;

        var byName = new Dictionary<string, (AccessIndex idx, List<(int Ord, string Col)> Parts)>(StringComparer.OrdinalIgnoreCase);
        foreach (DataRow row in dt.Rows)
        {
            var name = row["INDEX_NAME"] as string;
            if (string.IsNullOrEmpty(name)) continue;
            var isPk = row["PRIMARY_KEY"] is bool pk && pk;
            if (isPk) continue;

            if (!byName.TryGetValue(name, out var entry))
            {
                entry = (new AccessIndex
                {
                    Name = name,
                    Unique = row["UNIQUE"] is bool u && u,
                }, new List<(int, string)>());
                byName[name] = entry;
            }
            var ord = row["ORDINAL_POSITION"] switch
            {
                short s => (int)s,
                int i => i,
                long l => (int)l,
                _ => 0,
            };
            var col = row["COLUMN_NAME"] as string ?? "";
            entry.Parts.Add((ord, col));
        }

        foreach (var (_, parts) in byName.Values.OrderBy(v => v.idx.Name, StringComparer.OrdinalIgnoreCase))
        {
            parts.Sort((a, b) => a.Ord.CompareTo(b.Ord));
        }
        foreach (var (idx, parts) in byName.Values)
        {
            idx.Columns.AddRange(parts.Select(p => p.Col));
            result.Add(idx);
        }
        return result;
    }

    /// <summary>
    /// Reads the first <paramref name="sampleSize"/> non-null values of a
    /// single column. Used by scan-time heuristics for date-only and float
    /// precision detection (guide Part 2). Does not load the full table.
    /// </summary>
    public List<object> SampleColumnValues(string tableName, string columnName, int sampleSize = 200)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(tableName);
        ArgumentException.ThrowIfNullOrWhiteSpace(columnName);
        if (sampleSize <= 0) return new();

        var quotedT = QuoteIdentifier(tableName);
        var quotedC = QuoteIdentifier(columnName);
        var sql = $"SELECT TOP {sampleSize} {quotedC} FROM {quotedT} WHERE {quotedC} IS NOT NULL";
        var values = new List<object>(sampleSize);

        using var cmd = new OleDbCommand(sql, _conn);
        cmd.CommandTimeout = 0;
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            if (reader.IsDBNull(0)) continue;
            values.Add(reader.GetValue(0));
            if (values.Count >= sampleSize) break;
        }
        return values;
    }

    /// <summary>
    /// Inspects sampled values for each column and decorates the column with
    /// scan-time hints used downstream by the plan builder + SchemaCreator:
    ///  - <see cref="AccessColumn.DetectedDateOnly"/> for DateTime columns
    ///    whose sampled values are all at midnight UTC.
    ///  - <see cref="AccessColumn.DetectedMaxDecimals"/> for Single/Double/
    ///    Decimal columns — counts trailing decimal digits so the plan can
    ///    promote a Single/Double to Decimal when precision exceeds 5 digits.
    /// Emits a corresponding <see cref="ManifestIssue"/> per detection so the
    /// MapStep UI can surface the decision.
    /// </summary>
    public void EnrichColumnsFromSamples(AccessTable table, int sampleSize = 200)
    {
        ArgumentNullException.ThrowIfNull(table);
        foreach (var col in table.Columns)
        {
            try
            {
                if (col.DataType == "DateTime")
                {
                    var samples = SampleColumnValues(table.Name, col.Name, sampleSize);
                    if (samples.Count == 0) continue;
                    var allMidnight = true;
                    foreach (var v in samples)
                    {
                        if (v is DateTime dt && dt.TimeOfDay == TimeSpan.Zero) continue;
                        allMidnight = false;
                        break;
                    }
                    if (allMidnight)
                    {
                        col.DetectedDateOnly = true;
                        col.Issues ??= new();
                        col.Issues.Add(new ManifestIssue
                        {
                            Severity = "Info",
                            Category = "DateOnly",
                            Message = $"Column '{col.Name}' on '{table.Name}' contains only midnight values; will be created as a Dataverse Date Only column.",
                            Table = table.Name,
                            Column = col.Name,
                        });
                    }
                }
                else if (col.DataType is "Single" or "Double" or "Decimal" or "Currency")
                {
                    var samples = SampleColumnValues(table.Name, col.Name, sampleSize);
                    if (samples.Count == 0) continue;
                    var maxDecimals = 0;
                    foreach (var v in samples)
                    {
                        var d = TryToDecimal(v);
                        if (d is null) continue;
                        var n = CountDecimalDigits(d.Value);
                        if (n > maxDecimals) maxDecimals = n;
                    }
                    col.DetectedMaxDecimals = maxDecimals;
                    if ((col.DataType == "Single" || col.DataType == "Double") && maxDecimals > 5)
                    {
                        col.Issues ??= new();
                        col.Issues.Add(new ManifestIssue
                        {
                            Severity = "Warning",
                            Category = "FloatPrecisionLoss",
                            Message =
                                $"Column '{col.Name}' on '{table.Name}' has up to {maxDecimals} decimal digits; Dataverse Float caps at 5. " +
                                $"Will be promoted to a Decimal column (precision {Math.Min(maxDecimals, 10)}).",
                            Table = table.Name,
                            Column = col.Name,
                        });
                    }
                }
                else if (col.DataType is "Binary" or "OleObject")
                {
                    // Sample a few rows of bytes to figure out whether the
                    // column holds images (→ default to Dataverse Image),
                    // PDFs/docs (→ default to Dataverse File), or arbitrary
                    // bytes (→ Dataverse File). We also detect Access OLE
                    // Package wrappers so the data loader can strip them
                    // before upload.
                    col.BinaryHint = DetectBinary(table.Name, col.Name, sampleSize: 5);
                    if (col.BinaryHint is not null)
                    {
                        col.UnsupportedReason = col.DataType;
                        col.Issues ??= new();
                        col.Issues.Add(new ManifestIssue
                        {
                            Severity = "Info",
                            Category = "UnsupportedType",
                            Message =
                                $"Column '{col.Name}' on '{table.Name}' holds {col.BinaryHint.DetectedKind} data " +
                                (col.BinaryHint.SampleMime is { } m ? $"({m}) " : "") +
                                $"— will be migrated to a Dataverse " +
                                $"{(col.BinaryHint.DetectedKind == "image" ? "Image" : "File")} column.",
                            Table = table.Name,
                            Column = col.Name,
                        });
                    }
                }
            }
            catch (OleDbException ex)
            {
                // Sampling is best-effort. Some columns (computed, attachment)
                // can't be SELECTed via OLEDB — skip and move on.
                col.Issues ??= new();
                col.Issues.Add(new ManifestIssue
                {
                    Severity = "Info",
                    Category = "SamplingSkipped",
                    Message = $"Could not sample '{col.Name}' on '{table.Name}': {ex.Message}",
                    Table = table.Name,
                    Column = col.Name,
                });
            }
        }
    }

    private static decimal? TryToDecimal(object v)
    {
        try
        {
            return v switch
            {
                decimal d => d,
                double d2 => (decimal)d2,
                float f => (decimal)f,
                long l => l,
                int i => i,
                short s => s,
                byte b => b,
                _ => null,
            };
        }
        catch (OverflowException) { return null; }
    }

    private static int CountDecimalDigits(decimal d)
    {
        // Decimal stores its scale in the high word of bits[3]. Trailing
        // zeros are preserved (e.g. 1.50m has scale 2) so a raw scale
        // overstates the precision. Re-normalize by trimming trailing zeros.
        var str = d.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var dot = str.IndexOf('.');
        if (dot < 0) return 0;
        var frac = str.AsSpan(dot + 1).TrimEnd('0');
        return frac.Length;
    }

    /// <summary>
    /// Samples a binary column (Binary or OleObject) and produces a
    /// BinaryHint describing the most likely content (image / pdf / document
    /// / binary) plus whether the bytes appear wrapped in an Access OLE
    /// Package envelope. Returns null when sampling fails outright.
    /// </summary>
    private BinaryHint? DetectBinary(string tableName, string columnName, int sampleSize)
    {
        var quotedT = QuoteIdentifier(tableName);
        var quotedC = QuoteIdentifier(columnName);
        var sql = $"SELECT TOP {sampleSize} {quotedC} FROM {quotedT} WHERE {quotedC} IS NOT NULL";

        long maxBytes = 0;
        int sampled = 0;
        string? bestMime = null;
        string bestKind = "binary";
        bool sawWrapper = false;
        var kindsSeen = new HashSet<string>(StringComparer.Ordinal);

        try
        {
            using var cmd = new OleDbCommand(sql, _conn);
            cmd.CommandTimeout = 0;
            using var reader = cmd.ExecuteReader(CommandBehavior.SequentialAccess);
            var buffer = new byte[8192];

            while (reader.Read())
            {
                if (reader.IsDBNull(0)) continue;
                // Read up to first 4 KB; that's plenty for magic-byte sniffing.
                long total;
                byte[] head;
                try
                {
                    var len = reader.GetBytes(0, 0L, buffer, 0, buffer.Length);
                    head = new byte[len];
                    Array.Copy(buffer, head, len);
                    // Find true total size — many providers report length when
                    // we ask for offset > available, but cheaper to just keep
                    // a min using head length here.
                    total = len;
                }
                catch (InvalidCastException)
                {
                    // OleObject (IDispatch) columns sometimes refuse GetBytes;
                    // fall back to GetValue and hope it materializes.
                    var v = reader.GetValue(0);
                    if (v is byte[] raw)
                    {
                        head = raw.Length > 4096 ? raw[..4096] : raw;
                        total = raw.Length;
                    }
                    else
                    {
                        continue;
                    }
                }
                catch (OleDbException)
                {
                    continue;
                }
                catch (System.Runtime.InteropServices.COMException)
                {
                    continue;
                }

                sampled++;
                if (total > maxBytes) maxBytes = total;
                var (kind, mime, wrapper) = BinarySniffer.Sniff(head);
                if (wrapper) sawWrapper = true;
                kindsSeen.Add(kind);
                // Prefer the most specific detection across samples
                // (image > pdf > document > binary).
                if (Rank(kind) > Rank(bestKind))
                {
                    bestKind = kind;
                    bestMime = mime;
                }
            }
        }
        catch (OleDbException)
        {
            return null;
        }

        if (sampled == 0) return null;

        // Mixed content guardrail: Dataverse Image columns validate every
        // uploaded blob and reject non-images outright. If the sample
        // included an image AND anything else (PDF, document, unidentified
        // bytes), downgrade to "binary" so the planner routes the column
        // to File (which accepts any bytes) rather than Image.
        if (bestKind == "image" && kindsSeen.Count > 1)
        {
            bestKind = "binary";
            bestMime = null;
        }

        return new BinaryHint
        {
            DetectedKind = bestKind,
            SampleMime = bestMime,
            HasOleWrapper = sawWrapper,
            MaxBytes = maxBytes,
            SampleSize = sampled,
        };

        static int Rank(string k) => k switch
        {
            "image" => 3,
            "pdf" => 2,
            "document" => 1,
            _ => 0,
        };
    }

    /// <summary>
    /// Reads a single binary cell by primary-key lookup. Used by DataLoader
    /// during the per-row binary upload pass. Returns null when the row
    /// matches no record, the cell is null, or the column can't be read via
    /// OLE DB (e.g., Attachment chapter rowset — DAO is needed for those).
    /// </summary>
    public byte[]? ReadBinaryCell(string tableName, string keyColumn, object keyValue, string binaryColumn)
    {
        var quotedT = QuoteIdentifier(tableName);
        var quotedK = QuoteIdentifier(keyColumn);
        var quotedB = QuoteIdentifier(binaryColumn);
        // Parameter binding through OleDb honours `?` placeholders in order.
        using var cmd = new OleDbCommand(
            $"SELECT {quotedB} FROM {quotedT} WHERE {quotedK} = ?", _conn);
        cmd.CommandTimeout = 0;
        // ACE OLEDB is strict about parameter type matching. AddWithValue on
        // a CLR `long` infers BigInt, which fails to bind to an Access Long
        // Integer (Int32) column with "could not be converted for reasons
        // other than sign mismatch or data overflow". Build the parameter
        // explicitly from the value's CLR type and downcast Int64 → Int32
        // when it fits (Access has no 64-bit PK type).
        AddTypedKeyParameter(cmd, keyValue);
        try
        {
            using var reader = cmd.ExecuteReader(CommandBehavior.SequentialAccess);
            if (!reader.Read() || reader.IsDBNull(0)) return null;
            try
            {
                // Stream into a MemoryStream — bytes can be large (multi-MB).
                using var ms = new MemoryStream();
                var buffer = new byte[64 * 1024];
                long offset = 0;
                while (true)
                {
                    var n = reader.GetBytes(0, offset, buffer, 0, buffer.Length);
                    if (n <= 0) break;
                    ms.Write(buffer, 0, (int)n);
                    if (n < buffer.Length) break;
                    offset += n;
                }
                return ms.Length == 0 ? null : ms.ToArray();
            }
            catch (InvalidCastException)
            {
                var v = reader.GetValue(0);
                return v as byte[];
            }
        }
        catch (OleDbException)
        {
            return null;
        }
        catch (System.Runtime.InteropServices.COMException)
        {
            return null;
        }
    }

    /// <summary>
    /// Streams rows for a table as a sequence of column-name → value dictionaries.
    /// Unsupported binary/OLE columns are skipped (null in output).
    /// </summary>
    public IEnumerable<Dictionary<string, object?>> StreamRows(AccessTable table)
    {
        ArgumentNullException.ThrowIfNull(table);
        var quoted = QuoteIdentifier(table.Name);
        var skipCols = new HashSet<string>(
            table.Columns.Where(c => c.DataType is "OleObject" or "Binary" or "Attachment" or "Multivalue").Select(c => c.Name),
            StringComparer.OrdinalIgnoreCase);

        using var cmd = new OleDbCommand($"SELECT * FROM {quoted}", _conn);
        cmd.CommandTimeout = 0;
        using var reader = cmd.ExecuteReader(CommandBehavior.SequentialAccess);

        var fieldCount = reader.FieldCount;
        var names = new string[fieldCount];
        for (var i = 0; i < fieldCount; i++) names[i] = reader.GetName(i);

        while (reader.Read())
        {
            var dict = new Dictionary<string, object?>(fieldCount, StringComparer.Ordinal);
            for (var i = 0; i < fieldCount; i++)
            {
                var name = names[i];
                if (skipCols.Contains(name))
                {
                    dict[name] = null;
                    continue;
                }
                if (reader.IsDBNull(i))
                {
                    dict[name] = null;
                    continue;
                }
                var val = reader.GetValue(i);
                dict[name] = val switch
                {
                    DateTime dt => dt.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture),
                    byte[] => null, // safety: never emit binary
                    _ => val,
                };
            }
            yield return dict;
        }
    }

    /// <summary>
    /// Reads relationships using the OleDbSchemaGuid.Foreign_Keys schema.
    /// </summary>
    public IReadOnlyList<AccessRelationship> ReadRelationships()
    {
        var dt = _conn.GetOleDbSchemaTable(OleDbSchemaGuid.Foreign_Keys, null);
        if (dt is null) return Array.Empty<AccessRelationship>();

        var byName = new Dictionary<string, AccessRelationship>(StringComparer.OrdinalIgnoreCase);
        foreach (DataRow row in dt.Rows)
        {
            var name = (string)row["FK_NAME"];
            if (!byName.TryGetValue(name, out var rel))
            {
                rel = new AccessRelationship
                {
                    Name = name,
                    ParentTable = (string)row["PK_TABLE_NAME"],
                    ChildTable = (string)row["FK_TABLE_NAME"],
                    EnforceReferentialIntegrity = true, // ACE only reports enforced FKs here
                    CascadeUpdate = string.Equals(row["UPDATE_RULE"] as string, "CASCADE", StringComparison.OrdinalIgnoreCase),
                    CascadeDelete = string.Equals(row["DELETE_RULE"] as string, "CASCADE", StringComparison.OrdinalIgnoreCase),
                };
                byName[name] = rel;
            }
            rel.ParentColumns.Add((string)row["PK_COLUMN_NAME"]);
            rel.ChildColumns.Add((string)row["FK_COLUMN_NAME"]);
        }
        return byName.Values.ToList();
    }

    private List<string> ReadPrimaryKeyColumns(string tableName)
    {
        var pks = new List<string>();
        var dt = _conn.GetOleDbSchemaTable(OleDbSchemaGuid.Primary_Keys, new object?[] { null, null, tableName });
        if (dt is null) return pks;
        foreach (DataRow row in dt.Rows)
        {
            pks.Add((string)row["COLUMN_NAME"]);
        }
        return pks;
    }

    private static string QuoteIdentifier(string name)
    {
        // ACE allows [bracketed] identifiers. Reject any embedded brackets defensively.
        if (name.Contains('[') || name.Contains(']'))
            throw new ArgumentException("Table or column name contains illegal characters.", nameof(name));
        return $"[{name}]";
    }

    private static void AddTypedKeyParameter(OleDbCommand cmd, object keyValue)
    {
        OleDbParameter p;
        switch (keyValue)
        {
            case null:
                p = new OleDbParameter("@k", OleDbType.Variant) { Value = DBNull.Value };
                break;
            case Guid g:
                p = new OleDbParameter("@k", OleDbType.Guid) { Value = g };
                break;
            case bool b:
                p = new OleDbParameter("@k", OleDbType.Boolean) { Value = b };
                break;
            case byte by:
                p = new OleDbParameter("@k", OleDbType.UnsignedTinyInt) { Value = by };
                break;
            case short s:
                p = new OleDbParameter("@k", OleDbType.SmallInt) { Value = s };
                break;
            case int i:
                p = new OleDbParameter("@k", OleDbType.Integer) { Value = i };
                break;
            case long l:
                // Access has no 64-bit PK type. Downcast to Int32 when it fits
                // (the common case for AutoNumber PKs).
                p = (l >= int.MinValue && l <= int.MaxValue)
                    ? new OleDbParameter("@k", OleDbType.Integer) { Value = (int)l }
                    : new OleDbParameter("@k", OleDbType.BigInt) { Value = l };
                break;
            case double d:
                p = new OleDbParameter("@k", OleDbType.Double) { Value = d };
                break;
            case float f:
                p = new OleDbParameter("@k", OleDbType.Single) { Value = f };
                break;
            case decimal m:
                p = new OleDbParameter("@k", OleDbType.Decimal) { Value = m };
                break;
            case DateTime dt:
                p = new OleDbParameter("@k", OleDbType.Date) { Value = dt };
                break;
            case string str:
                p = new OleDbParameter("@k", OleDbType.VarWChar, Math.Max(str.Length, 1)) { Value = str };
                break;
            default:
                p = new OleDbParameter("@k", OleDbType.VarWChar)
                {
                    Value = Convert.ToString(keyValue, System.Globalization.CultureInfo.InvariantCulture) ?? (object)DBNull.Value
                };
                break;
        }
        cmd.Parameters.Add(p);
    }

    private static string MapOleDbType(OleDbType t, int? maxLen) => t switch
    {
        // Access TEXT and MEMO both surface as (Var)WChar in ACE schema
        // rowsets. The discriminator is CHARACTER_MAXIMUM_LENGTH:
        //   • 1..255  → real Short Text (TEXT(n))
        //   • 0 / null → Long Text (MEMO), unlimited length
        // (LongVar*Char comes back from some non-ACE providers; honour it
        // too.) DaoEnricher overrides via dbMemo when DAO is available.
        OleDbType.WChar or OleDbType.VarWChar or OleDbType.Char or OleDbType.VarChar
            => (maxLen is null or 0) ? "Memo" : "Text",
        OleDbType.LongVarWChar or OleDbType.LongVarChar => "Memo",
        OleDbType.UnsignedTinyInt => "Byte",
        OleDbType.SmallInt or OleDbType.UnsignedSmallInt => "Integer",
        OleDbType.Integer or OleDbType.UnsignedInt => "Long",
        OleDbType.BigInt or OleDbType.UnsignedBigInt => "Long",
        OleDbType.Single => "Single",
        OleDbType.Double => "Double",
        OleDbType.Currency => "Currency",
        OleDbType.Decimal or OleDbType.Numeric or OleDbType.VarNumeric => "Decimal",
        OleDbType.Date or OleDbType.DBDate or OleDbType.DBTime or OleDbType.DBTimeStamp => "DateTime",
        OleDbType.Boolean => "Boolean",
        OleDbType.Guid => "Guid",
        OleDbType.Binary or OleDbType.VarBinary or OleDbType.LongVarBinary => "Binary",
        OleDbType.IDispatch or OleDbType.IUnknown => "OleObject",
        _ => "Unknown",
    };

    public void Dispose()
    {
        if (_disposed) return;
        _conn.Dispose();
        _disposed = true;
        GC.SuppressFinalize(this);
    }
}

/// <summary>
/// Magic-byte sniffer for binary blob bytes read out of Access columns.
/// Recognises common image / PDF formats and the legacy Access OLE Package
/// wrapper. Used both at scan time (to default Binary→File vs Binary→Image)
/// and at migrate time (to strip wrappers before uploading bytes to
/// Dataverse File / Image columns).
/// </summary>
public static class BinarySniffer
{
    /// <summary>
    /// Returns the detected <c>kind</c> ("image"/"pdf"/"document"/"binary"),
    /// a best-guess MIME string, and a flag indicating that the bytes start
    /// with an Access OLE Package envelope (caller should call
    /// <see cref="StripWrapper"/> before upload).
    /// </summary>
    public static (string Kind, string? Mime, bool HasOleWrapper) Sniff(byte[] head)
    {
        if (head is null || head.Length == 0) return ("binary", null, false);

        // First check for unwrapped magic at offset 0.
        var direct = SniffAt(head, 0);
        if (direct.HasValue) return (direct.Value.Kind, direct.Value.Mime, false);

        // Access OLE Object cells often start with an OLE Package or OleStream
        // envelope: an ASCII header (e.g. "Bitmap Image", "Microsoft Word
        // Document", "Package") followed by some metadata and then the real
        // bytes. The exact layout varies; the most robust approach is to scan
        // the first ~1 KB for known magic bytes and treat that as the start
        // of the real payload.
        for (var i = 1; i < Math.Min(head.Length - 4, 1024); i++)
        {
            var hit = SniffAt(head, i);
            if (hit.HasValue) return (hit.Value.Kind, hit.Value.Mime, true);
        }

        // OLE Compound Document (D0 CF 11 E0 ...) — legacy Word/Excel/Visio
        // embedded objects. Treat as a generic document file.
        if (head.Length >= 8 &&
            head[0] == 0xD0 && head[1] == 0xCF && head[2] == 0x11 && head[3] == 0xE0 &&
            head[4] == 0xA1 && head[5] == 0xB1 && head[6] == 0x1A && head[7] == 0xE1)
        {
            return ("document", "application/x-ole-storage", false);
        }

        return ("binary", "application/octet-stream", false);
    }

    /// <summary>
    /// If <see cref="Sniff"/> reported <c>HasOleWrapper=true</c>, strips the
    /// envelope and returns just the embedded payload. Otherwise returns the
    /// input array unchanged. Safe to call on any input — if nothing
    /// recognisable is found, returns the original bytes.
    /// </summary>
    public static byte[] StripWrapper(byte[] bytes)
    {
        if (bytes is null || bytes.Length < 4) return bytes ?? Array.Empty<byte>();

        // Quick out: already starts with known magic.
        if (SniffAt(bytes, 0).HasValue) return bytes;

        var scan = Math.Min(bytes.Length - 4, 4096);
        for (var i = 1; i < scan; i++)
        {
            if (SniffAt(bytes, i).HasValue)
            {
                var stripped = new byte[bytes.Length - i];
                Array.Copy(bytes, i, stripped, 0, stripped.Length);
                return stripped;
            }
        }
        return bytes;
    }

    private static (string Kind, string Mime)? SniffAt(byte[] b, int o)
    {
        // JPEG: FF D8 FF
        if (Has(b, o, 0xFF, 0xD8, 0xFF)) return ("image", "image/jpeg");
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if (Has(b, o, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
            return ("image", "image/png");
        // GIF: GIF87a / GIF89a
        if (Has(b, o, 0x47, 0x49, 0x46, 0x38) && o + 5 < b.Length &&
            (b[o + 4] == 0x37 || b[o + 4] == 0x39) && b[o + 5] == 0x61)
            return ("image", "image/gif");
        // WebP: RIFF .... WEBP
        if (Has(b, o, 0x52, 0x49, 0x46, 0x46) && o + 11 < b.Length &&
            b[o + 8] == 0x57 && b[o + 9] == 0x45 && b[o + 10] == 0x42 && b[o + 11] == 0x50)
            return ("image", "image/webp");
        // PDF: %PDF
        if (Has(b, o, 0x25, 0x50, 0x44, 0x46)) return ("pdf", "application/pdf");
        // ZIP / OOXML container (docx, xlsx) — PK\x03\x04
        if (Has(b, o, 0x50, 0x4B, 0x03, 0x04)) return ("document", "application/zip");
        // BMP only at offset 0 (2-byte magic is too lossy for offset scan).
        if (o == 0 && b.Length >= 6 && b[0] == 0x42 && b[1] == 0x4D)
        {
            var declared = BitConverter.ToInt32(b, 2);
            if (declared > 0 && declared <= b.Length + 1_000_000)
                return ("image", "image/bmp");
        }
        return null;
    }

    private static bool Has(byte[] b, int o, params byte[] sig)
    {
        if (o + sig.Length > b.Length) return false;
        for (var i = 0; i < sig.Length; i++)
            if (b[o + i] != sig[i]) return false;
        return true;
    }
}
