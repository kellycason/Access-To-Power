using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AccessToPower.Helper.Services;

/// <summary>
/// Minimal Dataverse Web API client. Uploads the manifest + NDJSON row files
/// as file-content annotations on the acp_migrationjob record.
/// </summary>
public sealed class DataverseClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly string _envUrl;
    private bool _disposed;

    public DataverseClient(string environmentUrl, string accessToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(environmentUrl);
        ArgumentException.ThrowIfNullOrWhiteSpace(accessToken);
        _envUrl = environmentUrl.TrimEnd('/');
        var inner = new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            ConnectTimeout = TimeSpan.FromSeconds(30),
        };
        _http = new HttpClient(new RetryHandler(inner))
        {
            BaseAddress = new Uri(_envUrl + "/api/data/v9.2/"),
            Timeout = TimeSpan.FromMinutes(10),
        };
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        _http.DefaultRequestHeaders.Add("OData-MaxVersion", "4.0");
        _http.DefaultRequestHeaders.Add("OData-Version", "4.0");
    }

    /// <summary>
    /// Retries transient SSL/socket errors (e.g. "An existing connection was forcibly
    /// closed by the remote host") that periodically affect Dataverse calls.
    /// </summary>
    private sealed class RetryHandler : DelegatingHandler
    {
        private static readonly TimeSpan[] _backoff = { TimeSpan.FromMilliseconds(250), TimeSpan.FromMilliseconds(750), TimeSpan.FromSeconds(2) };

        public RetryHandler(HttpMessageHandler inner) : base(inner) { }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    return await base.SendAsync(request, ct).ConfigureAwait(false);
                }
                catch (HttpRequestException) when (attempt < _backoff.Length)
                {
                    await Task.Delay(_backoff[attempt], ct).ConfigureAwait(false);
                }
                catch (IOException) when (attempt < _backoff.Length)
                {
                    await Task.Delay(_backoff[attempt], ct).ConfigureAwait(false);
                }
            }
        }
    }

    /// <summary>
    /// Verifies the migration job exists and the caller can write to it.
    /// </summary>
    public async Task<JsonElement> GetMigrationJobAsync(Guid jobId, CancellationToken ct)
    {
        using var resp = await _http
            .GetAsync($"acp_migrationjobs({jobId:D})?$select=acp_migrationjobid,acp_name,acp_status,acp_targetsolutionname,acp_targetpublisherprefix", ct)
            .ConfigureAwait(false);
        await EnsureSuccessAsync(resp, ct).ConfigureAwait(false);
        await using var s = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var doc = await JsonDocument.ParseAsync(s, cancellationToken: ct).ConfigureAwait(false);
        return doc.RootElement.Clone();
    }

    /// <summary>
    /// Uploads a file (manifest or NDJSON) as a Dataverse annotation
    /// (Note) on the migration job. We use annotations rather than a dedicated
    /// file column so the schema stays simple in v1.
    /// </summary>
    public async Task UploadAnnotationAsync(
        Guid jobId,
        string fileName,
        string mimeType,
        Stream content,
        CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(fileName);
        ArgumentException.ThrowIfNullOrWhiteSpace(mimeType);
        ArgumentNullException.ThrowIfNull(content);

        using var ms = new MemoryStream();
        await content.CopyToAsync(ms, ct).ConfigureAwait(false);
        var b64 = Convert.ToBase64String(ms.ToArray());

        var payload =
            $"{{\"subject\":{JsonSerializer.Serialize(fileName)}," +
            $"\"filename\":{JsonSerializer.Serialize(fileName)}," +
            $"\"mimetype\":{JsonSerializer.Serialize(mimeType)}," +
            $"\"documentbody\":\"{b64}\"," +
            $"\"objectid_acp_migrationjob@odata.bind\":\"/acp_migrationjobs({jobId:D})\"}}";

        using var req = new HttpRequestMessage(HttpMethod.Post, "annotations")
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json"),
        };
        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        await EnsureSuccessAsync(resp, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Patches the migration job's custom migration status. Used to signal "manifest uploaded".
    /// </summary>
    public async Task SetJobStatusAsync(Guid jobId, int statusCode, CancellationToken ct)
    {
        var payload = $"{{\"acp_status\":{statusCode}}}";
        using var req = new HttpRequestMessage(HttpMethod.Patch, $"acp_migrationjobs({jobId:D})")
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json"),
        };
        req.Headers.Add("If-Match", "*");
        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        await EnsureSuccessAsync(resp, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Reads the named annotation's <c>documentbody</c> as decoded UTF-8 text, if present.
    /// Returns <c>null</c> when no annotation with that file name exists on the migration job.
    /// </summary>
    public async Task<string?> ReadAnnotationTextAsync(Guid jobId, string fileName, CancellationToken ct)
    {
        var annotationId = await FindAnnotationIdAsync(jobId, fileName, ct).ConfigureAwait(false);
        if (annotationId is null) return null;
        using var resp = await _http
            .GetAsync($"annotations({annotationId:D})?$select=documentbody", ct)
            .ConfigureAwait(false);
        await EnsureSuccessAsync(resp, ct).ConfigureAwait(false);
        await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
        if (!doc.RootElement.TryGetProperty("documentbody", out var body)) return null;
        var b64 = body.GetString();
        if (string.IsNullOrEmpty(b64)) return null;
        return Encoding.UTF8.GetString(Convert.FromBase64String(b64));
    }

    /// <summary>
    /// Appends a line to the given annotation by name. Creates the annotation if it
    /// doesn't exist yet, otherwise reads + rewrites the file content. Used by the
    /// migration log writer to surface progress to the hosted app.
    /// </summary>
    public async Task AppendAnnotationLineAsync(Guid jobId, string fileName, string mimeType, string line, CancellationToken ct)
    {
        var existing = await ReadAnnotationTextAsync(jobId, fileName, ct).ConfigureAwait(false);
        var content = (existing ?? string.Empty) + line + "\n";
        await ReplaceAnnotationTextAsync(jobId, fileName, mimeType, content, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Replaces (or creates) the named annotation with the given UTF-8 text body.
    /// </summary>
    public async Task ReplaceAnnotationTextAsync(Guid jobId, string fileName, string mimeType, string content, CancellationToken ct)
    {
        var annotationId = await FindAnnotationIdAsync(jobId, fileName, ct).ConfigureAwait(false);
        var b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(content));
        if (annotationId is null)
        {
            var payload =
                $"{{\"subject\":{JsonSerializer.Serialize(fileName)}," +
                $"\"filename\":{JsonSerializer.Serialize(fileName)}," +
                $"\"mimetype\":{JsonSerializer.Serialize(mimeType)}," +
                $"\"documentbody\":\"{b64}\"," +
                $"\"objectid_acp_migrationjob@odata.bind\":\"/acp_migrationjobs({jobId:D})\"}}";
            using var req = new HttpRequestMessage(HttpMethod.Post, "annotations")
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json"),
            };
            using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
            await EnsureSuccessAsync(resp, ct).ConfigureAwait(false);
        }
        else
        {
            var payload = $"{{\"documentbody\":\"{b64}\",\"mimetype\":{JsonSerializer.Serialize(mimeType)}}}";
            using var req = new HttpRequestMessage(HttpMethod.Patch, $"annotations({annotationId:D})")
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json"),
            };
            req.Headers.Add("If-Match", "*");
            using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
            await EnsureSuccessAsync(resp, ct).ConfigureAwait(false);
        }
    }

    private async Task<Guid?> FindAnnotationIdAsync(Guid jobId, string fileName, CancellationToken ct)
    {
        var safeName = fileName.Replace("'", "''");
        var url = $"annotations?$select=annotationid&$filter=_objectid_value eq {jobId:D} and filename eq '{Uri.EscapeDataString(safeName)}'&$top=1";
        using var resp = await _http.GetAsync(url, ct).ConfigureAwait(false);
        await EnsureSuccessAsync(resp, ct).ConfigureAwait(false);
        await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
        if (!doc.RootElement.TryGetProperty("value", out var arr) || arr.GetArrayLength() == 0) return null;
        var id = arr[0].GetProperty("annotationid").GetString();
        return Guid.TryParse(id, out var g) ? g : null;
    }

    /// <summary>
    /// Uploads bytes into a Dataverse File or Image column via the single-
    /// request PATCH pattern (supported up to ~128 MB for File and ~30 MB
    /// for Image; chunked upload would be needed for larger files).
    ///
    /// Returns the HTTP status text on failure so callers can surface it
    /// alongside other per-row migration errors. Honours <c>Retry-After</c>
    /// on 429/503 with capped exponential backoff.
    /// </summary>
    public async Task UploadBinaryColumnAsync(
        string entitySet,
        Guid recordId,
        string columnLogical,
        string fileName,
        string mimeType,
        byte[] bytes,
        CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(entitySet);
        ArgumentException.ThrowIfNullOrWhiteSpace(columnLogical);
        ArgumentNullException.ThrowIfNull(bytes);
        if (bytes.Length == 0) throw new ArgumentException("Bytes must not be empty.", nameof(bytes));

        var path = $"{entitySet}({recordId:D})/{columnLogical}";
        var safeName = SanitizeFileNameForHeader(fileName);

        for (var attempt = 0; ; attempt++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Patch, path);
            var content = new ByteArrayContent(bytes);
            content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream");
            req.Content = content;
            req.Headers.TryAddWithoutValidation("x-ms-file-name", safeName);
            req.Headers.TryAddWithoutValidation("If-None-Match", "null");

            var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
            if (resp.IsSuccessStatusCode) { resp.Dispose(); return; }

            if (((int)resp.StatusCode == 429 || (int)resp.StatusCode == 503) && attempt < 5)
            {
                var wait = ComputeBinaryRetryDelayMs(resp, attempt);
                resp.Dispose();
                await Task.Delay(wait, ct).ConfigureAwait(false);
                continue;
            }

            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            resp.Dispose();
            throw new HttpRequestException(
                $"PATCH {path} for File/Image upload returned {(int)resp.StatusCode}: {Truncate(body, 400)}");
        }
    }

    /// <summary>
    /// Creates an annotation (note) attachment on the given parent record.
    /// Used to migrate Access Attachment columns and any binary-typed column
    /// the user routed to NoteAttachment in MapStep. The annotation's
    /// <c>documentbody</c> carries base64-encoded bytes — fine for blobs up
    /// to a few MB but not recommended for large files (use a File column
    /// for those).
    /// </summary>
    public async Task CreateAnnotationForRecordAsync(
        string entityLogicalName,
        Guid recordId,
        string fileName,
        string mimeType,
        byte[] bytes,
        CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(entityLogicalName);
        ArgumentNullException.ThrowIfNull(bytes);
        if (bytes.Length == 0) throw new ArgumentException("Bytes must not be empty.", nameof(bytes));

        var b64 = Convert.ToBase64String(bytes);
        var entitySet = await ResolveEntitySetForAnnotationBindAsync(entityLogicalName, ct).ConfigureAwait(false);
        var payload =
            $"{{\"subject\":{JsonSerializer.Serialize(fileName)}," +
            $"\"filename\":{JsonSerializer.Serialize(fileName)}," +
            $"\"mimetype\":{JsonSerializer.Serialize(mimeType)}," +
            $"\"documentbody\":\"{b64}\"," +
            $"\"objectid_{entityLogicalName}@odata.bind\":\"/{entitySet}({recordId:D})\"}}";

        for (var attempt = 0; ; attempt++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "annotations")
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json"),
            };
            var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
            if (resp.IsSuccessStatusCode) { resp.Dispose(); return; }
            if (((int)resp.StatusCode == 429 || (int)resp.StatusCode == 503) && attempt < 5)
            {
                var wait = ComputeBinaryRetryDelayMs(resp, attempt);
                resp.Dispose();
                await Task.Delay(wait, ct).ConfigureAwait(false);
                continue;
            }
            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            resp.Dispose();
            throw new HttpRequestException(
                $"POST /annotations for {entityLogicalName}({recordId:D}) returned {(int)resp.StatusCode}: {Truncate(body, 400)}");
        }
    }

    private readonly Dictionary<string, string> _entitySetCache = new(StringComparer.OrdinalIgnoreCase);

    private async Task<string> ResolveEntitySetForAnnotationBindAsync(string entityLogicalName, CancellationToken ct)
    {
        if (_entitySetCache.TryGetValue(entityLogicalName, out var cached)) return cached;
        var url = $"EntityDefinitions(LogicalName='{entityLogicalName}')?$select=EntitySetName";
        using var resp = await _http.GetAsync(url, ct).ConfigureAwait(false);
        await EnsureSuccessAsync(resp, ct).ConfigureAwait(false);
        await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
        var setName = doc.RootElement.GetProperty("EntitySetName").GetString()
            ?? throw new InvalidOperationException($"No EntitySetName for {entityLogicalName}.");
        _entitySetCache[entityLogicalName] = setName;
        return setName;
    }

    private static int ComputeBinaryRetryDelayMs(HttpResponseMessage resp, int attempt)
    {
        if (resp.Headers.RetryAfter is { } h)
        {
            if (h.Delta is { } d) return Math.Clamp((int)d.TotalMilliseconds, 1_000, 30_000);
            if (h.Date is { } when) return Math.Clamp((int)Math.Max(0, (when.UtcDateTime - DateTime.UtcNow).TotalMilliseconds), 1_000, 30_000);
        }
        return Math.Min(1_000 * (int)Math.Pow(2, attempt), 30_000);
    }

    private static string SanitizeFileNameForHeader(string fileName)
    {
        // x-ms-file-name carries the file name in an HTTP header which only
        // accepts ASCII. Replace anything outside ASCII or that could break
        // header parsing (CR, LF, ", \) with '_'.
        var sb = new StringBuilder(fileName.Length);
        foreach (var c in fileName)
        {
            if (c < 0x20 || c > 0x7E || c == '"' || c == '\\') sb.Append('_');
            else sb.Append(c);
        }
        var s = sb.ToString();
        return string.IsNullOrWhiteSpace(s) ? "blob.bin" : s;
    }

    /// <summary>
    /// Sends an arbitrary <see cref="HttpRequestMessage"/> through the underlying
    /// client without inspecting the response. Used by the data loader so it can
    /// read 429/503 responses (with their <c>Retry-After</c> headers) directly
    /// instead of having them turned into thrown exceptions.
    /// </summary>
    public Task<HttpResponseMessage> SendRawAsync(HttpRequestMessage request, CancellationToken ct)
        => _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);

    /// <summary>
    /// Sends an arbitrary metadata request (POST/PATCH/GET) against the Dataverse Web API.
    /// Caller is responsible for path and JSON payload. Adds the
    /// <c>MSCRM.SolutionUniqueName</c> header so newly-created tables/columns land in
    /// the user's solution.
    /// </summary>
    public async Task<HttpResponseMessage> SendMetadataAsync(
        HttpMethod method,
        string path,
        string? jsonBody,
        string? solutionUniqueName,
        CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            using var req = new HttpRequestMessage(method, path);
            if (!string.IsNullOrEmpty(jsonBody))
            {
                req.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
            }
            if (!string.IsNullOrWhiteSpace(solutionUniqueName))
            {
                req.Headers.TryAddWithoutValidation("MSCRM.SolutionUniqueName", solutionUniqueName);
            }
            var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
            if (resp.IsSuccessStatusCode) return resp;

            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (ShouldRetryMetadata(resp, body, attempt))
            {
                var waitMs = ComputeMetadataRetryDelayMs(resp, attempt);
                resp.Dispose();
                await Task.Delay(waitMs, ct).ConfigureAwait(false);
                continue;
            }

            await EnsureSuccessAsync(resp, body).ConfigureAwait(false);
            return resp;
        }
    }

    private static bool ShouldRetryMetadata(HttpResponseMessage resp, string body, int attempt)
    {
        if (attempt >= 8) return false;
        if ((int)resp.StatusCode == 429) return true;
        return body.Contains("0x80071151", StringComparison.OrdinalIgnoreCase)
            || body.Contains("Cannot start the requested operation", StringComparison.OrdinalIgnoreCase)
            || body.Contains("another solution", StringComparison.OrdinalIgnoreCase);
    }

    private static int ComputeMetadataRetryDelayMs(HttpResponseMessage resp, int attempt)
    {
        if (resp.Headers.RetryAfter is { } header)
        {
            if (header.Delta is { } delta) return Math.Clamp((int)delta.TotalMilliseconds, 1_000, 60_000);
            if (header.Date is { } date)
            {
                var wait = (int)Math.Max(0, (date.UtcDateTime - DateTime.UtcNow).TotalMilliseconds);
                return Math.Clamp(wait, 1_000, 60_000);
            }
        }
        return attempt switch
        {
            0 => 10_000,
            1 => 20_000,
            2 => 30_000,
            3 => 45_000,
            _ => 60_000,
        };
    }

    public async Task<JsonDocument> GetJsonAsync(string path, CancellationToken ct)
    {
        using var resp = await _http.GetAsync(path, ct).ConfigureAwait(false);
        await EnsureSuccessAsync(resp, ct).ConfigureAwait(false);
        await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        return await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Returns true if a GET to the given path returns a 2xx response.
    /// </summary>
    public async Task<bool> ExistsAsync(string path, CancellationToken ct)
    {
        try
        {
            using var resp = await _http.GetAsync(path, ct).ConfigureAwait(false);
            return resp.IsSuccessStatusCode;
        }
        catch (HttpRequestException)
        {
            return false;
        }
    }

    /// <summary>
    /// Pulls a schema snapshot of every non-private user table (logical name, schema name,
    /// entity set name, display labels, columns) from the environment's EntityDefinitions
    /// metadata endpoint. The hosted Code App reads this from an annotation so it can
    /// offer existing-table mapping without needing per-table data source registrations.
    /// </summary>
    public async Task<string> FetchSchemaSnapshotJsonAsync(CancellationToken ct)
    {
        var tables = new List<JsonNode>();
        var url =
            "EntityDefinitions?$select=LogicalName,SchemaName,EntitySetName,DisplayName,DisplayCollectionName,IsCustomEntity,IsPrivate,IsIntersect,IsLogicalEntity" +
            "&$expand=Attributes($select=LogicalName,SchemaName,DisplayName,AttributeType,IsValidForCreate,IsPrimaryId,IsPrimaryName)";

        while (!string.IsNullOrEmpty(url))
        {
            ct.ThrowIfCancellationRequested();
            using var resp = await _http.GetAsync(url, ct).ConfigureAwait(false);
            await EnsureSuccessAsync(resp, ct).ConfigureAwait(false);
            await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            var page = (JsonObject?)JsonNode.Parse(stream)
                ?? throw new InvalidOperationException("Empty EntityDefinitions response.");

            if (page["value"] is JsonArray pageTables)
            {
                foreach (var node in pageTables)
                {
                    if (node is null) continue;
                    var simplified = SimplifyEntityNode(node);
                    if (simplified is not null) tables.Add(simplified);
                }
            }

            url = page["@odata.nextLink"]?.GetValue<string>() ?? string.Empty;
            // Dataverse returns absolute nextLinks; strip the base when possible so HttpClient uses BaseAddress.
            if (!string.IsNullOrEmpty(url) && url.StartsWith(_envUrl, StringComparison.OrdinalIgnoreCase))
            {
                url = url[(_envUrl.Length + "/api/data/v9.2/".Length)..];
            }
        }

        var snapshot = new JsonObject
        {
            ["capturedAt"] = DateTimeOffset.UtcNow.ToString("o"),
            ["environmentUrl"] = _envUrl,
            ["tables"] = new JsonArray([.. tables]),
        };
        return snapshot.ToJsonString();
    }

    private static JsonObject? SimplifyEntityNode(JsonNode raw)
    {
        if (raw is not JsonObject entity) return null;
        if (entity["IsPrivate"]?.GetValue<bool>() == true) return null;
        if (entity["IsIntersect"]?.GetValue<bool>() == true) return null;
        if (entity["IsLogicalEntity"]?.GetValue<bool>() == true) return null;
        var entitySetName = entity["EntitySetName"]?.GetValue<string>();
        if (string.IsNullOrEmpty(entitySetName)) return null;

        var attributes = entity["Attributes"] as JsonArray;
        var columns = new JsonArray();
        if (attributes is not null)
        {
            foreach (var attr in attributes)
            {
                if (attr is not JsonObject ao) continue;
                var attrType = ao["AttributeType"]?.GetValue<string>() ?? string.Empty;
                if (string.IsNullOrEmpty(attrType)) continue;
                // Skip virtual/synthetic types that aren't useful for column mapping.
                if (attrType is "Virtual" or "EntityName" or "ManagedProperty" or "CalendarRules"
                    or "PartyList" or "State" or "Status" or "Owner") continue;
                var isValidForCreate = ao["IsValidForCreate"]?.GetValue<bool>() ?? false;
                var isPrimaryId = ao["IsPrimaryId"]?.GetValue<bool>() ?? false;
                // Only include columns the wizard could actually target.
                if (!isValidForCreate && !isPrimaryId) continue;
                columns.Add(new JsonObject
                {
                    ["logicalName"] = ao["LogicalName"]?.GetValue<string>() ?? string.Empty,
                    ["schemaName"] = ao["SchemaName"]?.GetValue<string>() ?? string.Empty,
                    ["displayName"] = LocalizedLabel(ao["DisplayName"]),
                    ["attributeType"] = attrType,
                    ["isValidForCreate"] = ao["IsValidForCreate"]?.GetValue<bool>() ?? false,
                    ["isPrimaryId"] = ao["IsPrimaryId"]?.GetValue<bool>() ?? false,
                    ["isPrimaryName"] = ao["IsPrimaryName"]?.GetValue<bool>() ?? false,
                });
            }
        }

        return new JsonObject
        {
            ["logicalName"] = entity["LogicalName"]?.GetValue<string>() ?? string.Empty,
            ["schemaName"] = entity["SchemaName"]?.GetValue<string>() ?? string.Empty,
            ["entitySetName"] = entitySetName,
            ["displayName"] = LocalizedLabel(entity["DisplayName"]),
            ["displayCollectionName"] = LocalizedLabel(entity["DisplayCollectionName"]),
            ["isCustomEntity"] = entity["IsCustomEntity"]?.GetValue<bool>() ?? false,
            ["columns"] = columns,
        };
    }

    private static string LocalizedLabel(JsonNode? labelNode)
    {
        if (labelNode is not JsonObject obj) return string.Empty;
        return obj["UserLocalizedLabel"]?["Label"]?.GetValue<string>() ?? string.Empty;
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage resp, CancellationToken ct)
    {
        if (resp.IsSuccessStatusCode) return;
        var text = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        await EnsureSuccessAsync(resp, text).ConfigureAwait(false);
    }

    private static Task EnsureSuccessAsync(HttpResponseMessage resp, string text)
    {
        if (resp.IsSuccessStatusCode) return Task.CompletedTask;
        throw new HttpRequestException(
            $"Dataverse {(int)resp.StatusCode} {resp.ReasonPhrase}: {Truncate(text, 800)}");
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max] + "…";

    public void Dispose()
    {
        if (_disposed) return;
        _http.Dispose();
        _disposed = true;
        GC.SuppressFinalize(this);
    }
}
