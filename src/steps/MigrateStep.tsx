import { useState } from "react";
import {
  Button,
  Body1,
  Title3,
  ProgressBar,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  MessageBar,
  MessageBarBody,
  makeStyles,
} from "@fluentui/react-components";
import type { MigrationPlan } from "../types/manifest";

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "16px" },
  actions: { display: "flex", justifyContent: "space-between" },
});

interface Props {
  plan: MigrationPlan;
  migrationJobId: string | null;
  onCompleted: () => void;
  onBack: () => void;
}

type PhaseStatus = "pending" | "running" | "done" | "failed";
interface Phase {
  key: string;
  label: string;
  status: PhaseStatus;
}

/**
 * Step 4 — Migrate.
 *
 * In production, this flips the job status on acp_migrationjob and the
 * cloud flows do the work; the UI just subscribes to status changes. For
 * the scaffold, we simulate the four phases.
 */
export function MigrateStep({ plan, migrationJobId, onCompleted, onBack }: Props) {
  const styles = useStyles();
  const [phases, setPhases] = useState<Phase[]>([
    { key: "schema", label: "Create Dataverse schema", status: "pending" },
    { key: "load", label: "Load data (pass 1)", status: "pending" },
    { key: "lookups", label: "Resolve lookups (pass 2)", status: "pending" },
    { key: "validate", label: "Validate row counts", status: "pending" },
  ]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      for (let i = 0; i < phases.length; i++) {
        setPhases((cur) =>
          cur.map((p, idx) => (idx === i ? { ...p, status: "running" } : p)),
        );
        // TODO: replace with real Power Apps SDK / Dataverse calls that flip
        // the migration job status and wait for the cloud flows.
        await new Promise((r) => setTimeout(r, 600));
        setPhases((cur) =>
          cur.map((p, idx) => (idx === i ? { ...p, status: "done" } : p)),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const totalTables = plan.tableMappings.filter((t) => t.action === "Migrate").length;
  const totalRows = plan.manifest.tables.reduce((s, t) => s + t.rowCount, 0);
  const allDone = phases.every((p) => p.status === "done");

  return (
    <div className={styles.page}>
      <Title3>Migrate</Title3>
      <Body1>
        Job: <code>{migrationJobId ?? "(none)"}</code> — {totalTables} tables /{" "}
        {totalRows} rows
      </Body1>
      <Table size="small">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Phase</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {phases.map((p) => (
            <TableRow key={p.key}>
              <TableCell>{p.label}</TableCell>
              <TableCell>
                {p.status === "running" ? (
                  <ProgressBar />
                ) : (
                  <span>{p.status}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.actions}>
        <Button disabled={running} onClick={onBack}>
          Back
        </Button>
        {!allDone ? (
          <Button appearance="primary" disabled={running} onClick={run}>
            {running ? "Running…" : "Start migration"}
          </Button>
        ) : (
          <Button appearance="primary" onClick={onCompleted}>
            Continue
          </Button>
        )}
      </div>
    </div>
  );
}
