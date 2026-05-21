using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AccessToPower.Helper.Models;

namespace AccessToPower.Helper.Services;

/// <summary>
/// Pass 1 data load. Reads NDJSON row files that the scan phase uploaded as
/// annotations on the migration job, then bulk-creates rows in the
/// customer's freshly-provisioned Dataverse tables via the OData <c>$batch</c>
/// endpoint.
///
/// Design notes (guide Parts 8 + 10):
///  - One <c>$batch</c> per chunk (default 100 rows). Each batch contains a
///    single changeset, so the whole chunk commits or fails together. Sub-
///    response parsing detects per-row errors and segregates them into a
///    rejected file annotation so the rest of the table can still proceed.
///  - <c>Retry-After</c> is honored on 429/503. Exponential backoff caps at
///    30 s; after 5 consecutive retries the batch is treated as failed.
///  - Lookups are NOT set in pass 1 — they're patched in pass 2 once every
///    table has rows (so we have GUIDs to bind to). See <see cref="LookupResolver"/>.
///  - For every successful row we record (Access PK → Dataverse GUID) in a
///    per-table id map. The map is persisted as <c>idmap-{table}.json</c> on
///    the migration job so pass 2 (and a future resume) can pick up without
///    re-running pass 1.
/// </summary>
public sealed class DataLoader
{
    private const int DefaultBatchSize = 100;

    private readonly DataverseClient _dv;
    private readonly Action<ProgressEvent> _report;

    public DataLoader(DataverseClient dv, Action<ProgressEvent> report)
    {
        _dv = dv;
        _report = report;
    }

    /// <summary>
    /// Map: Dataverse logical table name -> (stringified Access PK value -> Dataverse GUID).
    /// </summary>
    public sealed class IdMap : Dictionary<string, Dictionary<string, Guid>> { }

