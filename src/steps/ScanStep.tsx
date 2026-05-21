import { useEffect, useRef, useState } from "react";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { HelperLaunchModal } from "../ui/HelperLaunchModal";
import { HelperWaitingPanel } from "../ui/HelperWaitingPanel";
import { Table, THead, TBody, TR, TH, TD } from "../ui/Table";
import { Badge } from "../ui/Badge";
import { getDataverseClient } from "../services/dataverseClient";
import type { AccessSchemaManifest } from "../types/manifest";

interface Props {
  migrationJobId: string | null;
  onManifestReady: (m: AccessSchemaManifest) => void;
  onBack: () => void;
}

const POLL_INTERVAL_MS = 4000;

export function ScanStep({ migrationJobId, onManifestReady, onBack }: Props) {
  const [manifest, setManifest] = useState<AccessSchemaManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [helperLaunched, setHelperLaunched] = useState(false);
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const pollTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, []);

  async function launchHelper() {
    if (!migrationJobId) return;
    setError(null);
    try {
      const client = getDataverseClient();
      const { environmentUrl, tenantId } = await client.getContext();
      const jobSnap = await client.getJob(migrationJobId);
      const url = new URL("accesstopower://launch");
      url.searchParams.set("jobId", migrationJobId);
      url.searchParams.set("env", environmentUrl);
      url.searchParams.set("tenant", tenantId);
      url.searchParams.set("name", jobSnap.name);
      setLaunchUrl(url.toString());
      setModalOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function startPolling() {
    if (pollTimer.current || !migrationJobId) return;
    setPolling(true);
    pollTimer.current = window.setInterval(async () => {
      try {
        const client = getDataverseClient();
        const m = await client.tryGetManifest(migrationJobId);
        if (m) {
          if (pollTimer.current) window.clearInterval(pollTimer.current);
          pollTimer.current = null;
          setManifest(m);
          setPolling(false);
          // Auto-advance once the helper finishes — no need to make the user
          // click Continue. They can step Back if they want to review.
          onManifestReady(m);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        if (pollTimer.current) window.clearInterval(pollTimer.current);
        pollTimer.current = null;
        setPolling(false);
      }
    }, POLL_INTERVAL_MS);
  }

  const totalRows = manifest?.tables.reduce((s, t) => s + t.rowCount, 0) ?? 0;

  return (
    <div className="space-y-5">
      {!manifest && (
        <Alert intent="info" title="Launch the desktop helper">
          The helper opens your <span className="font-mono">.accdb</span> file locally and uploads
          its schema and data to Dataverse — no product logic runs in the browser.
        </Alert>
      )}

      {polling && !manifest && (
        <HelperWaitingPanel
          title="Waiting for the helper"
          description="The helper is reading your .accdb file and uploading the manifest. This page updates automatically — no need to keep clicking."
          helperUrl={launchUrl}
          onRelaunch={launchUrl ? () => setModalOpen(true) : undefined}
        />
      )}

      {error && <Alert intent="error">{error}</Alert>}

      {manifest && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Tables" value={manifest.tables.length.toLocaleString()} />
            <Stat label="Rows" value={totalRows.toLocaleString()} />
            <Stat label="Relationships" value={manifest.relationships.length.toLocaleString()} />
          </div>

          <Card padding="none">
            <div className="px-5 pt-5 pb-3">
              <div className="text-base font-semibold text-ink-900">Discovered tables</div>
              <div className="text-sm text-ink-500 mt-0.5">
                Counts pulled from the Access database during scan.
              </div>
            </div>
            <Table>
              <THead>
                <TR>
                  <TH>Access table</TH>
                  <TH align="right">Columns</TH>
                  <TH align="right">Rows</TH>
                  <TH align="right">Issues</TH>
                </TR>
              </THead>
              <TBody>
                {manifest.tables.map((t) => {
                  const isProblem = (sev?: string) => (sev ?? "").toLowerCase() !== "info";
                  const issues =
                    (t.issues?.filter((i) => isProblem(i.severity)).length ?? 0) +
                    t.columns.reduce(
                      (n, c) =>
                        n + (c.issues?.filter((i) => isProblem(i.severity)).length ?? 0),
                      0,
                    );
                  return (
                    <TR key={t.name}>
                      <TD>{t.name}</TD>
                      <TD align="right">{t.columns.length}</TD>
                      <TD align="right">{t.rowCount.toLocaleString()}</TD>
                      <TD align="right">
                        {issues > 0 ? <Badge tone="warning">{issues}</Badge> : <span className="text-ink-400">0</span>}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </Card>
        </>
      )}

      <div className="flex items-center justify-between pt-2">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <div className="flex items-center gap-2">
          {!manifest && (
            <Button
              variant={helperLaunched ? "secondary" : "primary"}
              onClick={launchHelper}
              disabled={!migrationJobId}
            >
              {helperLaunched ? "Re-launch helper" : "Launch helper"}
            </Button>
          )}
          {manifest && (
            <Button variant="primary" onClick={() => onManifestReady(manifest)}>
              Continue
            </Button>
          )}
        </div>
      </div>

      <HelperLaunchModal
        open={modalOpen}
        mode="scan"
        helperUrl={launchUrl ?? ""}
        onClose={() => setModalOpen(false)}
        onLaunched={() => {
          setHelperLaunched(true);
          startPolling();
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="text-xs uppercase tracking-wide text-ink-500 font-medium">{label}</div>
      <div className="text-2xl font-semibold text-ink-900 mt-1">{value}</div>
    </Card>
  );
}
