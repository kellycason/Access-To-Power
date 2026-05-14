using Microsoft.Identity.Client;
using System.Diagnostics;

namespace AccessToPower.Helper.Services;

/// <summary>
/// MSAL-based interactive auth using the system browser.
/// - Tokens never touch disk; the helper does not configure a persistent cache.
/// - Public client (no secret).
/// - Targets the user's Dataverse environment only (no broad consent).
/// - Local-dev fallback: Azure CLI token, useful when national-cloud browser
///   profile routing blocks MSAL during pilot testing.
/// </summary>
public sealed class AuthService
{
    // Microsoft-published public client ID for Power Platform tooling.
    // This is the same well-known client ID pac CLI uses.
    private const string PublicClientId = "51f81489-12ee-4a9e-aaae-a2591f45987d";

    private readonly IPublicClientApplication _app;
    private readonly string _environmentUrl;
    private readonly string _tenantId;

    public AuthService(string environmentUrl, string tenantId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(environmentUrl);
        ArgumentException.ThrowIfNullOrWhiteSpace(tenantId);

        _environmentUrl = environmentUrl.TrimEnd('/');
        _tenantId = tenantId;

        _app = PublicClientApplicationBuilder
            .Create(PublicClientId)
            .WithAuthority($"https://login.microsoftonline.us/{tenantId}") // GCC authority
            .WithRedirectUri("http://localhost")
            .Build();
    }

    /// <summary>
    /// Acquire an access token for the Dataverse environment. Tries silent first,
    /// then Azure CLI (local-dev convenience for the pilot test loop).
    /// </summary>
    public async Task<string> GetTokenAsync(CancellationToken ct)
    {
        var scope = $"{_environmentUrl}/.default";
        var scopes = new[] { scope };

        var accounts = await _app.GetAccountsAsync().ConfigureAwait(false);
        var account = accounts.FirstOrDefault();
        if (account is not null)
        {
            try
            {
                var silent = await _app
                    .AcquireTokenSilent(scopes, account)
                    .ExecuteAsync(ct)
                    .ConfigureAwait(false);
                return silent.AccessToken;
            }
            catch (MsalUiRequiredException) { /* fall through */ }
            catch (MsalClientException) { /* broker hiccup — fall through */ }
        }

        return await GetAzureCliTokenAsync(ct).ConfigureAwait(false);
    }

    private async Task<string> GetAzureCliTokenAsync(CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = $"/d /c az account get-access-token --resource \"{_environmentUrl}\" --query accessToken -o tsv",
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
                "MSAL sign-in failed and Azure CLI token fallback also failed. Run `az login --tenant " +
                $"{_tenantId}` and retry. Azure CLI said: {stderr}");
        }
        return stdout;
    }
}
