using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using AccessToPower.Helper.Models;

namespace AccessToPower.Helper.Services;

/// <summary>
/// Pass 2 lookup resolver. After <see cref="DataLoader"/> has inserted every
/// row of every migrated table (with lookup columns left null), this pass
/// walks each 1:N relationship in the manifest and patches the child row's
/// lookup column to bind to the matching parent record via
/// <c>@odata.bind</c>.
///
/// Algorithm:
///   For each relationship (parent → child, single-column FK):
///     For each child row in the NDJSON:
///       Read child PK and FK values.
///       Look up child Dataverse GUID in <c>idMap[childLogical][childPK]</c>.
///       Look up parent Dataverse GUID in <c>idMap[parentLogical][childFK]</c>.
///       If either is missing — log as unresolved, continue.
///       Otherwise PATCH the child row with the @odata.bind.
///
/// PATCHes are issued in $batch chunks to stay within entitlement limits
/// (each batch counts as one request toward the 5-minute service-protection
/// window). Retry-After is honored on 429/503.
/// </summary>
public sealed class LookupResolver
{
    private const int DefaultBatchSize = 100;

    private readonly DataverseClient _dv;
    private readonly Action<ProgressEvent> _report;

    public LookupResolver(DataverseClient dv, Action<ProgressEvent> report)
    {
        _dv = dv;
        _report = report;
    }

    public async Task<int> RunAsync(
        Guid jobId,
        MigrationPlan plan,
        string publisherPrefix,
        DataLoader.IdMap idMap,
        CancellationToken ct)
    {
        var relevant = plan.Manifest.Relationships
            .Where(r => r.ChildColumns.Count == 1 && r.ParentColumns.Count == 1)
            .ToList();
        if (relevant.Count == 0)
        {
            Report("phase", "No relationships to resolve.");
            return 0;
        }
        Report("phase", $"Resolving {relevant.Count} lookups…");

        var totalUnresolved = 0;

        for (var i = 0; i < relevant.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var rel = relevant[i];

            var parentMap = plan.TableMappings.FirstOrDefault(t =>
                string.Equals(t.AccessTable, rel.ParentTable, StringComparison.OrdinalIgnoreCase)
                && t.Action == "Migrate");
            var childMap = plan.TableMappings.FirstOrDefault(t =>
                string.Equals(t.AccessTable, rel.ChildTable, StringComparison.OrdinalIgnoreCase)
                && t.Action == "Migrate");
            if (parentMap is null || childMap is null) continue;

            var childTable = plan.Manifest.Tables.FirstOrDefault(t =>
                string.Equals(t.Name, rel.ChildTable, StringComparison.OrdinalIgnoreCase));
            if (childTable is null) continue;

            var childLogical = childMap.DataverseSchemaName.ToLowerInvariant();
            var parentLogical = parentMap.DataverseSchemaName.ToLowerInvariant();
            if (!idMap.TryGetValue(childLogical, out var childIds) ||
                !idMap.TryGetValue(parentLogical, out var parentIds))
            {
                Report("log",
                    $"Skipping {rel.Name}: missing id map for {childLogical} or {parentLogical}.",
                    severity: "warn");
                continue;
            }

            var childPkCol = childTable.Columns.FirstOrDefault(c => c.IsPrimaryKey)?.Name;
            if (childPkCol is null)
            {
                Report("log", $"Skipping {rel.Name}: child table {childTable.Name} has no primary key.", severity: "warn");
                continue;
            }

            var childFkCol = rel.ChildColumns[0];

            // Resolve the lookup logical name. Prefer the user's explicit
            // mapping for the FK column (matches SchemaCreator's Bug-A fix).
            var fkField = childMap.Fields.FirstOrDefault(f =>
                string.Equals(f.AccessColumn, childFkCol, StringComparison.OrdinalIgnoreCase));
            string lookupLogical = fkField is not null
                                   && fkField.DataverseType == "Lookup"
                                   && !string.IsNullOrWhiteSpace(fkField.DataverseSchemaName)
                ? fkField.DataverseSchemaName.ToLowerInvariant()
                : $"{publisherPrefix.ToLowerInvariant()}_{Slug(LookupBaseName(childFkCol))}";

            var parentEntitySet = await ResolveEntitySetAsync(parentMap, ct).ConfigureAwait(false);
            var childEntitySet = await ResolveEntitySetAsync(childMap, ct).ConfigureAwait(false);

            var rows = await DownloadNdjsonAsync(jobId, childTable.RowsFile, ct).ConfigureAwait(false);
            var patches = new List<PatchOp>(rows.Count);
            var unresolved = 0;

            foreach (var row in rows)
            {
                if (!row.TryGetValue(childPkCol, out var pkVal) || pkVal is null) continue;
                if (!row.TryGetValue(childFkCol, out var fkVal) || fkVal is null) continue;
                var pkKey = Convert.ToString(pkVal, CultureInfo.InvariantCulture) ?? "";
                var fkKey = Convert.ToString(fkVal, CultureInfo.InvariantCulture) ?? "";
                if (!childIds.TryGetValue(pkKey, out var childGuid))
                {
                    unresolved++;
                    continue;
                }
                if (!parentIds.TryGetValue(fkKey, out var parentGuid))
                {
                    unresolved++;
                    continue;
                }
                patches.Add(new PatchOp(childGuid, parentGuid));
            }

            var patched = await SendPatchBatchesAsync(
                childEntitySet, lookupLogical, parentEntitySet, patches, ct).ConfigureAwait(false);

            totalUnresolved += unresolved;
            var pct = (int)Math.Round(100.0 * (i + 1) / relevant.Count);
            Report("lookup",
                $"{rel.Name}: patched {patched}/{patches.Count}; unresolved {unresolved}.",
                progress: pct,
                severity: unresolved > 0 ? "warn" : null);
        }

        Report("phase", $"Lookup resolution complete. {totalUnresolved} unresolved row(s).",
            progress: 100,
            severity: totalUnresolved > 0 ? "warn" : null);
        return totalUnresolved;
    }

