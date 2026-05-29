using System.Globalization;
using System.Text.Json;
using AccessToPower.Helper.Models;

namespace AccessToPower.Helper.Services;

/// <summary>
/// Pass 3 validator + migration report writer.
///
/// For each migrated table it:
///   1. Issues a FetchXML aggregate count against Dataverse (the only way to
///      get an exact count past 5 000 rows).
///   2. Compares the live count to <see cref="AccessTable.RowCount"/> minus
///      rejected rows recorded by <see cref="DataLoader"/>.
///   3. Pulls the rejected-rows annotation (if any) and records reject reasons.
///
/// The resulting <see cref="MigrationReport"/> is written to the migration
/// job as <c>migration-report.json</c> so the hosted Code App can render it.
/// </summary>
public sealed class Validator
{
    private readonly DataverseClient _dv;
    private readonly Action<ProgressEvent> _report;

    public Validator(DataverseClient dv, Action<ProgressEvent> report)
    {
        _dv = dv;
        _report = report;
    }

    public async Task<MigrationReport> RunAsync(
        Guid jobId,
        MigrationPlan plan,
        int unresolvedLookups,
        CancellationToken ct)
    {
        var migrateTables = plan.TableMappings.Where(t => t.Action == "Migrate").ToList();
        Report("phase", $"Validating {migrateTables.Count} tables…");

        var report = new MigrationReport
        {
            MigrationJobId = plan.MigrationJobId,
            CapturedAt = DateTimeOffset.UtcNow.ToString("O"),
            UnresolvedLookups = unresolvedLookups,
        };

        for (var i = 0; i < migrateTables.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var tm = migrateTables[i];
            var accessTable = plan.Manifest.Tables.FirstOrDefault(t =>
                string.Equals(t.Name, tm.AccessTable, StringComparison.OrdinalIgnoreCase));
            var expected = accessTable?.RowCount ?? 0;

            var rejectedCount = await CountRejectedAsync(jobId, tm.AccessTable, ct).ConfigureAwait(false);
            var binaryFailureCount = await CountBinaryFailuresAsync(jobId, tm.AccessTable, ct).ConfigureAwait(false);

            long actual = 0;
            string status;
            string? message = null;
            try
            {
                // For tables targeted at an EXISTING Dataverse entity we cannot
                // use the live row count -- pre-existing rows would inflate the
                // total. Use the id-map instead, which records exactly the rows
                // we successfully created in this run.
                var targetMode = tm.TargetMode?.Trim().ToLowerInvariant();
                if (string.Equals(targetMode, "existing", StringComparison.Ordinal))
                {
                    actual = await CountIdMapAsync(jobId, tm.DataverseSchemaName.ToLowerInvariant(), ct)
                        .ConfigureAwait(false);
                    message = "Target is an existing table; row count reflects this run only (idmap).";
                }
                else
                {
                    actual = await CountRowsAsync(tm.DataverseSchemaName.ToLowerInvariant(), ct)
                        .ConfigureAwait(false);
                }
                var expectedAfterRejects = Math.Max(0, expected - rejectedCount);
                status = actual == expectedAfterRejects ? "ok"
                       : actual < expectedAfterRejects ? "mismatch" : "extra";
            }
            catch (Exception ex)
            {
                status = "error";
                message = ex.Message;
            }

            var line = new MigrationReport.TableLine
            {
                AccessTable = tm.AccessTable,
                DataverseTable = tm.DataverseSchemaName,
                ExpectedRows = expected,
                RejectedRows = rejectedCount,
                ActualRows = actual,
                BinaryUploadFailures = binaryFailureCount,
                Status = status,
                Message = message,
            };
            // Surface column-level issues that the user would otherwise only
            // see by digging into manifest.json. Dropped columns (multi-value,
            // attachment, OLE) are particularly important because the row
            // counts will read green even though those columns are empty.
            if (accessTable is not null)
            {
                // A binary column is only "dropped" if the user didn't map it
                // to a Dataverse binary target. When the plan routes it to
                // File / Image / NoteAttachment we DO migrate the bytes, so
                // the stale scan-time "Schema-only" warning must be suppressed.
                bool MappedToBinary(string accessColName) =>
                    tm.Fields.Any(f =>
                        string.Equals(f.AccessColumn, accessColName, StringComparison.OrdinalIgnoreCase)
                        && string.Equals(f.Action, "Map", StringComparison.OrdinalIgnoreCase)
                        && (f.DataverseType == "File"
                            || f.DataverseType == "Image"
                            || f.DataverseType == "NoteAttachment"));

                foreach (var col in accessTable.Columns)
                {
                    var isBinaryCol = col.DataType is "OleObject" or "Binary" or "Attachment";
                    var migratedAsBinary = isBinaryCol && MappedToBinary(col.Name);
                    if (!migratedAsBinary)
                    {
                        if (!string.IsNullOrEmpty(col.UnsupportedReason))
                        {
                            line.DroppedColumns.Add($"{col.Name}: {col.UnsupportedReason}");
                        }
                        else if (col.DataType is "OleObject" or "Binary" or "Attachment" or "Multivalue")
                        {
                            line.DroppedColumns.Add($"{col.Name}: {col.DataType}");
                        }
                    }
                    if (col.Issues is null) continue;
                    foreach (var iss in col.Issues)
                    {
                        if (string.Equals(iss.Severity, "Info", StringComparison.OrdinalIgnoreCase)) continue;
                        // Same suppression — the "data will not migrate" warning
                        // is wrong when the column is mapped to a binary target.
                        if (migratedAsBinary
                            && string.Equals(iss.Category, "UnsupportedType", StringComparison.OrdinalIgnoreCase))
                            continue;
                        var entry = $"{col.Name}: {iss.Message}";
                        if (!line.Warnings.Contains(entry, StringComparer.Ordinal))
                        {
                            line.Warnings.Add(entry);
                        }
                    }
                }
                if (accessTable.Issues is not null)
                {
                    foreach (var iss in accessTable.Issues)
                    {
                        if (string.Equals(iss.Severity, "Info", StringComparison.OrdinalIgnoreCase)) continue;
                        if (!line.Warnings.Contains(iss.Message, StringComparer.Ordinal))
                        {
                            line.Warnings.Add(iss.Message);
                        }
                    }
                }
            }
            report.Tables.Add(line);

            var pct = (int)Math.Round(100.0 * (i + 1) / migrateTables.Count);
            Report("log",
                $"{tm.AccessTable}: expected {expected}, rejected {rejectedCount}, actual {actual} → {status}",
                severity: status switch { "ok" => null, "error" => "error", _ => "warn" },
                progress: pct);
        }

        report.TotalExpected = report.Tables.Sum(t => t.ExpectedRows);
        report.TotalRejected = report.Tables.Sum(t => t.RejectedRows);
        report.TotalActual = report.Tables.Sum(t => t.ActualRows);
        report.TotalBinaryUploadFailures = report.Tables.Sum(t => t.BinaryUploadFailures);
        report.OverallStatus = report.Tables.Any(t => t.Status == "error") ? "error"
                             : report.Tables.Any(t => t.Status is "mismatch" or "extra") ? "mismatch"
                             : report.UnresolvedLookups > 0 ? "partial"
                             : "ok";

        var json = JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true });
        await _dv.ReplaceAnnotationTextAsync(jobId, "migration-report.json", "application/json", json, ct)
            .ConfigureAwait(false);

        // Companion artifacts (guide Part 11): a human-readable HTML report
        // for hand-off to non-technical stakeholders, and a per-table CSV of
        // rejected rows so the team can fix-and-retry data quality issues.
        var html = BuildHtmlReport(report);
        await _dv.ReplaceAnnotationTextAsync(jobId, "migration-report.html", "text/html", html, ct)
            .ConfigureAwait(false);

        foreach (var t in report.Tables)
        {
            if (t.RejectedRows <= 0) continue;
            var csv = await BuildRejectedCsvAsync(jobId, t.AccessTable, ct).ConfigureAwait(false);
            if (csv is null) continue;
            await _dv.ReplaceAnnotationTextAsync(
                jobId,
                $"{SafeFileSegment(t.AccessTable)}-rejected.csv",
                "text/csv",
                csv,
                ct).ConfigureAwait(false);
        }

        Report("phase",
            $"Validation complete: {report.OverallStatus}. Total expected {report.TotalExpected}, actual {report.TotalActual}, rejected {report.TotalRejected}.",
            progress: 100,
            severity: report.OverallStatus == "ok" ? null : report.OverallStatus == "error" ? "error" : "warn");

        return report;
    }

    /* ------------------------------------------------------------------ */
    /* Report rendering                                                   */
    /* ------------------------------------------------------------------ */

    private static string BuildHtmlReport(MigrationReport report)
    {
        string statusBadge(string s) => s switch
        {
            "ok" => "<span style='color:#107c10;font-weight:600'>OK</span>",
            "mismatch" => "<span style='color:#bf8c00;font-weight:600'>MISMATCH</span>",
            "extra" => "<span style='color:#bf8c00;font-weight:600'>EXTRA</span>",
            "error" => "<span style='color:#d13438;font-weight:600'>ERROR</span>",
            "partial" => "<span style='color:#bf8c00;font-weight:600'>PARTIAL</span>",
            _ => System.Net.WebUtility.HtmlEncode(s),
        };

        var sb = new System.Text.StringBuilder();
        sb.Append("<!DOCTYPE html><html><head><meta charset='utf-8'><title>Migration Report</title>");
        sb.Append("<style>body{font-family:Segoe UI,Arial,sans-serif;margin:24px;color:#201f1e}");
        sb.Append("h1{font-size:20px;margin:0 0 8px}h2{font-size:14px;margin:16px 0 4px}");
        sb.Append("table{border-collapse:collapse;width:100%;font-size:13px}");
        sb.Append("th,td{border:1px solid #edebe9;padding:6px 10px;text-align:left}");
        sb.Append("th{background:#faf9f8}tr:nth-child(even){background:#fcfcfb}");
        sb.Append(".summary{display:flex;gap:16px;flex-wrap:wrap;margin:8px 0 16px}");
        sb.Append(".kpi{padding:8px 14px;border:1px solid #edebe9;border-radius:4px;background:#faf9f8}");
        sb.Append(".kpi b{display:block;font-size:18px}</style></head><body>");

        sb.Append("<h1>Access → Dataverse migration report</h1>");
        sb.Append("<div>Job ").Append(System.Net.WebUtility.HtmlEncode(report.MigrationJobId)).Append(" · captured ");
        sb.Append(System.Net.WebUtility.HtmlEncode(report.CapturedAt)).Append("</div>");

        sb.Append("<div class='summary'>");
        sb.Append("<div class='kpi'><b>").Append(statusBadge(report.OverallStatus)).Append("</b>Overall</div>");
        sb.Append("<div class='kpi'><b>").Append(report.TotalExpected).Append("</b>Expected rows</div>");
        sb.Append("<div class='kpi'><b>").Append(report.TotalActual).Append("</b>Loaded rows</div>");
        sb.Append("<div class='kpi'><b>").Append(report.TotalRejected).Append("</b>Rejected rows</div>");
        sb.Append("<div class='kpi'><b>").Append(report.UnresolvedLookups).Append("</b>Unresolved lookups</div>");
        if (report.TotalBinaryUploadFailures > 0)
        {
            sb.Append("<div class='kpi'><b>").Append(report.TotalBinaryUploadFailures).Append("</b>Binary upload failures</div>");
        }
        sb.Append("</div>");

        sb.Append("<h2>Per-table results</h2>");
        sb.Append("<table><thead><tr><th>Access table</th><th>Dataverse table</th>");
        sb.Append("<th>Expected</th><th>Rejected</th><th>Loaded</th><th>Binary errors</th><th>Status</th><th>Notes</th></tr></thead><tbody>");
        foreach (var t in report.Tables)
        {
            sb.Append("<tr>");
            sb.Append("<td>").Append(System.Net.WebUtility.HtmlEncode(t.AccessTable)).Append("</td>");
            sb.Append("<td>").Append(System.Net.WebUtility.HtmlEncode(t.DataverseTable)).Append("</td>");
            sb.Append("<td>").Append(t.ExpectedRows).Append("</td>");
            sb.Append("<td>").Append(t.RejectedRows).Append("</td>");
            sb.Append("<td>").Append(t.ActualRows).Append("</td>");
            sb.Append("<td>").Append(t.BinaryUploadFailures).Append("</td>");
            sb.Append("<td>").Append(statusBadge(t.Status)).Append("</td>");
            sb.Append("<td>");
            if (!string.IsNullOrEmpty(t.Message))
            {
                sb.Append("<div>").Append(System.Net.WebUtility.HtmlEncode(t.Message)).Append("</div>");
            }
            if (t.DroppedColumns.Count > 0)
            {
                sb.Append("<div style='color:#bf8c00'><b>Columns dropped:</b><ul style='margin:4px 0 0 18px;padding:0'>");
                foreach (var dc in t.DroppedColumns)
                {
                    sb.Append("<li>").Append(System.Net.WebUtility.HtmlEncode(dc)).Append("</li>");
                }
                sb.Append("</ul></div>");
            }
            if (t.Warnings.Count > 0)
            {
                sb.Append("<details style='margin-top:4px'><summary style='cursor:pointer;color:#605e5c'>")
                  .Append(t.Warnings.Count).Append(" warning").Append(t.Warnings.Count == 1 ? "" : "s")
                  .Append("</summary><ul style='margin:4px 0 0 18px;padding:0'>");
                foreach (var w in t.Warnings)
                {
                    sb.Append("<li>").Append(System.Net.WebUtility.HtmlEncode(w)).Append("</li>");
                }
                sb.Append("</ul></details>");
            }
            sb.Append("</td>");
            sb.Append("</tr>");
        }
        sb.Append("</tbody></table>");

        sb.Append("</body></html>");
        return sb.ToString();
    }

    /// <summary>
    /// Converts the NDJSON of rejected rows into a flat CSV. Columns are the
    /// union of all source keys plus _errorCode/_errorMessage at the front.
    /// </summary>
    private async Task<string?> BuildRejectedCsvAsync(Guid jobId, string accessTable, CancellationToken ct)
    {
        var fileName = $"{SafeFileSegment(accessTable)}-rejected.ndjson";
        var text = await _dv.ReadAnnotationTextAsync(jobId, fileName, ct).ConfigureAwait(false);
        if (string.IsNullOrEmpty(text)) return null;

        var rows = new List<Dictionary<string, string>>();
        var columns = new List<string> { "_errorCode", "_errorMessage" };
        var seen = new HashSet<string>(columns, StringComparer.OrdinalIgnoreCase);

        foreach (var rawLine in text.Split('\n'))
        {
            var line = rawLine.TrimStart('\uFEFF').Trim(LineTrimChars);
            if (line.Length == 0) continue;
            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); }
            catch (JsonException) { continue; }
            using (doc)
            {
                var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                // NDJSON is camelCase (errorCode/errorMessage/row) — match
                // case-insensitively so future PascalCase callers also work.
                if (TryGetPropertyCI(doc.RootElement, "errorCode", out var ec)) dict["_errorCode"] = ec.GetString() ?? "";
                if (TryGetPropertyCI(doc.RootElement, "errorMessage", out var em)) dict["_errorMessage"] = em.GetString() ?? "";
                if (TryGetPropertyCI(doc.RootElement, "row", out var rowEl) && rowEl.ValueKind == JsonValueKind.Object)
                {
                    foreach (var prop in rowEl.EnumerateObject())
                    {
                        dict[prop.Name] = prop.Value.ValueKind switch
                        {
                            JsonValueKind.String => prop.Value.GetString() ?? "",
                            JsonValueKind.Null => "",
                            _ => prop.Value.GetRawText(),
                        };
                        if (seen.Add(prop.Name)) columns.Add(prop.Name);
                    }
                }
                rows.Add(dict);
            }
        }
        if (rows.Count == 0) return null;

        var sb = new System.Text.StringBuilder();
        for (var i = 0; i < columns.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(CsvEscape(columns[i]));
        }
        sb.Append("\r\n");
        foreach (var r in rows)
        {
            for (var i = 0; i < columns.Count; i++)
            {
                if (i > 0) sb.Append(',');
                r.TryGetValue(columns[i], out var v);
                sb.Append(CsvEscape(v ?? ""));
            }
            sb.Append("\r\n");
        }
        return sb.ToString();
    }

    private static string CsvEscape(string s)
    {
        if (s.IndexOfAny(new[] { ',', '"', '\r', '\n' }) < 0) return s;
        return "\"" + s.Replace("\"", "\"\"") + "\"";
    }

    private static bool TryGetPropertyCI(JsonElement root, string name, out JsonElement value)
    {
        if (root.ValueKind == JsonValueKind.Object)
        {
            foreach (var prop in root.EnumerateObject())
            {
                if (string.Equals(prop.Name, name, StringComparison.OrdinalIgnoreCase))
                {
                    value = prop.Value;
                    return true;
                }
            }
        }
        value = default;
        return false;
    }

    /* ------------------------------------------------------------------ */

    private async Task<long> CountRowsAsync(string logical, CancellationToken ct)
    {
        var fetchXml =
            $"<fetch aggregate='true'><entity name='{logical}'>" +
            $"<attribute name='{logical}id' alias='c' aggregate='count'/>" +
            "</entity></fetch>";

        // Need the entity set name to call /<set>?fetchXml=...
        using var defDoc = await _dv.GetJsonAsync(
            $"EntityDefinitions(LogicalName='{logical}')?$select=EntitySetName", ct).ConfigureAwait(false);
        var entitySet = defDoc.RootElement.GetProperty("EntitySetName").GetString()
            ?? throw new InvalidOperationException($"EntitySetName missing for {logical}");

        using var doc = await _dv.GetJsonAsync(
            $"{entitySet}?fetchXml={Uri.EscapeDataString(fetchXml)}", ct).ConfigureAwait(false);

        if (!doc.RootElement.TryGetProperty("value", out var arr) || arr.GetArrayLength() == 0) return 0;
        var first = arr[0];
        if (first.TryGetProperty("c", out var c) && c.ValueKind == JsonValueKind.Number)
        {
            return c.GetInt64();
        }
        return 0;
    }

    private static readonly char[] LineTrimChars = { '\r', ' ', '\t' };

    private async Task<long> CountIdMapAsync(Guid jobId, string tableLogical, CancellationToken ct)
    {
        var fileName = $"idmap-{tableLogical}.json";
        var text = await _dv.ReadAnnotationTextAsync(jobId, fileName, ct).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(text)) return 0;
        try
        {
            using var doc = JsonDocument.Parse(text);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return 0;
            long n = 0;
            foreach (var _ in doc.RootElement.EnumerateObject()) n++;
            return n;
        }
        catch (JsonException)
        {
            return 0;
        }
    }

    private async Task<long> CountRejectedAsync(Guid jobId, string accessTable, CancellationToken ct)
    {
        var fileName = $"{SafeFileSegment(accessTable)}-rejected.ndjson";
        var text = await _dv.ReadAnnotationTextAsync(jobId, fileName, ct).ConfigureAwait(false);
        if (string.IsNullOrEmpty(text)) return 0;
        long count = 0;
        foreach (var line in text.Split('\n'))
        {
            if (line.AsSpan().TrimStart('\uFEFF').Trim(LineTrimChars).Length > 0) count++;
        }
        return count;
    }

    private async Task<long> CountBinaryFailuresAsync(Guid jobId, string accessTable, CancellationToken ct)
    {
        var fileName = $"{SafeFileSegment(accessTable)}-binary-errors.ndjson";
        var text = await _dv.ReadAnnotationTextAsync(jobId, fileName, ct).ConfigureAwait(false);
        if (string.IsNullOrEmpty(text)) return 0;
        long count = 0;
        foreach (var line in text.Split('\n'))
        {
            if (line.AsSpan().TrimStart('\uFEFF').Trim(LineTrimChars).Length > 0) count++;
        }
        return count;
    }

    private void Report(string kind, string message, string? severity = null, int? progress = null)
        => _report(new ProgressEvent
        {
            Kind = kind,
            Message = message,
            Severity = severity,
            Progress = progress,
        });

    private static string SafeFileSegment(string s)
    {
        var invalid = System.IO.Path.GetInvalidFileNameChars();
        var clean = new string(s.Select(c => invalid.Contains(c) ? '_' : c).ToArray());
        return string.IsNullOrWhiteSpace(clean) ? "table" : clean;
    }
}

