namespace AccessToPower.Helper.Protocol;

/// <summary>
/// Parses and validates command-line arguments coming from the
/// accesstopower:// protocol handler. All inputs are treated as untrusted.
/// </summary>
public sealed record LaunchArgs
{
    public required Guid JobId { get; init; }
    public required string EnvironmentUrl { get; init; }
    public required string TenantId { get; init; }
    public required string JobName { get; init; }
    public LaunchMode Mode { get; init; } = LaunchMode.FullUpload;

    /// <summary>
    /// When Mode is <see cref="LaunchMode.Migrate"/>, controls which phases run.
    /// Ignored for other modes.
    /// </summary>
    public MigratePhase Phase { get; init; } = MigratePhase.Full;

    /// <summary>
    /// Accepts either:
    ///   accesstopower://launch?jobId={guid}&env=https://...&tenant={guid}&name=...&mode=snapshot
    /// or positional CLI args:
    ///   AccessToPowerHelper.exe --job-id {guid} --env https://... --tenant {guid} --name ... [--mode snapshot]
    /// </summary>
    public static LaunchArgs Parse(string[] argv)
    {
        ArgumentNullException.ThrowIfNull(argv);

        // Single arg starting with the scheme = protocol handler invocation.
        if (argv.Length == 1 && argv[0].StartsWith("accesstopower://", StringComparison.OrdinalIgnoreCase))
        {
            return ParseUri(argv[0]);
        }
        return ParseFlags(argv);
    }

    private static LaunchArgs ParseUri(string raw)
    {
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri))
            throw new ArgumentException("Malformed protocol URL.");

        if (!string.Equals(uri.Scheme, "accesstopower", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Unexpected URI scheme.");

        var q = ParseQuery(uri.Query);
        return Build(
            jobId: q.GetValueOrDefault("jobId"),
            envUrl: q.GetValueOrDefault("env"),
            tenant: q.GetValueOrDefault("tenant"),
            name: q.GetValueOrDefault("name"),
            mode: q.GetValueOrDefault("mode"),
            phase: q.GetValueOrDefault("phase"));
    }

    private static Dictionary<string, string> ParseQuery(string query)
    {
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrEmpty(query)) return dict;
        var s = query.StartsWith('?') ? query[1..] : query;
        foreach (var part in s.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = part.IndexOf('=');
            if (eq < 0) continue;
            var k = Uri.UnescapeDataString(part[..eq]);
            var v = Uri.UnescapeDataString(part[(eq + 1)..]);
            dict[k] = v;
        }
        return dict;
    }

    private static LaunchArgs ParseFlags(string[] argv)
    {
        string? jobId = null, envUrl = null, tenant = null, name = null, mode = null, phase = null;
        for (var i = 0; i < argv.Length - 1; i++)
        {
            switch (argv[i])
            {
                case "--job-id": jobId = argv[++i]; break;
                case "--env": envUrl = argv[++i]; break;
                case "--tenant": tenant = argv[++i]; break;
                case "--name": name = argv[++i]; break;
                case "--mode": mode = argv[++i]; break;
                case "--phase": phase = argv[++i]; break;
            }
        }
        return Build(jobId, envUrl, tenant, name, mode, phase);
    }

    private static LaunchArgs Build(string? jobId, string? envUrl, string? tenant, string? name, string? mode, string? phase = null)
    {
        if (!Guid.TryParse(jobId, out var jid) || jid == Guid.Empty)
            throw new ArgumentException("jobId must be a non-empty GUID.");
        if (!Guid.TryParse(tenant, out var tid) || tid == Guid.Empty)
            throw new ArgumentException("tenant must be a non-empty GUID.");
        if (string.IsNullOrWhiteSpace(envUrl) ||
            !Uri.TryCreate(envUrl, UriKind.Absolute, out var envUri) ||
            envUri.Scheme != Uri.UriSchemeHttps)
            throw new ArgumentException("env must be an https URL.");

        // Reject anything that isn't a Dataverse hostname. Allow both commercial
        // (*.dynamics.com) and US Gov (*.crm9.dynamics.com / *.dynamics.us /
        // *.appsplatform.us) tenancies.
        var host = envUri.Host;
        var allowed =
            host.EndsWith(".dynamics.com", StringComparison.OrdinalIgnoreCase) ||
            host.EndsWith(".dynamics.us", StringComparison.OrdinalIgnoreCase) ||
            host.EndsWith(".appsplatform.us", StringComparison.OrdinalIgnoreCase);
        if (!allowed)
            throw new ArgumentException("env hostname is not a recognized Dataverse domain.");

        // Length cap for display name.
        var safeName = string.IsNullOrWhiteSpace(name) ? "Migration job" : name.Trim();
        if (safeName.Length > 200) safeName = safeName[..200];

        return new LaunchArgs
        {
            JobId = jid,
            EnvironmentUrl = envUri.GetLeftPart(UriPartial.Authority),
            TenantId = tid.ToString("D"),
            JobName = safeName,
            Mode = string.Equals(mode, "snapshot", StringComparison.OrdinalIgnoreCase)
                ? LaunchMode.SnapshotOnly
                : string.Equals(mode, "migrate", StringComparison.OrdinalIgnoreCase)
                    ? LaunchMode.Migrate
                    : LaunchMode.FullUpload,
            Phase = string.Equals(phase, "schema", StringComparison.OrdinalIgnoreCase)
                ? MigratePhase.SchemaOnly
                : string.Equals(phase, "data", StringComparison.OrdinalIgnoreCase)
                    ? MigratePhase.DataOnly
                    : MigratePhase.Full,
        };
    }
}

public enum LaunchMode
{
    /// <summary>Pick an Access database and upload manifest + rows + schema snapshot.</summary>
    FullUpload,
    /// <summary>Skip the Access pick. Only capture and upload the Dataverse schema snapshot.</summary>
    SnapshotOnly,
    /// <summary>Read the approved migration plan annotation and create schema/data in Dataverse.</summary>
    Migrate,
}

/// <summary>
/// Sub-mode for <see cref="LaunchMode.Migrate"/>. Lets callers split a
/// migration into a schema-only provisioning step and a separate data-load
/// step so they can inspect the new tables before any rows are written.
/// </summary>
public enum MigratePhase
{
    /// <summary>Schema + data + lookups + validation in a single pass.</summary>
    Full,
    /// <summary>Provision the schema (Pass 1 only), then stop so the user can review.</summary>
    SchemaOnly,
    /// <summary>Skip schema. Resume from data load through validation. Assumes schema already exists.</summary>
    DataOnly,
}
