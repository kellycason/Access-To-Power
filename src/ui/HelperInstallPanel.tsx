import { helperInstallCommand, helperInstallerUrl, helperInstallerVersion } from "../services/helperInstaller";
import { Alert } from "./Alert";
import { Button } from "./Button";
import { Card, CardHeader } from "./Card";

export function HelperInstallPanel() {
  return (
    <Card>
      <CardHeader
        title="Desktop helper"
        description="Install this once on each workstation that will scan Access databases."
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
        <InstallStep index="1" title="Download" detail="Get the signed helper package from your software portal." />
        <InstallStep index="2" title="Install" detail="Run the installer script from the extracted package." />
        <InstallStep index="3" title="Launch" detail="The app opens the helper through accesstopower:// when you scan or migrate." />
      </div>

      <div className="mt-4 rounded-xl border border-ink-200 bg-ink-50 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Install command</div>
        <code className="mt-1 block text-xs text-ink-800 break-all">{helperInstallCommand}</code>
      </div>

      {helperInstallerUrl ? (
        <div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-sm text-ink-600">
            Current helper package: <span className="font-medium text-ink-900">v{helperInstallerVersion}</span>
          </div>
          <Button type="button" variant="primary" onClick={() => window.open(helperInstallerUrl, "_blank", "noopener,noreferrer")}>
            Download helper
          </Button>
        </div>
      ) : (
        <Alert intent="warning" title="Installer URL not configured" className="mt-4">
          Ask your admin to host the helper zip built by <code>scripts/package-helper-installer.ps1</code> and set <code>VITE_HELPER_INSTALLER_URL</code> before publishing this app.
        </Alert>
      )}
    </Card>
  );
}

function InstallStep({ index, title, detail }: { index: string; title: string; detail: string }) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-3">
      <div className="flex items-center gap-2">
        <div className="h-6 w-6 rounded-full bg-brand-600 text-white text-xs font-semibold flex items-center justify-center">
          {index}
        </div>
        <div className="font-semibold text-ink-900">{title}</div>
      </div>
      <div className="mt-2 text-xs leading-5 text-ink-600">{detail}</div>
    </div>
  );
}