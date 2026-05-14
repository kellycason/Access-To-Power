using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

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
        _http = new HttpClient
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
    /// Verifies the migration job exists and the caller can write to it.
    /// </summary>
    public async Task<JsonElement> GetMigrationJobAsync(Guid jobId, CancellationToken ct)
    {
        using var resp = await _http
            .GetAsync($"acp_migrationjobs({jobId:D})?$select=acp_migrationjobid,acp_name,statuscode", ct)
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

    private static async Task EnsureSuccessAsync(HttpResponseMessage resp, CancellationToken ct)
    {
        if (resp.IsSuccessStatusCode) return;
        var text = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
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
