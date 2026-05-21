import { useState } from "react";
import { helperInstallCommand, helperInstallerUrl } from "../services/helperInstaller";
import { Button } from "./Button";
import { Card } from "./Card";
import { Spinner } from "./Spinner";

interface Props {
  /** Title shown next to the spinner. */
  title: string;
  /** Subtext describing what we're waiting for. */
  description: string;
  /** The accesstopower:// URL we asked the browser to open. */
  helperUrl: string | null;
  /** Optional re-launch handler (re-trigger the protocol launch). */
  onRelaunch?: () => void;
}

/**
 * Inline panel that replaces the modal "Waiting for the helper" phase.
 * Shows the spinner, troubleshooting tips, and a copyable launch URL so the
 * user can recover if the browser blocked the protocol prompt.
 */
export function HelperWaitingPanel({ title, description, helperUrl, onRelaunch }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!helperUrl) return;
    try {
      await navigator.clipboard?.writeText(helperUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked; fall back to selection */
    }
  }

  return (
    <Card>
      <div className="flex items-start gap-3">
        <Spinner size={18} className="text-brand-600 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink-900">{title}</div>
          <p className="text-sm text-ink-600 mt-0.5">{description}</p>

          <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-700">
            <div className="font-semibold text-ink-900 mb-1">Helper didn't open?</div>
            <ul className="list-disc pl-5 space-y-0.5 text-ink-600">
              <li>Make sure you have the Access-To-Power Helper installed on this machine.</li>
              <li>Install command: <code className="font-mono bg-white px-1 rounded">{helperInstallCommand}</code></li>
              <li>If your browser blocked the dialog, copy the link below and paste it into a new tab.</li>
            </ul>
            {helperInstallerUrl && (
              <div className="mt-2">
                <Button size="sm" variant="subtle" onClick={() => window.open(helperInstallerUrl, "_blank", "noopener,noreferrer")}>
                  Download helper installer
                </Button>
              </div>
            )}
            {helperUrl && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  readOnly
                  value={helperUrl}
                  className="flex-1 font-mono text-[11px] bg-white border border-ink-200 rounded px-2 py-1 text-ink-700 min-w-0"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button size="sm" variant="secondary" onClick={() => void copy()}>
                  {copied ? "Copied!" : "Copy"}
                </Button>
                {onRelaunch && (
                  <Button size="sm" variant="secondary" onClick={onRelaunch}>
                    Re-launch
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
