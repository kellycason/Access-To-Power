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

        return table;
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
            table.Columns.Where(c => c.DataType is "OleObject" or "Binary" or "Attachment").Select(c => c.Name),
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
        OleDbType.WChar or OleDbType.VarWChar or OleDbType.Char or OleDbType.VarChar =>
            maxLen.HasValue && maxLen > 255 ? "Memo" : "Text",
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
