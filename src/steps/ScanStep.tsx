import { useEffect, useRef, useState } from "react";
import {
  Button,
  Body1,
  Title3,
  Spinner,
  MessageBar,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
} from "@fluentui/react-components";
import { getDataverseClient } from "../services/dataverseClient";
import type { AccessSchemaManifest } from "../types/manifest";

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "16px" },
  actions: { display: "flex", gap: "8px", justifyContent: "space-between" },
  rightGroup: { display: "flex", gap: "8px" },
});

interface Props {
  migrationJobId: string | null;
  onManifestReady: (m: AccessSchemaManifest) => void;
  onBack: () => void;
}

const POLL_INTERVAL_MS = 4000;

export function ScanStep({ migrationJobId, onManifestReady, onBack }: Props) {
  const styles = useStyles();
  const [manifest, setManifest] = useState<AccessSchemaManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [helperLaunched, setHelperLaunched] = useState(false);
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
      window.location.href = url.toString();
      setHelperLaunched(true);
      startPolling();
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
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        if (pollTimer.current) window.clearInterval(pollTimer.current);
        pollTimer.current = null;
        setPolling(false);
      }
    }, POLL_INTERVAL_MS);
  }

  async function checkNow() {
    if (!migrationJobId) return;
    setError(null);
    try {
      const client = getDataverseClient();
      const m = await client.tryGetManifest(migrationJobId);
      if (m) {
        if (pollTimer.current) {
          window.clearInterval(pollTimer.current);
          pollTimer.current = null;
        }
        setPolling(false);
        setManifest(m);
      } else {
        startPolling();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className={styles.page}>
      <Title3>Scan results</Title3>
      <Body1>
        Job: <code>{migrationJobId ?? "(none)"}</code>
      </Body1>

      {!manifest && !helperLaunched && (
        <MessageBar intent="info">
          <MessageBarBody>
            Launch the local helper to open your <code>.accdb</code> file and
            upload its schema and data to Dataverse.
          </MessageBarBody>
        </MessageBar>
      )}

      {polling && !manifest && (
        <Spinner label="Waiting for the helper to finish uploading…" />
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {manifest && (
        <>
          <Body1>
            Found <strong>{manifest.tables.length}</strong> tables /{" "}
            <strong>{manifest.tables.reduce((s, t) => s + t.rowCount, 0)}</strong>{" "}
            rows / <strong>{manifest.relationships.length}</strong> relationships.
          </Body1>
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Access table</TableHeaderCell>
                <TableHeaderCell>Columns</TableHeaderCell>
                <TableHeaderCell>Rows</TableHeaderCell>
                <TableHeaderCell>Issues</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {manifest.tables.map((t) => {
                // Only count Warning/Error in the headline number — Info
                // items (e.g. DateOnly detection) are informational and
                // shouldn't look like problems.
                const isProblem = (sev?: string) =>
                  (sev ?? "").toLowerCase() !== "info";
                const issues =
                  (t.issues?.filter((i) => isProblem(i.severity)).length ?? 0) +
                  t.columns.reduce(
                    (n, c) =>
                      n + (c.issues?.filter((i) => isProblem(i.severity)).length ?? 0),
                    0,
                  );
                return (
                  <TableRow key={t.name}>
                    <TableCell>{t.name}</TableCell>
                    <TableCell>{t.columns.length}</TableCell>
                    <TableCell>{t.rowCount}</TableCell>
                    <TableCell>{issues}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </>
      )}

      <div className={styles.actions}>
        <Button onClick={onBack}>Back</Button>
        <div className={styles.rightGroup}>
          {!manifest && (
            <>
              <Button
                appearance={helperLaunched ? "secondary" : "primary"}
                onClick={launchHelper}
                disabled={!migrationJobId}
              >
                {helperLaunched ? "Re-launch helper" : "Launch helper"}
              </Button>
              <Button onClick={checkNow} disabled={!migrationJobId}>
                Check now
              </Button>
            </>
          )}
          <Button
            appearance="primary"
            disabled={!manifest}
            onClick={() => manifest && onManifestReady(manifest)}
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
