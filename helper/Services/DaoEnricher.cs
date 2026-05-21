using System.Globalization;
using AccessToPower.Helper.Models;

namespace AccessToPower.Helper.Services;

/// <summary>
/// Reads Access metadata that the ACE OLEDB schema rowsets do not expose:
///  - Lookup-Wizard value lists (DisplayControl / RowSourceType / RowSource).
///    Used to upgrade a plain Text/Integer column into a Dataverse Choice.
///  - Multi-valued lookup columns (Field2.IsComplex). Cannot migrate as a
///    scalar; flagged so the report surfaces them as "dropped".
///  - Attachment columns (dbAttachment = 101). Likewise flagged.
///
/// This uses DAO late-bound via COM (ProgID = "DAO.DBEngine.120"). DAO ships
/// with the Access Database Engine that we already require for reading the
/// .accdb, so no extra prereqs.
/// </summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public static class DaoEnricher
{
    private const int DbAttachment = 101;
    // DisplayControl values that mean "this column is presented as a Choice
    // picker in the Access UI". 109 = ComboBox, 111 = ListBox (yes the docs
    // are confusing — old constants).
    private static readonly HashSet<int> ChoiceDisplayControls = new() { 109, 110, 111 };

    /// <summary>
    /// Best-effort enrichment. Any DAO error (COM unavailable, file lock,
    /// missing property) is swallowed per-table/per-field; the migration
    /// continues with whatever metadata OLEDB already gave us.
    /// </summary>
    public static void Enrich(AccessSchemaManifest manifest, string accdbPath, Action<string>? log = null)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentException.ThrowIfNullOrWhiteSpace(accdbPath);

        var progId = Type.GetTypeFromProgID("DAO.DBEngine.120");
        if (progId is null)
        {
            log?.Invoke("DAO.DBEngine.120 not registered — skipping value-list / multivalue detection.");
            return;
        }

        dynamic? engine = null;
        dynamic? db = null;
        try
        {
            engine = Activator.CreateInstance(progId);
            if (engine is null) return;
            // OpenDatabase(name, exclusive=false, readOnly=true)
            db = engine.OpenDatabase(accdbPath, false, true);

            // Index manifest tables by name for fast lookup.
            var tablesByName = manifest.Tables.ToDictionary(t => t.Name, StringComparer.OrdinalIgnoreCase);

            dynamic tableDefs = db.TableDefs;
            int count = tableDefs.Count;
            for (var ti = 0; ti < count; ti++)
            {
                dynamic td;
                try { td = tableDefs[ti]; }
                catch { continue; }

                string tdName;
                try { tdName = (string)td.Name; }
                catch { continue; }
                if (tdName.StartsWith("MSys", StringComparison.OrdinalIgnoreCase)) continue;
                if (!tablesByName.TryGetValue(tdName, out var manifestTable)) continue;

                dynamic fields = td.Fields;
                int fcount = fields.Count;
                for (var fi = 0; fi < fcount; fi++)
                {
                    dynamic f;
                    try { f = fields[fi]; }
                    catch { continue; }

                    string fname;
                    try { fname = (string)f.Name; }
                    catch { continue; }

                    var col = manifestTable.Columns.FirstOrDefault(
                        c => string.Equals(c.Name, fname, StringComparison.OrdinalIgnoreCase));
                    if (col is null) continue;

                    // 1. Multivalue (IsComplex). A field can be both IsComplex
                    //    and have an underlying type (Long for multi-value
                    //    lookups, Text for multi-value text lists); the data
                    //    lives in a sub-table that ACE OLEDB cannot stream.
                    try
                    {
                        if ((bool)f.IsComplex)
                        {
                            col.UnsupportedReason = "Multivalue";
                            col.DataType = "Multivalue";
                            EnsureIssue(col, manifestTable.Name,
                                "Warning", "UnsupportedType",
                                $"Column '{col.Name}' is an Access multi-valued field. " +
                                "Values are stored in a hidden sub-table and cannot migrate as a scalar; " +
                                "the column is created in Dataverse but rows will be empty. " +
                                "Consider modeling this as a child table + N:1 lookup post-migration.");
                            continue;
                        }
                    }
                    catch { /* IsComplex missing on older DAO — ignore */ }

                    // 2. Attachment (DAO field type 101 = dbAttachment).
                    try
                    {
                        var ftype = (short)f.Type;
                        if (ftype == DbAttachment)
                        {
                            col.UnsupportedReason = "Attachment";
                            col.DataType = "Attachment";
                            EnsureIssue(col, manifestTable.Name,
                                "Warning", "UnsupportedType",
                                $"Column '{col.Name}' is an Access Attachment column. " +
                                "Attachment data cannot migrate via the metadata bridge; " +
                                "the column is created in Dataverse but rows will be empty. " +
                                "Use a Dataverse File column + a one-off file upload after migration.");
                            continue;
                        }
                    }
                    catch { /* Type missing — ignore */ }

                    // 3. Stamp existing OleObject/Binary cols with the same
                    //    machine-readable reason so the report can group them.
                    if (col.DataType is "OleObject" or "Binary")
                    {
                        col.UnsupportedReason ??= col.DataType;
                    }

                    // 4. Value list discovery. We probe the Properties
                    //    collection (each access throws if the property
                    //    doesn't exist on this field).
                    int? displayControl = TryReadIntProperty(f, "DisplayControl");
                    if (displayControl is null || !ChoiceDisplayControls.Contains(displayControl.Value)) continue;

                    var rowSourceType = TryReadStringProperty(f, "RowSourceType");
                    if (rowSourceType is null) continue;
                    // Access 2010+ stores this as "Value List". Older builds
                    // sometimes show it as "Microsoft.Access.ValueList" — match loosely.
                    if (rowSourceType.IndexOf("Value List", StringComparison.OrdinalIgnoreCase) < 0
                        && rowSourceType.IndexOf("ValueList", StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        // Table/Query lookup — out of scope for first pass.
                        continue;
                    }

                    var rowSource = TryReadStringProperty(f, "RowSource");
                    if (string.IsNullOrWhiteSpace(rowSource)) continue;
                    var labels = ParseValueList(rowSource);
                    if (labels.Count == 0) continue;

                    col.ValueList = labels;
                    col.LimitToList = TryReadBoolProperty(f, "LimitToList");
                    EnsureIssue(col, manifestTable.Name,
                        "Info", "Other",
                        $"Column '{col.Name}' has an Access value list ({labels.Count} options); " +
                        "will be created as a Dataverse Choice column.");
                }
            }
        }
        catch (Exception ex)
        {
            log?.Invoke($"DAO enrichment failed: {ex.Message}");
        }
        finally
        {
            try { if (db is not null) db.Close(); } catch { }
            try { if (db is not null) System.Runtime.InteropServices.Marshal.FinalReleaseComObject(db); } catch { }
            try { if (engine is not null) System.Runtime.InteropServices.Marshal.FinalReleaseComObject(engine); } catch { }
            GC.Collect();
            GC.WaitForPendingFinalizers();
        }
    }

    private static int? TryReadIntProperty(dynamic field, string name)
    {
        try
        {
            dynamic prop = field.Properties[name];
            var v = prop.Value;
            if (v is null) return null;
            return Convert.ToInt32(v, CultureInfo.InvariantCulture);
        }
        catch { return null; }
    }

    private static string? TryReadStringProperty(dynamic field, string name)
    {
        try
        {
            dynamic prop = field.Properties[name];
            var v = prop.Value;
            return v?.ToString();
        }
        catch { return null; }
    }

    private static bool? TryReadBoolProperty(dynamic field, string name)
    {
        try
        {
            dynamic prop = field.Properties[name];
            var v = prop.Value;
            if (v is null) return null;
            return Convert.ToBoolean(v, CultureInfo.InvariantCulture);
        }
        catch { return null; }
    }

    /// <summary>
    /// Parses an Access RowSource value-list string. Semicolon separator;
    /// individual labels may be quoted with double-quotes (e.g.
    /// <c>"High";"Medium";"Low"</c>). Returns labels with surrounding quotes
    /// stripped and outer whitespace trimmed; empty labels are dropped.
    /// </summary>
    internal static List<string> ParseValueList(string rowSource)
    {
        var result = new List<string>();
        var buf = new System.Text.StringBuilder();
        var inQuote = false;
        foreach (var ch in rowSource)
        {
            if (ch == '"')
            {
                inQuote = !inQuote;
                continue;
            }
            if (ch == ';' && !inQuote)
            {
                var label = buf.ToString().Trim();
                if (label.Length > 0) result.Add(label);
                buf.Clear();
                continue;
            }
            buf.Append(ch);
        }
        var tail = buf.ToString().Trim();
        if (tail.Length > 0) result.Add(tail);
        // De-dupe while preserving order — repeated labels would crash the
        // SchemaCreator (option metadata uniqueness).
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var deduped = new List<string>(result.Count);
        foreach (var l in result) if (seen.Add(l)) deduped.Add(l);
        return deduped;
    }

    private static void EnsureIssue(
        AccessColumn col, string tableName,
        string severity, string category, string message)
    {
        col.Issues ??= new();
        // Avoid duplicate issues if both OLEDB and DAO flagged the column.
        if (col.Issues.Any(i =>
                string.Equals(i.Category, category, StringComparison.Ordinal) &&
                string.Equals(i.Message, message, StringComparison.Ordinal)))
        {
            return;
        }
        col.Issues.Add(new ManifestIssue
        {
            Severity = severity,
            Category = category,
            Message = message,
            Table = tableName,
            Column = col.Name,
        });
    }
}