    /* ------------------------------------------------------------------ */
    /* Batch PATCH                                                         */
    /* ------------------------------------------------------------------ */

    private sealed record PatchOp(Guid ChildId, Guid ParentId);

    private async Task<int> SendPatchBatchesAsync(
        string childEntitySet,
        string lookupLogical,
        string parentEntitySet,
        List<PatchOp> ops,
        CancellationToken ct)
    {
        var patched = 0;
        for (var offset = 0; offset < ops.Count; offset += DefaultBatchSize)
        {
            ct.ThrowIfCancellationRequested();
            var chunk = ops.GetRange(offset, Math.Min(DefaultBatchSize, ops.Count - offset));
            var ok = await SendOnePatchBatchAsync(childEntitySet, lookupLogical, parentEntitySet, chunk, ct)
                .ConfigureAwait(false);
            patched += ok;
        }
        return patched;
    }

    private async Task<int> SendOnePatchBatchAsync(
        string childEntitySet,
        string lookupLogical,
        string parentEntitySet,
        List<PatchOp> ops,
        CancellationToken ct)
    {
        var boundary = $"batch_{Guid.NewGuid():N}";
        var changeset = $"changeset_{Guid.NewGuid():N}";
        var sb = new StringBuilder();
        sb.Append("--").Append(boundary).Append("\r\n");
        sb.Append("Content-Type: multipart/mixed; boundary=").Append(changeset).Append("\r\n\r\n");

        for (var i = 0; i < ops.Count; i++)
        {
            var op = ops[i];
            var body = JsonSerializer.Serialize(new Dictionary<string, string>
            {
                [$"{lookupLogical}@odata.bind"] = $"/{parentEntitySet}({op.ParentId:D})"
            });
            sb.Append("--").Append(changeset).Append("\r\n");
            sb.Append("Content-Type: application/http\r\n");
            sb.Append("Content-Transfer-Encoding: binary\r\n");
            sb.Append("Content-ID: ").Append(i + 1).Append("\r\n\r\n");
            sb.Append("PATCH ").Append(childEntitySet).Append('(').Append(op.ChildId.ToString("D")).Append(") HTTP/1.1\r\n");
            sb.Append("Content-Type: application/json;type=entry\r\n");
            sb.Append("If-Match: *\r\n\r\n");
            sb.Append(body).Append("\r\n");
        }
        sb.Append("--").Append(changeset).Append("--\r\n");
        sb.Append("--").Append(boundary).Append("--\r\n");

        var responseText = await SendBatchWithRetryAsync(boundary, sb.ToString(), ct).ConfigureAwait(false);

        // Count 204 No Content (PATCH success) responses.
        var ok = 0;
        var failures = new List<string>();
        foreach (var match in System.Text.RegularExpressions.Regex.Matches(responseText, @"HTTP/1\.1\s+(\d{3})\s+([^\r\n]+)")
                                                                   .Cast<System.Text.RegularExpressions.Match>())
        {
            var status = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
            if (status >= 200 && status < 300) ok++;
            else if (status >= 400)
            {
                failures.Add($"HTTP {status} {match.Groups[2].Value.Trim()}");
            }
        }
        if (failures.Count > 0)
        {
            Report("log", $"Lookup PATCH batch had {failures.Count} failure(s): {string.Join(" | ", failures.Take(3))}",
                severity: "warn");
        }
        return ok;
    }

