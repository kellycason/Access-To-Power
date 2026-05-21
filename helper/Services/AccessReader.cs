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

    private static string MapOleDbType(OleDbType t, int? maxLen) => t switch
    {
        // Access's TEXT type maps to (Var)WChar/(Var)Char in OLE DB and is
        // always capped at 255 chars in Access itself, so it's always a
        // single-line String in Dataverse. Long text uses LongVar*Char which
        // OLE DB reports separately — that's the genuine Memo case.
        // ACE OLE DB sometimes reports MaxLength=0/null for legitimately-
        // sized TEXT columns; treating those as Memo gave us double-height
        // textareas on form fields like LastName. Force Text here.
        OleDbType.WChar or OleDbType.VarWChar or OleDbType.Char or OleDbType.VarChar => "Text",
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