/// <summary>
/// JSON shape persisted as <c>migration-report.json</c> on the migration job
/// and rendered by the Validate / Done step in the hosted Code App.
/// </summary>
public sealed class MigrationReport
{
    public string MigrationJobId { get; set; } = "";
    public string CapturedAt { get; set; } = "";
    public string OverallStatus { get; set; } = "ok";
    public long TotalExpected { get; set; }
    public long TotalRejected { get; set; }
    public long TotalActual { get; set; }
    public int UnresolvedLookups { get; set; }
    public long TotalBinaryUploadFailures { get; set; }
    public List<TableLine> Tables { get; set; } = new();

    public sealed class TableLine
    {
        public string AccessTable { get; set; } = "";
        public string DataverseTable { get; set; } = "";
        public long ExpectedRows { get; set; }
        public long RejectedRows { get; set; }
        public long ActualRows { get; set; }
        /// <summary>
        /// Number of File / Image / NoteAttachment uploads that failed for
        /// this table. Row inserts may still have succeeded — these are
        /// blob-only failures. Detail lives in
        /// <c>{table}-binary-errors.ndjson</c>.
        /// </summary>
        public long BinaryUploadFailures { get; set; }
        /// <summary>"ok" | "mismatch" | "extra" | "error"</summary>
        public string Status { get; set; } = "ok";
        public string? Message { get; set; }
        /// <summary>
        /// Columns that were not migrated as live data — multi-value lookups,
        /// attachments, OLE blobs, binary, or anything else the source flagged
        /// as unsupported. Each entry is "ColumnName: reason".
        /// </summary>
        public List<string> DroppedColumns { get; set; } = new();
        /// <summary>
        /// Per-table Warning/Error issues from the source manifest that the
        /// user should see in the post-migration summary (truncation hints,
        /// precision-loss, value-list discoveries, etc.). De-duplicated.
        /// </summary>
        public List<string> Warnings { get; set; } = new();
    }
}