    public async Task<IdMap> RunAsync(Guid jobId, MigrationPlan plan, CancellationToken ct)
    {
        var idMap = new IdMap();
        var migrateTables = plan.TableMappings.Where(t => t.Action == "Migrate").ToList();
        migrateTables = TopologicallySort(migrateTables, plan);
        Report("phase", $"Loading rows for {migrateTables.Count} tables…");

        for (var i = 0; i < migrateTables.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var tm = migrateTables[i];
            var accessTable = plan.Manifest.Tables.FirstOrDefault(t =>
                string.Equals(t.Name, tm.AccessTable, StringComparison.OrdinalIgnoreCase));
            if (accessTable is null)
            {
                Report("log", $"No manifest entry for {tm.AccessTable}; skipping.", severity: "warn");
                continue;
            }

            var pct = (int)Math.Round(100.0 * i / Math.Max(1, migrateTables.Count));
            Report("table:start",
                $"Loading {accessTable.Name} ({accessTable.RowCount} rows)",
                tm.DataverseSchemaName, pct);

            var tableLogical = tm.DataverseSchemaName.ToLowerInvariant();
            var entitySet = await ResolveEntitySetAsync(tm, ct).ConfigureAwait(false);

            // Resume support: hydrate the existing id map, prune entries whose
            // Dataverse row no longer exists, then only create missing source
            // rows. This keeps a retry from trusting stale GUIDs or duplicating
            // rows that were already committed in a prior run.
            var perTableMap = await TryLoadIdMapAsync(jobId, tableLogical, ct).ConfigureAwait(false);
            if (perTableMap is not null && perTableMap.Count > 0)
            {
                var missing = await PruneMissingIdsAsync(entitySet, tableLogical, perTableMap, ct).ConfigureAwait(false);
                if (missing > 0)
                {
                    await PersistIdMapAsync(jobId, tableLogical, perTableMap, ct).ConfigureAwait(false);
                    Report("log",
                        $"Resume map for {tableLogical} referenced {missing} Dataverse row(s) that no longer exist; those source rows will be reloaded.",
                        severity: "warn");
                }
            }
            if (perTableMap is not null && perTableMap.Count >= accessTable.RowCount)
            {
                idMap[tableLogical] = perTableMap;
                Report("log", $"Resuming: {tableLogical} already has {perTableMap.Count} ids mapped; skipping load.");
                Report("table:done", $"Loaded {accessTable.Name} (resumed).", tm.DataverseSchemaName);
                continue;
            }
            perTableMap ??= new Dictionary<string, Guid>();
            idMap[tableLogical] = perTableMap;

            var pkColumn = accessTable.Columns.FirstOrDefault(c => c.IsPrimaryKey)?.Name;

            // System-required-field defaults for OOB tables (e.g. `product`
            // demands `defaultuomscheduleid` + `defaultuomid` on every row).
            // For custom tables this returns an empty dict.
            var systemDefaults = await GetSystemFieldDefaultsAsync(tableLogical, ct).ConfigureAwait(false);
            if (systemDefaults.Count > 0)
            {
                Report("log",
                    $"{accessTable.Name} -> {tableLogical}: injecting {systemDefaults.Count} system-required field default(s) ({string.Join(", ", systemDefaults.Keys)}).");
            }

            var rows = await DownloadNdjsonAsync(jobId, accessTable.RowsFile, ct).ConfigureAwait(false);
            var loaded = perTableMap.Count;
            var rejectedRows = new List<RejectedRow>();

            for (var offset = 0; offset < rows.Count; offset += DefaultBatchSize)
            {
                ct.ThrowIfCancellationRequested();
                var chunk = rows.GetRange(offset, Math.Min(DefaultBatchSize, rows.Count - offset));

                // Pre-batch row-level validation. Anything we can detect locally
                // (memo cap, decimal range, required missing, etc.) is rejected
                // here so we don't waste a $batch slot on rows that would 400.
                // We keep the original chunk index alongside the projected body
                // so we can correlate batch sub-responses back to source rows.
                var sendable = new List<Dictionary<string, object?>>(chunk.Count);
                var sendableIdx = new List<int>(chunk.Count);
                for (var j = 0; j < chunk.Count; j++)
                {
                    if (pkColumn is not null
                        && chunk[j].TryGetValue(pkColumn, out var existingPkVal)
                        && existingPkVal is not null
                        && perTableMap.ContainsKey(Convert.ToString(existingPkVal, CultureInfo.InvariantCulture) ?? ""))
                    {
                        continue;
                    }

                    var pr = TryProjectRow(chunk[j], tm, accessTable);
                    if (pr.Body is null)
                    {
                        rejectedRows.Add(new RejectedRow(chunk[j], pr.ErrorCode, pr.ErrorMessage));
                    }
                    else
                    {
                        // Inject OOB-table system defaults (e.g. product's
                        // defaultuomscheduleid / defaultuomid) without
                        // overwriting any user-mapped value.
                        foreach (var kv in systemDefaults)
                        {
                            if (!pr.Body.ContainsKey(kv.Key))
                                pr.Body[kv.Key] = kv.Value;
                        }
                        sendable.Add(pr.Body);
                        sendableIdx.Add(j);
                    }
                }

                if (sendable.Count == 0)
                {
                    Report("log",
                        $"{accessTable.Name}: {Math.Min(offset + DefaultBatchSize, rows.Count)}/{rows.Count} rows (all {chunk.Count} in chunk rejected pre-batch)",
                        severity: "warn");
                    continue;
                }

                var primaryIdName = tableLogical + "id";
                var batchResult = await TryExecuteCreateBatchAsync(entitySet, primaryIdName, sendable, ct).ConfigureAwait(false);

                if (batchResult is null)
                {
                    // Whole-batch failure (transactional changeset rolled back).
                    // Every row in `sendable` is unsuccessful — mark them rejected
                    // and move on so the rest of the table can still load.
                    foreach (var idx in sendableIdx)
                    {
                        rejectedRows.Add(new RejectedRow(chunk[idx], "BatchRolledBack", _lastBatchError ?? "Dataverse $batch returned 400."));
                    }
                    Report("log",
                        $"{accessTable.Name}: whole chunk ({sendable.Count} rows) rejected by Dataverse: {_lastBatchError}",
                        severity: "warn");
                }
                else
                {
                    for (var k = 0; k < sendable.Count; k++)
                    {
                        var subResult = batchResult[k];
                        var sourceRow = chunk[sendableIdx[k]];
                        if (subResult.Created)
                        {
                            if (subResult.NewId is Guid id
                                && pkColumn is not null
                                && sourceRow.TryGetValue(pkColumn, out var pkVal)
                                && pkVal is not null)
                            {
                                perTableMap[Convert.ToString(pkVal, CultureInfo.InvariantCulture) ?? ""] = id;
                            }
                            loaded++;
                        }
                        else
                        {
                            rejectedRows.Add(new RejectedRow(sourceRow, subResult.ErrorCode, subResult.ErrorMessage));
                        }
                    }
                }

                Report("log",
                    $"{accessTable.Name}: {Math.Min(offset + DefaultBatchSize, rows.Count)}/{rows.Count} rows ({rejectedRows.Count} rejected)");

                // Checkpoint after each batch so a crash/throttle halt doesn't
                // lose progress. Cheap because the per-table map is small.
                await PersistIdMapAsync(jobId, tableLogical, perTableMap, ct).ConfigureAwait(false);
            }

            if (rejectedRows.Count > 0)
            {
                await PersistRejectedAsync(jobId, tm.AccessTable, rejectedRows, ct).ConfigureAwait(false);
                Report("log",
                    $"{accessTable.Name}: {rejectedRows.Count} rejected row(s) written to {RejectedFileName(tm.AccessTable)}",
                    severity: "warn");
            }

            // Always persist the per-table id map at end-of-table so a re-run
            // can short-circuit on resume — including the zero-row schema-only
            // case where the inner chunk loop never executed.
            await PersistIdMapAsync(jobId, tableLogical, perTableMap, ct).ConfigureAwait(false);

            Report("table:done",
                $"Loaded {accessTable.Name}: {loaded}/{rows.Count} rows.",
                tm.DataverseSchemaName);
        }

        Report("phase", "Row load complete.", progress: 100);
        return idMap;
    }

    /* ------------------------------------------------------------------ */
    /* Batch create                                                       */
    /* ------------------------------------------------------------------ */

    private sealed record SubResult(bool Created, Guid? NewId, string? ErrorCode, string? ErrorMessage);

    /// <summary>Sentinel used by the row loop to detect whole-batch failure.</summary>
    private sealed class BatchFailedException : Exception
    {
        public int Status { get; }
        public BatchFailedException(int status, string message) : base(message) => Status = status;
    }

