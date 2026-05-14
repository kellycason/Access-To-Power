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

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        var launch = ((App)Application.Current).Launch;
        if (launch is null)
        {
            JobNameText.Text = "(no job — launch from the Code App)";
            PickButton.IsEnabled = false;
            return;
        }
        JobNameText.Text = launch.JobName;
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

        // Staging directory under LOCALAPPDATA, scoped per job.
        var staging = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "AccessToPower", "jobs", launch.JobId.ToString("D"));
        Directory.CreateDirectory(staging);

        try
        {
            for (var i = 0; i < tableNames.Count; i++)
            {
                ct.ThrowIfCancellationRequested();
                var name = tableNames[i];
                var pct = 15 + (int)(60.0 * i / Math.Max(1, tableNames.Count));
                Report(pct, $"Reading table {i + 1} of {tableNames.Count}: {name}");

                var schema = reader.ReadTableSchema(name);
                var rowsFileName = SafeFileName(name) + ".ndjson";
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
                manifest.Tables.Add(schema);
            }

            manifest.Relationships.AddRange(reader.ReadRelationships());

            Report(78, "Uploading manifest…");
            var manifestJson = JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = false });
            await using (var ms = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(manifestJson)))
            {
                await dv.UploadAnnotationAsync(launch.JobId, "manifest.json", "application/json", ms, ct).ConfigureAwait(false);
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
