import { useState } from "react";
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
import { MockManifestSource } from "../services/manifestSource";
import type { AccessSchemaManifest } from "../types/manifest";

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "16px" },
  actions: { display: "flex", gap: "8px", justifyContent: "space-between" },
});

interface Props {
  migrationJobId: string | null;
  onManifestReady: (m: AccessSchemaManifest) => void;
  onBack: () => void;
}

/**
 * Step 2 — Scan.
 *
 * The Code App polls Dataverse for the manifest file column on
 * acp_migrationjob. For local dev, MockManifestSource serves a fixture from
 * /fixtures so the UI is fully usable before the helper exists.
 */
export function ScanStep({ migrationJobId, onManifestReady, onBack }: Props) {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [manifest, setManifest] = useState<AccessSchemaManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadMock() {
    setBusy(true);
    setError(null);
    try {
      const source = new MockManifestSource();
      const m = await source.load();
      setManifest(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <Title3>Scan results</Title3>
      <Body1>
        Job: <code>{migrationJobId ?? "(none)"}</code>
      </Body1>
      {!manifest && !busy && (
        <MessageBar intent="info">
          <MessageBarBody>
            Waiting for the local helper to upload its manifest. For local
            development, load the bundled Northwind fixture.
          </MessageBarBody>
        </MessageBar>
      )}
      {busy && <Spinner label="Loading manifest…" />}
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
            rows / <strong>{manifest.relationships.length}</strong>{" "}
            relationships.
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
                const issues = t.columns.reduce(
                  (n, c) => n + (c.issues?.length ?? 0),
                  t.issues?.length ?? 0,
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
        <div style={{ display: "flex", gap: 8 }}>
          <Button onClick={loadMock} disabled={busy}>
            Load mock manifest
          </Button>
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