    private string? _lastBatchError;

    /// <summary>
    /// Wraps <see cref="ExecuteCreateBatchAsync"/> with whole-batch failure
    /// handling. Returns <c>null</c> when Dataverse rejected the whole
    /// changeset (caller treats every row as rejected and continues).
    /// </summary>
    private async Task<List<SubResult>?> TryExecuteCreateBatchAsync(
        string entitySet,
        string primaryIdName,
        List<Dictionary<string, object?>> bodies,
        CancellationToken ct)
    {
        try
        {
            _lastBatchError = null;
            return await ExecuteCreateBatchAsync(entitySet, primaryIdName, bodies, ct).ConfigureAwait(false);
        }
        catch (BatchFailedException ex)
        {
            _lastBatchError = $"HTTP {ex.Status}: {ex.Message}";
            return null;
        }
    }

    private static string ExtractBatchErrorMessage(string body)
    {
        // The batch response is multipart/mixed wrapping the failed
        // sub-request. Inside that, Dataverse emits a JSON {"error":{...}}.
        // Grab the first {"error":...} object we can find and extract code+message.
        var idx = body.IndexOf("{\"error\"", StringComparison.Ordinal);
        if (idx >= 0)
        {
            // Find the matching closing brace heuristically (the response is
            // small and never has embedded nested errors deeper than 2 levels).
            var depth = 0;
            for (var i = idx; i < body.Length; i++)
            {
                if (body[i] == '{') depth++;
                else if (body[i] == '}')
                {
                    depth--;
                    if (depth == 0)
                    {
                        var slice = body.Substring(idx, i - idx + 1);
                        try
                        {
                            using var doc = JsonDocument.Parse(slice);
                            var err = doc.RootElement.GetProperty("error");
                            var code = err.TryGetProperty("code", out var c) ? c.GetString() : null;
                            var msg = err.TryGetProperty("message", out var m) ? m.GetString() : null;
                            if (!string.IsNullOrEmpty(code) || !string.IsNullOrEmpty(msg))
                                return $"{code} {msg}".Trim();
                        }
                        catch { /* fall through to truncated body */ }
                        break;
                    }
                }
            }
        }
        return Truncate(body, 400);
    }

    private async Task<List<SubResult>> ExecuteCreateBatchAsync(
        string entitySet,
        string primaryIdName,
        List<Dictionary<string, object?>> bodies,
        CancellationToken ct)
    {
        var boundary = $"batch_{Guid.NewGuid():N}";
        var changeset = $"changeset_{Guid.NewGuid():N}";
        var sb = new StringBuilder();
        sb.Append("--").Append(boundary).Append("\r\n");
        sb.Append("Content-Type: multipart/mixed; boundary=").Append(changeset).Append("\r\n\r\n");

        for (var i = 0; i < bodies.Count; i++)
        {
            sb.Append("--").Append(changeset).Append("\r\n");
            sb.Append("Content-Type: application/http\r\n");
            sb.Append("Content-Transfer-Encoding: binary\r\n");
            sb.Append("Content-ID: ").Append(i + 1).Append("\r\n\r\n");
            sb.Append("POST ").Append(entitySet).Append(" HTTP/1.1\r\n");
            sb.Append("Content-Type: application/json;type=entry\r\n");
            sb.Append("Prefer: return=representation\r\n\r\n");
            sb.Append(JsonSerializer.Serialize(bodies[i])).Append("\r\n");
        }
        sb.Append("--").Append(changeset).Append("--\r\n");
        sb.Append("--").Append(boundary).Append("--\r\n");

        var responseText = await SendBatchAsync(boundary, sb.ToString(), ct).ConfigureAwait(false);
        return ParseBatchResults(responseText, bodies.Count, primaryIdName);
    }

    private async Task<string> SendBatchAsync(string boundary, string payload, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "$batch")
            {
                Content = new StringContent(payload, Encoding.UTF8)
                {
                    Headers = { ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("multipart/mixed") { Parameters = { new System.Net.Http.Headers.NameValueHeaderValue("boundary", boundary) } } }
                }
            };
            using var resp = await _dv.SendRawAsync(req, ct).ConfigureAwait(false);

            if (resp.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.ServiceUnavailable)
            {
                if (attempt >= 5)
                {
                    var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                    throw new InvalidOperationException(
                        $"Dataverse throttled (HTTP {(int)resp.StatusCode}) after {attempt} retries. Response: {Truncate(body, 500)}");
                }
                var waitMs = ComputeRetryAfterMs(resp, attempt);
                Report("log", $"Throttled (HTTP {(int)resp.StatusCode}); waiting {waitMs} ms before retry {attempt + 1}/5.", severity: "warn");
                await Task.Delay(waitMs, ct).ConfigureAwait(false);
                continue;
            }

            if (!resp.IsSuccessStatusCode)
            {
                var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                // For a transactional changeset, ANY single sub-request
                // failure causes Dataverse to return 400 for the whole
                // batch (rolled back). Surface the error body to the caller
                // so it can mark every row in the chunk as rejected and
                // continue with the next chunk, instead of killing the
                // whole migration. We use a typed exception so the caller
                // can distinguish "this batch failed" from "transport died".
                throw new BatchFailedException(
                    (int)resp.StatusCode,
                    ExtractBatchErrorMessage(body));
            }