    private async Task<string> SendBatchWithRetryAsync(string boundary, string payload, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "$batch")
            {
                Content = new StringContent(payload, Encoding.UTF8)
                {
                    Headers =
                    {
                        ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("multipart/mixed")
                        {
                            Parameters = { new System.Net.Http.Headers.NameValueHeaderValue("boundary", boundary) }
                        }
                    }
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
                Report("log", $"Throttled (HTTP {(int)resp.StatusCode}); waiting {waitMs} ms before retry {attempt + 1}/5.",
                    severity: "warn");
                await Task.Delay(waitMs, ct).ConfigureAwait(false);
                continue;
            }
            if (!resp.IsSuccessStatusCode)
            {
                var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                throw new InvalidOperationException(
                    $"Dataverse $batch (PATCH) returned HTTP {(int)resp.StatusCode}: {Truncate(body, 800)}");
            }
            return await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        }
    }

    private static int ComputeRetryAfterMs(HttpResponseMessage resp, int attempt)
    {
        if (resp.Headers.RetryAfter is { } header)
        {
            if (header.Delta is { } delta) return Math.Clamp((int)delta.TotalMilliseconds, 500, 30_000);
            if (header.Date is { } date)
            {
                var wait = (int)Math.Max(0, (date.UtcDateTime - DateTime.UtcNow).TotalMilliseconds);
                return Math.Clamp(wait, 500, 30_000);
            }
        }
        return (int)Math.Min(30_000, 500 * Math.Pow(2, attempt));
    }

    /* ------------------------------------------------------------------ */
    /* NDJSON download (duplicated from DataLoader; small + stable)        */
    /* ------------------------------------------------------------------ */

    private async Task<List<Dictionary<string, object?>>> DownloadNdjsonAsync(
        Guid jobId, string fileName, CancellationToken ct)
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
                    row[prop.Name] = prop.Value.ValueKind switch
                    {
                        JsonValueKind.String => prop.Value.GetString(),
                        JsonValueKind.Number => prop.Value.TryGetInt64(out var l) ? l : (object?)prop.Value.GetDouble(),
                        JsonValueKind.True => true,
                        JsonValueKind.False => false,
                        JsonValueKind.Null => null,
                        _ => prop.Value.GetRawText(),
                    };
                }
                rows.Add(row);
            }
            catch (JsonException) { /* skip */ }
        }
        return rows;
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

    private void Report(string kind, string message, int? progress = null, string? severity = null)
        => _report(new ProgressEvent
        {
            Kind = kind,
            Message = message,
            Progress = progress,
            Severity = severity,
        });

    private static string Truncate(string s, int n) => s.Length > n ? s[..n] + "…" : s;

    private static string Slug(string s)
    {
        var lower = new StringBuilder(s.Length);
        foreach (var c in s)
        {
            if (char.IsLetterOrDigit(c)) lower.Append(char.ToLowerInvariant(c));
            else lower.Append('_');
        }
        return lower.ToString().Trim('_');
    }

    private static string LookupBaseName(string accessForeignKeyColumn)
    {
        var trimmed = accessForeignKeyColumn.Trim();
        return System.Text.RegularExpressions.Regex.Replace(trimmed, "_?id$", "",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase) is { Length: > 0 } stripped
            ? stripped
            : trimmed;
    }
}
