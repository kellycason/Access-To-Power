using System.IO;
using System.Text.Json;
using System.Windows;
using AccessToPower.Helper.Models;
using AccessToPower.Helper.Services;
using Microsoft.Win32;

namespace AccessToPower.Helper;

public partial class MainWindow : Window
{
    private string? _accdbPath;
    private CancellationTokenSource? _cts;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        var launch = ((App)Application.Current).Launch;
        if (launch is null)
        {
            JobNameText.Text = "(no job \u2014 launch from the Code App)";
            PickButton.IsEnabled = false;
            return;
        }
        JobNameText.Text = launch.JobName;

        if (launch.Mode == Protocol.LaunchMode.SnapshotOnly)
        {
            PickButton.IsEnabled = false;
            StartButton.IsEnabled = false;
            FilePathText.Text = "(snapshot mode \u2014 no Access database needed)";
            _cts = new CancellationTokenSource();
            try
            {
                await RunSnapshotOnlyAsync(launch, _cts.Token).ConfigureAwait(true);
                StatusText.Text = "Snapshot uploaded. You can close this window and return to the Code App.";
                Progress.Value = 100;
                MessageBox.Show(this,
                    "Schema snapshot uploaded successfully. Switch back to the Code App and the existing-tables dropdown will populate.",
                    "Snapshot uploaded",
                    MessageBoxButton.OK,
                    MessageBoxImage.Information);
            }
            catch (OperationCanceledException)
            {
                StatusText.Text = "Cancelled.";
            }
            catch (Exception ex)
            {
                StatusText.Text = $"Snapshot failed: {ex.Message}";
                MessageBox.Show(this, ex.ToString(), "Snapshot failed", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
        else if (launch.Mode == Protocol.LaunchMode.Migrate)
        {
            PickButton.IsEnabled = false;
            StartButton.IsEnabled = false;
            FilePathText.Text = "(migrate mode \u2014 reading plan from the Code App)";
            _cts = new CancellationTokenSource();
            try
            {
                var overallStatus = await RunMigrateAsync(launch, _cts.Token).ConfigureAwait(true);
                Progress.Value = 100;
                if (string.Equals(overallStatus, "ok", StringComparison.OrdinalIgnoreCase))
                {
                    StatusText.Text = "Migration succeeded. Switch back to the Code App.";
                    MessageBox.Show(this,
                        "Migration succeeded. Switch back to the Code App for the validation report.",
                        "Migration succeeded",
                        MessageBoxButton.OK,
                        MessageBoxImage.Information);
                }
                else
                {
                    var statusText = string.IsNullOrWhiteSpace(overallStatus) ? "partial" : overallStatus;
                    StatusText.Text = $"Migration finished with issues ({statusText}). Switch back to the Code App.";
                    MessageBox.Show(this,
                        $"Migration finished with issues ({statusText}). Switch back to the Code App and review the validation report before using the data.",
                        "Migration needs review",
                        MessageBoxButton.OK,
                        MessageBoxImage.Warning);
                }
            }
            catch (OperationCanceledException)
            {
                StatusText.Text = "Cancelled.";
            }
            catch (Exception ex)
            {
                StatusText.Text = $"Migration failed: {ex.Message}";
                MessageBox.Show(this, ex.ToString(), "Migration failed", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
        else if (launch.Mode == Protocol.LaunchMode.GenerateMda)
        {
            PickButton.IsEnabled = false;
            StartButton.IsEnabled = false;
            FilePathText.Text = "(MDA mode \u2014 generating model-driven app)";
            _cts = new CancellationTokenSource();
            try
            {
                var result = await RunGenerateMdaAsync(launch, _cts.Token).ConfigureAwait(true);
                StatusText.Text = "Model-driven app ready. Switch back to the Code App.";
                Progress.Value = 100;
                MessageBox.Show(this,
                    $"Model-driven app generated.\n\nPlay URL:\n{result.PlayUrl}",
                    "App ready",
                    MessageBoxButton.OK,
                    MessageBoxImage.Information);
            }
            catch (OperationCanceledException)
            {
                StatusText.Text = "Cancelled.";
            }
            catch (Exception ex)
            {
                StatusText.Text = $"App generation failed: {ex.Message}";
                MessageBox.Show(this, ex.ToString(), "App generation failed", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
    }

    private async Task<string?> RunMigrateAsync(Protocol.LaunchArgs launch, CancellationToken ct)
    {
        void Report(int pct, string msg)
        {
            Dispatcher.Invoke(() =>
            {
                Progress.Value = pct;
                StatusText.Text = msg;
            });
        }

        // Orchestrator-level log writer. Runs BEFORE we have a DataverseClient
        // and is also reused by every phase transition so the hosted app can
        // tell exactly where we are if the helper window is closed mid-run.
        DataverseClient? logDv = null;
        Guid logJobId = launch.JobId;
        void OrchLog(string kind, string msg, string? severity = null)
        {
            if (logDv is null) return;
            var line = JsonSerializer.Serialize(new
            {
                kind,
                message = msg,
                severity,
                progress = (int?)null,
                entityLogicalName = (string?)null,
                timestamp = DateTimeOffset.UtcNow.ToString("o"),
            });
            try
            {
                logDv.AppendAnnotationLineAsync(logJobId, "migration-log.ndjson", "application/x-ndjson", line, ct)
                    .GetAwaiter().GetResult();
            }
            catch { /* logging is best-effort */ }
        }

        Report(2, "Signing in\u2026");
        var auth = new AuthService(launch.EnvironmentUrl, launch.TenantId);
        var token = await auth.GetTokenAsync(ct).ConfigureAwait(false);

        Report(6, "Loading migration job\u2026");
        using var dv = new DataverseClient(launch.EnvironmentUrl, token);
        logDv = dv;

        try
        {
            var job = await dv.GetMigrationJobAsync(launch.JobId, ct).ConfigureAwait(false);

        string publisherPrefix = job.TryGetProperty("acp_targetpublisherprefix", out var p) && p.ValueKind == JsonValueKind.String
            ? p.GetString()! : "acp";
        string solutionUniqueName = job.TryGetProperty("acp_targetsolutionname", out var s) && s.ValueKind == JsonValueKind.String
            ? s.GetString()! : "AccessToPowerMigration";

        Report(10, "Reading migration plan\u2026");
        var planJson = await dv.ReadAnnotationTextAsync(launch.JobId, "migration-plan.json", ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException("migration-plan.json not found on the job. Re-launch from the Map step.");
        var plan = JsonSerializer.Deserialize<MigrationPlan>(planJson)
            ?? throw new InvalidOperationException("Failed to parse migration-plan.json.");

        // Reset the log so the hosted app starts fresh.
        await dv.ReplaceAnnotationTextAsync(launch.JobId, "migration-log.ndjson", "application/x-ndjson", "", ct).ConfigureAwait(false);
        OrchLog("phase", $"Orchestrator started. Publisher='{publisherPrefix}', Solution='{solutionUniqueName}'.");

        Report(12, "Status \u2192 CreatingSchema");
        OrchLog("phase", $"Setting status \u2192 5 (CreatingSchema). Phase={launch.Phase}.");
        await dv.SetJobStatusAsync(launch.JobId, 5, ct).ConfigureAwait(false);

        var creator = new SchemaCreator(dv, ev =>
        {
            // Forward to UI.
            if (ev.Progress is int pct) Report(pct, ev.Message);
            else Dispatcher.Invoke(() => StatusText.Text = ev.Message);

            // Forward to the hosted app via NDJSON annotation.
            var line = JsonSerializer.Serialize(new
            {
                kind = ev.Kind,
                message = ev.Message,
                severity = ev.Severity,
                progress = ev.Progress,
                entityLogicalName = ev.EntityLogicalName,
                timestamp = DateTimeOffset.UtcNow.ToString("o"),
            });
            try
            {
                dv.AppendAnnotationLineAsync(launch.JobId, "migration-log.ndjson", "application/x-ndjson", line, ct)
                    .GetAwaiter().GetResult();
            }
            catch { /* logging is best-effort */ }
        });

        if (launch.Phase == Protocol.MigratePhase.DataOnly)
        {
            OrchLog("phase", "Phase=DataOnly: skipping schema creation; resuming at data load.");
        }
        else
        {
            await creator.RunAsync(plan, publisherPrefix, solutionUniqueName, ct).ConfigureAwait(false);
        }

        if (launch.Phase == Protocol.MigratePhase.SchemaOnly)
        {
            // Stop here so the user can inspect the new tables in the maker
            // portal before any rows are written. The wizard can re-launch
            // with phase=data to resume from the data load.
            Report(100, "Schema ready. Awaiting user approval to load data.");
            OrchLog("phase", "Phase=SchemaOnly: schema provisioned. Setting status \u2192 12 (SchemaReady). Re-launch with phase=data to load rows.");
            await dv.SetJobStatusAsync(launch.JobId, 12, ct).ConfigureAwait(false);
            return "schema-ready";
        }

        Report(40, "Schema ready. Advancing job to LoadingData…");
        OrchLog("phase", "Schema phase complete. Setting status \u2192 6 (LoadingData).");
        await dv.SetJobStatusAsync(launch.JobId, 6, ct).ConfigureAwait(false);

        // Shared progress callback used by load / resolve / validate so the
        // hosted app sees the same NDJSON log it sees from the schema phase.
        Action<ProgressEvent> forward = ev =>
        {
            if (ev.Progress is int pct) Report(pct, ev.Message);
            else Dispatcher.Invoke(() => StatusText.Text = ev.Message);

            var line = JsonSerializer.Serialize(new
            {
                kind = ev.Kind,
                message = ev.Message,
                severity = ev.Severity,
                progress = ev.Progress,
                entityLogicalName = ev.EntityLogicalName,
                timestamp = DateTimeOffset.UtcNow.ToString("o"),
            });
            try
            {
                dv.AppendAnnotationLineAsync(launch.JobId, "migration-log.ndjson", "application/x-ndjson", line, ct)
                    .GetAwaiter().GetResult();
            }
            catch { /* logging is best-effort */ }
        };

        // Pass 1: bulk row inserts (lookups left blank, FK→GUID map captured).
        var loader = new DataLoader(dv, forward);
        OrchLog("phase", "Starting Pass 1: DataLoader.RunAsync…");
        var idMap = await loader.RunAsync(launch.JobId, plan, ct).ConfigureAwait(false);

        Report(70, "Rows loaded. Advancing to ResolvingLookups…");
        OrchLog("phase", $"Pass 1 complete. IdMap has {idMap.Count} table(s). Setting status \u2192 7.");
        await dv.SetJobStatusAsync(launch.JobId, 7, ct).ConfigureAwait(false);

        // Pass 2: PATCH @odata.bind from the in-memory id map.
        var resolver = new LookupResolver(dv, forward);
        OrchLog("phase", "Starting Pass 2: LookupResolver.RunAsync…");
        var unresolved = await resolver.RunAsync(launch.JobId, plan, publisherPrefix, idMap, ct).ConfigureAwait(false);

        Report(90, "Lookups resolved. Advancing to Validating…");
        OrchLog("phase", $"Pass 2 complete. Unresolved={unresolved}. Setting status \u2192 8.");
        await dv.SetJobStatusAsync(launch.JobId, 8, ct).ConfigureAwait(false);

        // Pass 3: row-count compare and write migration-report.json.
        var validator = new Validator(dv, forward);
        OrchLog("phase", "Starting Pass 3: Validator.RunAsync…");
        var report = await validator.RunAsync(launch.JobId, plan, unresolved, ct).ConfigureAwait(false);

        // Final status: 9 = Succeeded, 10 = PartiallySucceeded, 11 = Failed.
        int finalStatus = report.OverallStatus switch
        {
            "ok" => 9,
            "error" => 11,
            _ => 10,
        };
        OrchLog("phase", $"Pass 3 complete. OverallStatus='{report.OverallStatus}'. Setting status \u2192 {finalStatus}.");
        await dv.SetJobStatusAsync(launch.JobId, finalStatus, ct).ConfigureAwait(false);
        Report(100, $"Migration finished: {report.OverallStatus}.");
        return report.OverallStatus;
        }
        catch (OperationCanceledException)
        {
            OrchLog("phase", "Operation cancelled.", severity: "warn");
            throw;
        }
        catch (Exception ex)
        {
            OrchLog("error", $"Orchestrator crashed: {ex.GetType().Name}: {ex.Message}", severity: "error");
            OrchLog("error", ex.StackTrace ?? "(no stack)", severity: "error");
            try { await dv.SetJobStatusAsync(launch.JobId, 11, ct).ConfigureAwait(false); } catch { /* best-effort */ }
            throw;
        }
    }

    private async Task<MdaResult> RunGenerateMdaAsync(Protocol.LaunchArgs launch, CancellationToken ct)
    {
        void Report(int pct, string msg)
        {
            Dispatcher.Invoke(() =>
            {
                Progress.Value = pct;
                StatusText.Text = msg;
            });
        }

        Report(2, "Signing in\u2026");
        var auth = new AuthService(launch.EnvironmentUrl, launch.TenantId);
        var token = await auth.GetTokenAsync(ct).ConfigureAwait(false);

        Report(6, "Loading migration job\u2026");
        using var dv = new DataverseClient(launch.EnvironmentUrl, token);
        var job = await dv.GetMigrationJobAsync(launch.JobId, ct).ConfigureAwait(false);

        string publisherPrefix = job.TryGetProperty("acp_targetpublisherprefix", out var p) && p.ValueKind == JsonValueKind.String
            ? p.GetString()! : "acp";
        string solutionUniqueName = job.TryGetProperty("acp_targetsolutionname", out var s) && s.ValueKind == JsonValueKind.String
            ? s.GetString()! : "AccessToPowerMigration";
        string jobName = job.TryGetProperty("acp_name", out var n) && n.ValueKind == JsonValueKind.String
            ? n.GetString()! : launch.JobName;

        Report(10, "Reading migration plan\u2026");
        var planJson = await dv.ReadAnnotationTextAsync(launch.JobId, "migration-plan.json", ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException("migration-plan.json not found on the job. Re-run the migration first.");
        var plan = JsonSerializer.Deserialize<MigrationPlan>(planJson)
            ?? throw new InvalidOperationException("Failed to parse migration-plan.json.");

        await dv.ReplaceAnnotationTextAsync(launch.JobId, "mda-log.ndjson", "application/x-ndjson", "", ct).ConfigureAwait(false);

        Action<ProgressEvent> forward = ev =>
        {
            if (ev.Progress is int pct) Report(pct, ev.Message);
            else Dispatcher.Invoke(() => StatusText.Text = ev.Message);

            var line = JsonSerializer.Serialize(new
            {
                kind = ev.Kind,
                message = ev.Message,
                severity = ev.Severity,
                progress = ev.Progress,
                entityLogicalName = ev.EntityLogicalName,
                timestamp = DateTimeOffset.UtcNow.ToString("o"),
            });
            try
            {
                dv.AppendAnnotationLineAsync(launch.JobId, "mda-log.ndjson", "application/x-ndjson", line, ct)
                    .GetAwaiter().GetResult();
            }
            catch { /* logging is best-effort */ }
        };

        var creator = new ModelDrivenAppCreator(dv, forward);
        var result = await creator.RunAsync(launch.JobId, plan, publisherPrefix, solutionUniqueName, $"{jobName} App", ct).ConfigureAwait(false);

        var resultJson = JsonSerializer.Serialize(new
        {
            appModuleId = result.AppModuleId.ToString("D"),
            appUniqueName = result.AppUniqueName,
            playUrl = result.PlayUrl,
            generatedAt = DateTimeOffset.UtcNow.ToString("o"),
        });
        await dv.ReplaceAnnotationTextAsync(launch.JobId, "mda-result.json", "application/json", resultJson, ct).ConfigureAwait(false);

        return result;
    }

    private static async Task RunSnapshotOnlyAsyncStatic(Protocol.LaunchArgs launch, Action<int, string> report, CancellationToken ct)
    {
        report(5, "Signing in\u2026");
        var auth = new AuthService(launch.EnvironmentUrl, launch.TenantId);
        var token = await auth.GetTokenAsync(ct).ConfigureAwait(false);

        report(20, "Verifying migration job\u2026");
        using var dv = new DataverseClient(launch.EnvironmentUrl, token);
        _ = await dv.GetMigrationJobAsync(launch.JobId, ct).ConfigureAwait(false);

        report(45, "Capturing Dataverse schema snapshot\u2026");
        var snapshotJson = await dv.FetchSchemaSnapshotJsonAsync(ct).ConfigureAwait(false);

        report(85, "Uploading snapshot\u2026");
        await using var snapStream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(snapshotJson));
        await dv.UploadAnnotationAsync(launch.JobId, "schema-snapshot.json", "application/json", snapStream, ct).ConfigureAwait(false);
    }

    private Task RunSnapshotOnlyAsync(Protocol.LaunchArgs launch, CancellationToken ct)
    {
        return RunSnapshotOnlyAsyncStatic(launch, (pct, msg) => Dispatcher.Invoke(() =>
        {
            Progress.Value = pct;
            StatusText.Text = msg;
        }), ct);
    }

    private void OnPickClicked(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFileDialog
        {
            Title = "Choose an Access database",
            Filter = "Access databases (*.accdb;*.mdb)|*.accdb;*.mdb",
            CheckFileExists = true,
            Multiselect = false,
        };
        if (dlg.ShowDialog(this) == true)
        {
            _accdbPath = dlg.FileName;
            FilePathText.Text = _accdbPath;
            StartButton.IsEnabled = true;
            StatusText.Text = "";
        }
    }

    private void OnCloseClicked(object sender, RoutedEventArgs e)
    {
        _cts?.Cancel();
        Close();
    }

    private async void OnStartClicked(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrEmpty(_accdbPath)) return;
        var launch = ((App)Application.Current).Launch
            ?? throw new InvalidOperationException("Missing launch args.");

        PickButton.IsEnabled = false;
        StartButton.IsEnabled = false;
        _cts = new CancellationTokenSource();
        var ct = _cts.Token;

        try
        {
            await RunAsync(launch, _accdbPath, ct).ConfigureAwait(true);
            StatusText.Text = "Upload complete. You can close this window and return to the Code App.";
            Progress.Value = 100;
        }
        catch (OperationCanceledException)
        {
            StatusText.Text = "Cancelled.";
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Failed: {ex.Message}";
            MessageBox.Show(this, ex.ToString(), "Upload failed", MessageBoxButton.OK, MessageBoxImage.Error);
            PickButton.IsEnabled = true;
            StartButton.IsEnabled = true;
        }
    }

    private async Task RunAsync(Protocol.LaunchArgs launch, string accdbPath, CancellationToken ct)
    {
        void Report(int pct, string msg)
        {
            Dispatcher.Invoke(() =>
            {
                Progress.Value = pct;
                StatusText.Text = msg;
            });
        }

        Report(2, "Signing in…");
        var auth = new AuthService(launch.EnvironmentUrl, launch.TenantId);
        var token = await auth.GetTokenAsync(ct).ConfigureAwait(false);

        Report(8, "Verifying migration job…");
        using var dv = new DataverseClient(launch.EnvironmentUrl, token);
        _ = await dv.GetMigrationJobAsync(launch.JobId, ct).ConfigureAwait(false);

        Report(12, "Reading Access schema…");
        using var reader = new AccessReader(accdbPath);
        var tableNames = reader.GetUserTableNames();

        var manifest = new AccessSchemaManifest
        {
            MigrationJobId = launch.JobId.ToString("D"),
            JobName = launch.JobName,
            SourcePath = accdbPath,
            SourceSize = new FileInfo(accdbPath).Length,
        };

        // Surface linked tables as manifest-level warnings so the customer
        // sees them before mapping — their rows live elsewhere and won't
        // migrate as if they were native (guide Part 12 / 13).
        var linked = reader.GetLinkedTableNames();
        if (linked.Count > 0)
        {
            manifest.Issues ??= new();
            foreach (var lt in linked)
            {
                manifest.Issues.Add(new ManifestIssue
                {
                    Severity = "Warning",
                    Category = "LinkedTable",
                    Message = $"Table '{lt}' is a linked table (data lives in an external source) and will not be migrated.",
                    Table = lt,
                });
            }
        }

        // Staging directory under LOCALAPPDATA, scoped per job.
        var staging = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "AccessToPower", "jobs", launch.JobId.ToString("D"));
        Directory.CreateDirectory(staging);

        try
        {
            // Pass A: read schema + sample for every table first. Streaming
            // rows must wait until after DAO enrichment so columns flagged
            // as multi-value or attachment can be skipped at write time
            // (ACE OLEDB would otherwise return chapter rowsets / nulls).
            var schemas = new List<AccessTable>(tableNames.Count);
            for (var i = 0; i < tableNames.Count; i++)
            {
                ct.ThrowIfCancellationRequested();
                var name = tableNames[i];
                var pct = 15 + (int)(35.0 * i / Math.Max(1, tableNames.Count));
                Report(pct, $"Reading schema {i + 1} of {tableNames.Count}: {name}");

                var schema = reader.ReadTableSchema(name);
                reader.EnrichColumnsFromSamples(schema);
                schemas.Add(schema);
                manifest.Tables.Add(schema);
            }

            manifest.Relationships.AddRange(reader.ReadRelationships());

            // DAO pass: pick up things ACE OLEDB can't see — value lists for
            // Lookup-Wizard columns (→ Dataverse Choice) and multi-value /
            // attachment fields (→ flagged as dropped in the report).
            Report(52, "Reading lookup metadata…");
            DaoEnricher.Enrich(manifest, accdbPath, msg => System.Diagnostics.Debug.WriteLine($"[DaoEnricher] {msg}"));

            // Pass B: stream rows per table now that DataType has been
            // upgraded to "Multivalue" / "Attachment" where appropriate.
            for (var i = 0; i < schemas.Count; i++)
            {
                ct.ThrowIfCancellationRequested();
                var schema = schemas[i];
                var pct = 55 + (int)(20.0 * i / Math.Max(1, schemas.Count));
                Report(pct, $"Streaming rows {i + 1} of {schemas.Count}: {schema.Name}");

                var rowsFileName = SafeFileName(schema.Name) + ".ndjson";
                schema.RowsFile = rowsFileName;
                var rowsPath = Path.Combine(staging, rowsFileName);

                await using (var fs = new FileStream(rowsPath, FileMode.Create, FileAccess.Write, FileShare.None))
                await using (var sw = new StreamWriter(fs, System.Text.Encoding.UTF8))
                {
                    foreach (var row in reader.StreamRows(schema))
                    {
                        ct.ThrowIfCancellationRequested();
                        var line = JsonSerializer.Serialize(row);
                        await sw.WriteLineAsync(line).ConfigureAwait(false);
                    }
                }
                schema.RowsSha256 = await Sha256Async(rowsPath, ct).ConfigureAwait(false);
            }

            Report(78, "Uploading manifest…");
            var manifestJson = JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = false });
            await using (var ms = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(manifestJson)))
            {
                await dv.UploadAnnotationAsync(launch.JobId, "manifest.json", "application/json", ms, ct).ConfigureAwait(false);
            }

            Report(80, "Capturing Dataverse schema snapshot…");
            try
            {
                var snapshotJson = await dv.FetchSchemaSnapshotJsonAsync(ct).ConfigureAwait(false);
                await using var snapStream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(snapshotJson));
                await dv.UploadAnnotationAsync(launch.JobId, "schema-snapshot.json", "application/json", snapStream, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                // Snapshot is a convenience for the Map step. Don't fail the whole upload.
                Report(80, $"Schema snapshot skipped: {ex.Message}");
            }

            for (var i = 0; i < manifest.Tables.Count; i++)
            {
                ct.ThrowIfCancellationRequested();
                var t = manifest.Tables[i];
                var pct = 80 + (int)(18.0 * i / Math.Max(1, manifest.Tables.Count));
                Report(pct, $"Uploading rows {i + 1} of {manifest.Tables.Count}: {t.Name}");
                var path = Path.Combine(staging, t.RowsFile);
                await using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
                await dv.UploadAnnotationAsync(launch.JobId, t.RowsFile, "application/x-ndjson", fs, ct).ConfigureAwait(false);
            }

            Report(99, "Marking job ready for review…");
            // Status 2 = "ManifestUploaded" by convention. Cloud flow on the job
            // table watches for this and proceeds.
            await dv.SetJobStatusAsync(launch.JobId, 2, ct).ConfigureAwait(false);
        }
        finally
        {
            // Best-effort cleanup of staged NDJSON files (they're already in Dataverse).
            try { Directory.Delete(staging, recursive: true); } catch { /* ignore */ }
        }
    }

    private static string SafeFileName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var clean = new string(name.Select(c => invalid.Contains(c) ? '_' : c).ToArray());
        return string.IsNullOrWhiteSpace(clean) ? "table" : clean;
    }

    private static async Task<string> Sha256Async(string path, CancellationToken ct)
    {
        await using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var sha = System.Security.Cryptography.SHA256.Create();
        var hash = await sha.ComputeHashAsync(fs, ct).ConfigureAwait(false);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