            return await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        }
    }

    private static int ComputeRetryAfterMs(HttpResponseMessage resp, int attempt)
    {
        // Prefer the server's Retry-After. Fall back to exponential backoff.
        if (resp.Headers.RetryAfter is { } header)
        {
            if (header.Delta is { } delta) return Math.Clamp((int)delta.TotalMilliseconds, 500, 30_000);
            if (header.Date is { } date)
            {
                var wait = (int)Math.Max(0, (date.UtcDateTime - DateTime.UtcNow).TotalMilliseconds);
                return Math.Clamp(wait, 500, 30_000);
            }
        }
        var exp = (int)Math.Min(30_000, 500 * Math.Pow(2, attempt));
        return exp;
    }

    private static readonly string[] ContentIdDelim = { "\r\nContent-ID: " };

    private List<SubResult> ParseBatchResults(string responseText, int expected, string primaryIdName)
    {
        var results = new List<SubResult>(expected);
        for (var i = 0; i < expected; i++) results.Add(new SubResult(false, null, "Unknown", "No sub-response parsed"));

        // Sub-responses are delimited by Content-ID. Anything before the first
        // Content-ID is the outer batch envelope and is ignored.
        var parts = responseText.Split(ContentIdDelim, StringSplitOptions.None);
        for (var p = 1; p < parts.Length; p++)
        {
            var sub = parts[p];
            var nl = sub.IndexOf('\n');
            if (nl < 0) continue;
            if (!int.TryParse(sub.AsSpan(0, nl).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var cid)) continue;
            var idx = cid - 1;
            if (idx < 0 || idx >= expected) continue;

            // Status line.
            var statusMatch = System.Text.RegularExpressions.Regex.Match(sub, @"HTTP/1\.1\s+(\d{3})\s+([^\r\n]+)");
            if (!statusMatch.Success) continue;
            var status = int.Parse(statusMatch.Groups[1].Value, CultureInfo.InvariantCulture);

            if (status >= 200 && status < 300)
            {
                var idMatch = System.Text.RegularExpressions.Regex.Match(
                    sub,
                    @"OData-EntityId:\s*[^(]+\(([0-9a-fA-F-]{36})\)",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                Guid? newId = idMatch.Success && Guid.TryParse(idMatch.Groups[1].Value, out var g) ? g : null;
                if (newId is null)
                {
                    // Fall back to the JSON body's primary-key field. The sub-
                    // response text continues past the JSON body with multipart
                    // boundary lines ("\r\n--changesetresponse_..."), so we
                    // must slice out only the JSON object (matching brace)
                    // before parsing -- JsonDocument.Parse rejects trailing
                    // non-whitespace content.
                    var jsonSlice = ExtractJsonObjectSlice(sub);
                    if (jsonSlice is not null)
                    {
                        try
                        {
                            using var doc = JsonDocument.Parse(jsonSlice);
                            if (doc.RootElement.TryGetProperty(primaryIdName, out var primaryId)
                                && primaryId.ValueKind == JsonValueKind.String
                                && Guid.TryParse(primaryId.GetString(), out var primaryGuid))
                            {
                                newId = primaryGuid;
                            }
                        }
                        catch (JsonException) { /* leave null */ }
                    }
                }

                if (newId is null && !_loggedBatchSampleMissingId)
                {
                    _loggedBatchSampleMissingId = true;
                    var snippet = sub.Length > 1200 ? sub.Substring(0, 1200) : sub;
                    Report("log",
                        $"Batch sub-response {cid} returned status {status} but no entity id was extractable. First 1200 chars: {snippet}",
                        severity: "warn");
                }

                // 2xx => the row WAS created in Dataverse. Mark Created=true
                // even when we cannot recover the GUID, so the row is counted
                // as loaded (just absent from the idmap, which only hurts FK
                // resolution for child tables pointing at this row).
                results[idx] = new SubResult(true, newId, null, null);
            }
            else
            {
                var code = "Http" + status;
                var message = statusMatch.Groups[2].Value.Trim();
                var jsonStart = sub.IndexOf('{');
                if (jsonStart >= 0)
                {
                    try
                    {
                        using var doc = JsonDocument.Parse(sub[jsonStart..]);
                        if (doc.RootElement.TryGetProperty("error", out var err))
                        {
                            if (err.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String) code = c.GetString() ?? code;
                            if (err.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String) message = m.GetString() ?? message;
                        }
                    }
                    catch (JsonException) { /* keep status-line fallback */ }
                }
                results[idx] = new SubResult(false, null, code, message);
            }
        }
        return results;
    }

    private bool _loggedBatchSampleMissingId;

    /// <summary>
    /// Returns the first balanced JSON object found in <paramref name="text"/>
    /// (from the first '{' to its matching '}'), or null if none is present.
    /// Skips braces inside string literals.
    /// </summary>
    private static string? ExtractJsonObjectSlice(string text)
    {
        var start = text.IndexOf('{');
        if (start < 0) return null;
        var depth = 0;
        var inString = false;
        var escaped = false;
        for (var i = start; i < text.Length; i++)
        {
            var ch = text[i];
            if (escaped) { escaped = false; continue; }
            if (ch == '\\' && inString) { escaped = true; continue; }
            if (ch == '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch == '{') depth++;
            else if (ch == '}')
            {
                depth--;
                if (depth == 0) return text.Substring(start, i - start + 1);
            }
        }
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* Row projection + validation                                        */
    /* ------------------------------------------------------------------ */

    // Dataverse limits (guide Part 9). Anything past these is a hard reject;
    // softer issues (precision drop on Float, etc.) are silently coerced and
    // surface in the validate phase if the row count mismatches.
    private const int StringHardCap = 4000;
    private const int MemoHardCap = 1_048_576;
    private const decimal DecimalHardMax = 100_000_000_000m;        // ±100B
    private const decimal MoneyHardMax = 922_337_203_685_477m;       // ±922T (922,337,203,685,477.0000)
    private const double DoubleHardMax = 100_000_000_000d;          // ±100B per Dataverse Float
    private const long IntegerHardMax = 2_147_483_647L;             // Dataverse Whole Number is Int32
    private const long IntegerHardMin = -2_147_483_648L;

    private readonly record struct ProjectionResult(Dictionary<string, object?>? Body, string? ErrorCode, string? ErrorMessage)
    {
        public static ProjectionResult Ok(Dictionary<string, object?> body) => new(body, null, null);
        public static ProjectionResult Reject(string code, string message) => new(null, code, message);
    }

    private static ProjectionResult TryProjectRow(
        Dictionary<string, object?> row,
        TableMapping tm,
        AccessTable accessTable)
    {
        var pkColumns = new HashSet<string>(
            accessTable.Columns.Where(c => c.IsPrimaryKey).Select(c => c.Name),
            StringComparer.OrdinalIgnoreCase);

        var output = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in tm.Fields)
        {
            if (f.Action != "Map") continue;
            if (pkColumns.Contains(f.AccessColumn)) continue;        // Dataverse generates its own GUID
            if (f.DataverseType == "Lookup") continue;                // pass 2

            row.TryGetValue(f.AccessColumn, out var v);

            if (v is null || (v is string s0 && s0.Length == 0))
            {
                if (f.IsRequired)
                {
                    return ProjectionResult.Reject(
                        "RequiredFieldMissing",
                        $"Required column '{f.AccessColumn}' (target '{f.DataverseSchemaName}') is empty.");
                }
                continue;
            }

            // Choice: translate raw label → integer option value before the
            // generic coercer runs. Dataverse picklist endpoints accept only
            // ints. An unknown label is dropped (column left null) rather
            // than rejecting the whole row — we'd rather lose a Choice value
            // than fail the row entirely. The migration report surfaces
            // unmatched labels as a per-table warning.
            if (f.DataverseType == "Choice")
            {
                var label = Convert.ToString(v, CultureInfo.InvariantCulture)?.Trim();
                if (string.IsNullOrEmpty(label)) continue;
                int? matched = null;
                if (f.ChoiceOptions is { Count: > 0 })
                {
                    foreach (var opt in f.ChoiceOptions)
                    {
                        if (string.Equals(opt.Label, label, StringComparison.OrdinalIgnoreCase))
                        {
                            matched = opt.Value;
                            break;
                        }
                    }
                    if (matched is null && int.TryParse(label, NumberStyles.Integer, CultureInfo.InvariantCulture, out var asInt))
                    {
                        foreach (var opt in f.ChoiceOptions)
                        {
                            if (opt.Value == asInt) { matched = asInt; break; }
                        }
                    }
                }
                if (matched is null) continue;
                output[f.DataverseSchemaName.ToLowerInvariant()] = matched.Value;
                continue;
            }

            var coerced = Coerce(v, f.DataverseType);
            if (coerced is null)
            {
                return ProjectionResult.Reject(
                    "CoercionFailed",
                    $"Could not coerce value of '{f.AccessColumn}' to {f.DataverseType}: {Truncate(Convert.ToString(v, CultureInfo.InvariantCulture) ?? "", 80)}");
            }

            // Type-specific hard limits.
            switch (f.DataverseType)
            {
                case "String":
                    {
                        var str = (string)coerced;
                        var cap = Math.Min(f.MaxLength ?? StringHardCap, StringHardCap);
                        if (str.Length > cap)
                        {
                            return ProjectionResult.Reject(
                                "StringTooLong",
                                $"Column '{f.AccessColumn}' value length {str.Length} exceeds cap {cap}.");
                        }
                        break;
                    }
                case "Memo":
                    {
                        var str = (string)coerced;
                        if (str.Length > MemoHardCap)
                        {
                            return ProjectionResult.Reject(
                                "MemoTooLong",
                                $"Column '{f.AccessColumn}' memo length {str.Length} exceeds Dataverse cap {MemoHardCap}.");
                        }
                        break;
                    }
                case "Integer":
                case "BigInt":
                    {
                        var l = (long)coerced;
                        if (f.DataverseType == "Integer" && (l > IntegerHardMax || l < IntegerHardMin))
                        {
                            return ProjectionResult.Reject(
                                "IntegerOutOfRange",
                                $"Column '{f.AccessColumn}' value {l} exceeds Int32 range; consider BigInt or Decimal.");
                        }
                        break;
                    }
                case "Decimal":
                    {
                        var d = (decimal)coerced;
                        if (Math.Abs(d) > DecimalHardMax)
                        {
                            return ProjectionResult.Reject(
                                "DecimalOutOfRange",
                                $"Column '{f.AccessColumn}' value {d} exceeds Dataverse Decimal range (±{DecimalHardMax}).");
                        }
                        break;
                    }
                case "Money":
                    {
                        var d = (decimal)coerced;
                        if (Math.Abs(d) > MoneyHardMax)
                        {
                            return ProjectionResult.Reject(
                                "MoneyOutOfRange",
                                $"Column '{f.AccessColumn}' value {d} exceeds Dataverse Money range.");
                        }
                        break;
                    }
                case "Double":
                    {
                        var d = (double)coerced;
                        if (double.IsNaN(d) || double.IsInfinity(d) || Math.Abs(d) > DoubleHardMax)
                        {
                            return ProjectionResult.Reject(
                                "DoubleOutOfRange",
                                $"Column '{f.AccessColumn}' value {d.ToString("R", CultureInfo.InvariantCulture)} not representable in Dataverse Float.");
                        }
                        break;
                    }
            }

            output[f.DataverseSchemaName.ToLowerInvariant()] = coerced;
        }

        // Synthetic primary name population.
        //
        // When no Access column qualifies as a primary name (junction tables
        // like BookAuthors, or tables where the only "naming" candidate is
        // a Lookup/Int), SchemaCreator emits a synthetic <prefix>_name
        // String attribute so Dataverse has *something* to render. Nothing
        // ever writes to it, though, so the MDA view and lookups show blank
        // rows. Synthesize a deterministic label here using the source PK
        // value(s) so the user has something to click on.
        var primaryField = string.IsNullOrEmpty(tm.PrimaryNameAccessColumn)
            ? null
            : tm.Fields.FirstOrDefault(f => string.Equals(f.AccessColumn, tm.PrimaryNameAccessColumn, StringComparison.OrdinalIgnoreCase));
        var primaryFieldIsTextual = primaryField is not null
            && (string.Equals(primaryField.DataverseType, "String", StringComparison.Ordinal)
                || string.Equals(primaryField.DataverseType, "Memo", StringComparison.Ordinal));
        if (!primaryFieldIsTextual)
        {
            var prefix = tm.DataverseSchemaName.Split('_', 2)[0];
            var syntheticKey = $"{prefix}_name";
            if (!output.ContainsKey(syntheticKey))
            {
                var pkValues = accessTable.Columns
                    .Where(c => c.IsPrimaryKey)
                    .Select(c => row.TryGetValue(c.Name, out var v) ? Convert.ToString(v, CultureInfo.InvariantCulture) : null)
                    .Where(s => !string.IsNullOrEmpty(s))
                    .ToList();
                var display = string.IsNullOrEmpty(tm.DataverseDisplayName)
                    ? tm.AccessTable
                    : tm.DataverseDisplayName;
                var label = pkValues.Count > 0
                    ? $"{display} {string.Join("-", pkValues)}"
                    : display;
                if (label.Length > 100) label = label[..100];
                output[syntheticKey] = label;
            }
        }

        return ProjectionResult.Ok(output);
    }

    private static object? Coerce(object value, string dataverseType)
    {
        return dataverseType switch
        {
            "Integer" or "BigInt" => value switch
            {
                long l => l,
                int i => i,
                double d => (long)Math.Truncate(d),
                decimal dec => (long)dec,
                bool b => b ? 1 : 0,
                _ => long.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Integer, CultureInfo.InvariantCulture, out var p) ? p : (object?)null
            },
            "Decimal" or "Money" => value switch
            {
                decimal dec => dec,
                double d => (decimal)d,
                long l => (decimal)l,
                int i => (decimal)i,
                _ => decimal.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out var p) ? p : (object?)null
            },
            "Double" => value switch
            {
                double d => d,
                decimal dec => (double)dec,
                long l => (double)l,
                int i => (double)i,
                _ => double.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out var p) ? p : (object?)null
            },
            "Boolean" => value switch
            {
                bool b => b,
                int i => i != 0,
                long l => l != 0,
                string s => s.Equals("true", StringComparison.OrdinalIgnoreCase)
                            || s == "1"
                            || s.Equals("yes", StringComparison.OrdinalIgnoreCase)
                            || s.Equals("y", StringComparison.OrdinalIgnoreCase),
                _ => false
            },
            "DateTime" => value switch
            {
                DateTime dt => dt.ToString("O", CultureInfo.InvariantCulture),
                DateTimeOffset dto => dto.ToString("O", CultureInfo.InvariantCulture),
                _ => Convert.ToString(value, CultureInfo.InvariantCulture)
            },
            "DateOnly" => value switch
            {
                DateTime dt => dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                DateTimeOffset dto => dto.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                string s when DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var dt) =>
                    dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                _ => Convert.ToString(value, CultureInfo.InvariantCulture)
            },
            _ => Convert.ToString(value, CultureInfo.InvariantCulture)
        };
    }

    /* ------------------------------------------------------------------ */
    /* NDJSON download                                                    */
    /* ------------------------------------------------------------------ */

    private async Task<List<Dictionary<string, object?>>> DownloadNdjsonAsync(
        Guid jobId,
        string fileName,
        CancellationToken ct)
    {
        var text = await _dv.ReadAnnotationTextAsync(jobId, fileName, ct).ConfigureAwait(false);
        var rows = new List<Dictionary<string, object?>>();
        if (string.IsNullOrEmpty(text)) return rows;

        foreach (var rawLine in text.Split('\n'))
        {
            var line = rawLine.TrimStart('\uFEFF').Trim('\r', ' ', '\t');
            if (line.Length == 0) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) continue;
                var row = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                foreach (var prop in doc.RootElement.EnumerateObject())
                {
                    row[prop.Name] = ReadJsonValue(prop.Value);
                }
                rows.Add(row);
            }
            catch (JsonException)
            {
                // Malformed line — counted as missing during validate phase.
            }
        }
        return rows;
    }

    private static object? ReadJsonValue(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.String => el.GetString(),
        JsonValueKind.Number => el.TryGetInt64(out var l) ? l : (object?)el.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Null => null,
        _ => el.GetRawText()
    };

    /* ------------------------------------------------------------------ */
    /* Id-map + rejected-rows persistence                                 */
    /* ------------------------------------------------------------------ */

    private static string IdMapFileName(string tableLogical) => $"idmap-{tableLogical}.json";
    private static string RejectedFileName(string accessTable) => $"{SafeFileSegment(accessTable)}-rejected.ndjson";

    private async Task<Dictionary<string, Guid>?> TryLoadIdMapAsync(Guid jobId, string tableLogical, CancellationToken ct)
    {
        var text = await _dv.ReadAnnotationTextAsync(jobId, IdMapFileName(tableLogical), ct).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(text)) return null;
        try
        {
            var raw = JsonSerializer.Deserialize<Dictionary<string, string>>(text);
            if (raw is null) return null;
            var map = new Dictionary<string, Guid>(raw.Count);
            foreach (var kv in raw)
            {
                if (Guid.TryParse(kv.Value, out var g)) map[kv.Key] = g;
            }
            return map;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private async Task<int> PruneMissingIdsAsync(
        string entitySet,
        string tableLogical,
        Dictionary<string, Guid> map,
        CancellationToken ct)
    {
        var primaryId = tableLogical + "id";
        var missingKeys = new List<string>();
        foreach (var kv in map)
        {
            ct.ThrowIfCancellationRequested();
            var exists = await _dv.ExistsAsync($"{entitySet}({kv.Value:D})?$select={primaryId}", ct)
                .ConfigureAwait(false);
            if (!exists) missingKeys.Add(kv.Key);
        }

        foreach (var key in missingKeys)
        {
            map.Remove(key);
        }
        return missingKeys.Count;
    }

    private async Task PersistIdMapAsync(Guid jobId, string tableLogical, Dictionary<string, Guid> map, CancellationToken ct)
    {
        var serializable = map.ToDictionary(k => k.Key, v => v.Value.ToString("D"));
        var json = JsonSerializer.Serialize(serializable);
        await _dv.ReplaceAnnotationTextAsync(jobId, IdMapFileName(tableLogical), "application/json", json, ct)
            .ConfigureAwait(false);
    }

    private sealed record RejectedRow(Dictionary<string, object?> Row, string? ErrorCode, string? ErrorMessage);

    private async Task PersistRejectedAsync(Guid jobId, string accessTable, List<RejectedRow> rejected, CancellationToken ct)
    {
        var sb = new StringBuilder();
        foreach (var r in rejected)
        {
            var obj = new JsonObject
            {
                ["accessTable"] = accessTable,
                ["errorCode"] = r.ErrorCode,
                ["errorMessage"] = r.ErrorMessage,
                ["row"] = JsonNode.Parse(JsonSerializer.Serialize(r.Row)),
            };
            sb.Append(obj.ToJsonString()).Append('\n');
        }
        await _dv.ReplaceAnnotationTextAsync(jobId, RejectedFileName(accessTable), "application/x-ndjson", sb.ToString(), ct)
            .ConfigureAwait(false);
    }

    /* ------------------------------------------------------------------ */
    /* System-required-field defaults for OOB tables                      */
    /* ------------------------------------------------------------------ */

    private readonly Dictionary<string, Dictionary<string, object?>> _systemDefaultsCache =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Some out-of-the-box Dataverse tables require lookups that don't exist
    /// in the Access schema (e.g. <c>product</c> requires
    /// <c>defaultuomscheduleid</c> and <c>defaultuomid</c>). When the user
    /// maps an Access table onto one of these, we inject sensible defaults
    /// here so the row create doesn't 400 with errors like "The unit
    /// schedule id is missing." The dictionary is cached per-entity for the
    /// lifetime of the load.
    /// </summary>
    private async Task<Dictionary<string, object?>> GetSystemFieldDefaultsAsync(
        string entityLogicalName,
        CancellationToken ct)
    {
        if (_systemDefaultsCache.TryGetValue(entityLogicalName, out var cached))
            return cached;

        var defaults = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
        try
        {
            switch (entityLogicalName)
            {
                case "product":
                    {
                        // Product needs a Unit Group + Default Unit. Pick the
                        // first available unit group, then its first unit.
                        using var schedDoc = await _dv.GetJsonAsync(
                            "uomschedules?$select=uomscheduleid&$top=1", ct).ConfigureAwait(false);
                        var schedArr = schedDoc.RootElement.GetProperty("value");
                        if (schedArr.GetArrayLength() > 0)
                        {
                            var schedId = schedArr[0].GetProperty("uomscheduleid").GetString();
                            defaults["defaultuomscheduleid@odata.bind"] = $"/uomschedules({schedId})";

                            using var uomDoc = await _dv.GetJsonAsync(
                                $"uoms?$filter=_uomscheduleid_value eq {schedId}&$select=uomid&$top=1", ct).ConfigureAwait(false);
                            var uomArr = uomDoc.RootElement.GetProperty("value");
                            if (uomArr.GetArrayLength() > 0)
                            {
                                var uomId = uomArr[0].GetProperty("uomid").GetString();
                                defaults["defaultuomid@odata.bind"] = $"/uoms({uomId})";
                            }
                        }
                        break;
                    }
            }
        }
        catch (Exception ex)
        {
            Report("log",
                $"Could not resolve system-field defaults for {entityLogicalName}: {ex.Message}. " +
                $"Rows may fail if required system fields are missing.",
                severity: "warn");
        }

        _systemDefaultsCache[entityLogicalName] = defaults;
        return defaults;
    }

    /* ------------------------------------------------------------------ */
    /* Entity-set resolution                                              */
    /* ------------------------------------------------------------------ */

    private readonly Dictionary<string, string> _entitySetCache = new(StringComparer.OrdinalIgnoreCase);

    private async Task<string> ResolveEntitySetAsync(TableMapping tm, CancellationToken ct)
    {
        if (!string.IsNullOrEmpty(tm.DataverseEntitySetName)) return tm.DataverseEntitySetName!;
        var logical = tm.DataverseSchemaName.ToLowerInvariant();
        if (_entitySetCache.TryGetValue(logical, out var cached)) return cached;
        using var doc = await _dv.GetJsonAsync(
            $"EntityDefinitions(LogicalName='{logical}')?$select=EntitySetName", ct).ConfigureAwait(false);
        var set = doc.RootElement.GetProperty("EntitySetName").GetString()
            ?? throw new InvalidOperationException($"EntitySetName missing for {logical}");
        _entitySetCache[logical] = set;
        return set;
    }

    /* ------------------------------------------------------------------ */
    /* Helpers                                                            */
    /* ------------------------------------------------------------------ */

    private void Report(string kind, string message, string? entityLogicalName = null, int? progress = null, string? severity = null)
        => _report(new ProgressEvent
        {
            Kind = kind,
            Message = message,
            EntityLogicalName = entityLogicalName,
            Progress = progress,
            Severity = severity,
        });

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max] + "…";

    private static string SafeFileSegment(string s)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var clean = new string(s.Select(c => invalid.Contains(c) ? '_' : c).ToArray());
        return string.IsNullOrWhiteSpace(clean) ? "table" : clean;
    }

    /// <summary>
    /// Kahn's topological sort of tables by FK dependency (parents first).
    /// Lookups are deferred to pass 2 so load order doesn't change correctness,
    /// but ordering parents first keeps progress output intuitive and lets a
    /// future "inline lookup" mode work without a redesign. Cycles (self-ref
    /// or true circular FK) are broken at the highest in-degree node — the
    /// affected table still loads, and the lookup binding catches up in pass 2.
    /// </summary>
    private List<TableMapping> TopologicallySort(List<TableMapping> tables, MigrationPlan plan)
    {
        if (tables.Count <= 1) return tables;

        var byName = tables.ToDictionary(
            t => t.AccessTable,
            t => t,
            StringComparer.OrdinalIgnoreCase);

        // adjacency: parent -> set of children (so we can decrement child in-degree as parents emit).
        var children = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
        var indegree = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var t in tables)
        {
            children[t.AccessTable] = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            indegree[t.AccessTable] = 0;
        }

        foreach (var rel in plan.Manifest.Relationships)
        {
            if (!byName.ContainsKey(rel.ParentTable) || !byName.ContainsKey(rel.ChildTable)) continue;
            // Self-reference can't add to its own in-degree without creating an
            // unbreakable cycle. Pass 2 (LookupResolver) wires it correctly.
            if (string.Equals(rel.ParentTable, rel.ChildTable, StringComparison.OrdinalIgnoreCase)) continue;
            if (children[rel.ParentTable].Add(rel.ChildTable))
            {
                indegree[rel.ChildTable]++;
            }
        }

        var ready = new Queue<string>(
            tables.Where(t => indegree[t.AccessTable] == 0)
                  .Select(t => t.AccessTable)
                  .OrderBy(n => n, StringComparer.OrdinalIgnoreCase));
        var sorted = new List<TableMapping>(tables.Count);
        var emitted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        while (sorted.Count < tables.Count)
        {
            if (ready.Count == 0)
            {
                // Cycle. Pick the lowest-indegree remaining node.
                var pick = tables
                    .Where(t => !emitted.Contains(t.AccessTable))
                    .OrderBy(t => indegree[t.AccessTable])
                    .ThenBy(t => t.AccessTable, StringComparer.OrdinalIgnoreCase)
                    .First();
                Report("log",
                    $"FK cycle detected; loading '{pick.AccessTable}' before all parents. Pass 2 will fix lookups.",
                    severity: "warn");
                ready.Enqueue(pick.AccessTable);
            }

            var name = ready.Dequeue();
            if (!emitted.Add(name)) continue;
            sorted.Add(byName[name]);
            foreach (var child in children[name])
            {
                if (--indegree[child] == 0) ready.Enqueue(child);
            }
        }

        return sorted;
    }
}
