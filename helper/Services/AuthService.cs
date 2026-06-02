using Microsoft.Identity.Client;
using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;

namespace AccessToPower.Helper.Services;

/// <summary>
/// MSAL-based interactive auth using the system browser.
/// - Tokens never touch disk; the helper does not configure a persistent cache.
/// - Public client (no secret).
/// - Targets the user's Dataverse environment only (no broad consent).
/// - Local-dev fallback: Azure CLI token pinned to the launch tenant.
/// </summary>
public sealed class AuthService
{
    // Microsoft-published public client ID for Power Platform tooling.
    // This is the same well-known client ID pac CLI uses.
    private const string PublicClientId = "51f81489-12ee-4a9e-aaae-a2591f45987d";

    private readonly string _environmentUrl;
    private readonly string _tenantId;

    public AuthService(string environmentUrl, string tenantId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(environmentUrl);
        ArgumentException.ThrowIfNullOrWhiteSpace(tenantId);

        _environmentUrl = environmentUrl.TrimEnd('/');
        _tenantId = tenantId;

    }

    /// <summary>
    /// Acquire an access token for the Dataverse environment. Tries silent first,
    /// then prompts the user to pick the intended account. Azure CLI is only a
    /// tenant-pinned local-dev fallback after interactive sign-in fails.
    /// </summary>
    public async Task<string> GetTokenAsync(CancellationToken ct)
    {
        var scope = $"{_environmentUrl}/.default";
        var scopes = new[] { scope };
        var authority = await ResolveAuthorityAsync(_environmentUrl, _tenantId, ct).ConfigureAwait(false);
        var tenantForFallback = TenantFromAuthority(authority) ?? _tenantId;
        var app = PublicClientApplicationBuilder
            .Create(PublicClientId)
            .WithAuthority(authority)
            .WithRedirectUri("http://localhost")
            .Build();

        var accounts = await app.GetAccountsAsync().ConfigureAwait(false);
        var account = accounts.FirstOrDefault();
        if (account is not null)
        {
            try
            {
                var silent = await app
                    .AcquireTokenSilent(scopes, account)
                    .ExecuteAsync(ct)
                    .ConfigureAwait(false);
                return silent.AccessToken;
            }
            catch (MsalUiRequiredException) { /* fall through */ }
            catch (MsalClientException) { /* broker hiccup — fall through */ }
        }

        try
        {
            var interactive = await app
                .AcquireTokenInteractive(scopes)
                .WithPrompt(Prompt.SelectAccount)
                .ExecuteAsync(ct)
                .ConfigureAwait(false);
            return interactive.AccessToken;
        }
        catch (MsalException interactiveError)
        {
            return await GetAzureCliTokenAsync(interactiveError, tenantForFallback, ct).ConfigureAwait(false);
        }
    }

    private static async Task<string> ResolveAuthorityAsync(string environmentUrl, string fallbackTenantId, CancellationToken ct)
    {
        var discovered = await TryDiscoverAuthorityAsync(environmentUrl, ct).ConfigureAwait(false);
        return discovered ?? BuildAuthority(environmentUrl, fallbackTenantId);
    }

    private static async Task<string?> TryDiscoverAuthorityAsync(string environmentUrl, CancellationToken ct)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            using var resp = await http.GetAsync($"{environmentUrl.TrimEnd('/')}/api/data/v9.2/WhoAmI", ct).ConfigureAwait(false);
            return ParseAuthority(resp.Headers.WwwAuthenticate);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return null;
        }
    }

    private static string? ParseAuthority(HttpHeaderValueCollection<AuthenticationHeaderValue> challenges)
    {
        foreach (var challenge in challenges)
        {
            var authorizationUri = GetChallengeParameter(challenge.Parameter, "authorization_uri");
            if (string.IsNullOrWhiteSpace(authorizationUri) ||
                !Uri.TryCreate(authorizationUri, UriKind.Absolute, out var uri))
            {
                continue;
            }

            var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (segments.Length == 0) continue;
            return $"{uri.Scheme}://{uri.Host}/{segments[0]}";
        }
        return null;
    }

    private static string? GetChallengeParameter(string? parameter, string name)
    {
        if (string.IsNullOrWhiteSpace(parameter)) return null;

        foreach (var part in parameter.Split(','))
        {
            var eq = part.IndexOf('=');
            if (eq <= 0) continue;
            var key = part[..eq].Trim();
            if (!string.Equals(key, name, StringComparison.OrdinalIgnoreCase)) continue;
            return part[(eq + 1)..].Trim().Trim('"');
        }
        return null;
    }

    private static string? TenantFromAuthority(string authority)
    {
        if (!Uri.TryCreate(authority, UriKind.Absolute, out var uri)) return null;
        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return segments.Length > 0 ? segments[0] : null;
    }

    private static string BuildAuthority(string environmentUrl, string tenantId)
    {
        var host = new Uri(environmentUrl).Host;
        var loginHost = host.EndsWith(".dynamics.us", StringComparison.OrdinalIgnoreCase) ||
            host.EndsWith(".appsplatform.us", StringComparison.OrdinalIgnoreCase)
                ? "https://login.microsoftonline.us"
                : "https://login.microsoftonline.com";
        return $"{loginHost}/{tenantId}";
    }

    private async Task<string> GetAzureCliTokenAsync(Exception interactiveError, string tenantId, CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = $"/d /c az account get-access-token --tenant \"{tenantId}\" --resource \"{_environmentUrl}\" --query accessToken -o tsv",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var p = Process.Start(psi)
            ?? throw new InvalidOperationException("Could not start Azure CLI. Install Azure CLI or sign in via browser.");
        var stdoutTask = p.StandardOutput.ReadToEndAsync(ct);
        var stderrTask = p.StandardError.ReadToEndAsync(ct);
        await p.WaitForExitAsync(ct).ConfigureAwait(false);

        var stdout = (await stdoutTask.ConfigureAwait(false)).Trim();
        var stderr = (await stderrTask.ConfigureAwait(false)).Trim();
        if (p.ExitCode != 0 || string.IsNullOrWhiteSpace(stdout))
        {
            throw new InvalidOperationException(
                "Browser sign-in failed and Azure CLI token fallback also failed. Sign in with the same account you use for Power Apps, " +
                $"or run `az login --tenant {tenantId}` and retry. Browser sign-in said: {interactiveError.Message}. Azure CLI said: {stderr}");
        }
        return stdout;
    }
}
