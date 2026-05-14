using System.Windows;
using AccessToPower.Helper.Protocol;

namespace AccessToPower.Helper;

public partial class App : Application
{
    public LaunchArgs? Launch { get; private set; }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        try
        {
            Launch = LaunchArgs.Parse(e.Args);
        }
        catch (ArgumentException ex)
        {
            MessageBox.Show(
                $"This app must be launched from the Access to Power Code App.\n\nDetails: {ex.Message}",
                "Access to Power Helper",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
            Shutdown(2);
            return;
        }
    }
}
