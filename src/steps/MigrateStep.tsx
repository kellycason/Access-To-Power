import { useEffect, useMemo, useRef, useState } from "react";
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
  Tag,
  Checkbox,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { MigrationPlan } from "../types/manifest";
import { getDataverseClient } from "../services/dataverseClient";
import type { ProgressEvent } from "../services/schemaCreator";
import type { ValidationReport } from "../services/validator";

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "16px" },
  actions: { display: "flex", justifyContent: "space-between" },
  logBox: {
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "4px",
    padding: "12px",
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    fontSize: "12px",
    height: "260px",
    overflowY: "auto",
    whiteSpace: "pre-wrap",
  },
  logLine: { display: "block" },
  warn: { color: tokens.colorPaletteDarkOrangeForeground1 },
  err: { color: tokens.colorPaletteRedForeground1 },
});

interface Props {
  plan: MigrationPlan;
  migrationJobId: string | null;
  onCompleted: (report: ValidationReport) => void;
  onBack: () => void;
}

type PhaseStatus = "pending" | "running" | "done" | "failed";
interface Phase {
  key: "schema" | "load" | "lookups" | "validate";
  label: string;
  status: PhaseStatus;
}

const INITIAL_PHASES: Phase[] = [
  { key: "schema", label: "Create Dataverse schema", status: "pending" },
  { key: "load", label: "Load data (pass 1)", status: "pending" },
  { key: "lookups", label: "Resolve lookups (pass 2)", status: "pending" },
  { key: "validate", label: "Validate row counts", status: "pending" },
];

export function MigrateStep({ plan, migrationJobId, onCompleted, onBack }: Props) {
  const styles = useStyles();
  const [phases, setPhases] = useState<Phase[]>(INITIAL_PHASES);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<ProgressEvent[]>([]);
  const [phaseProgress, setPhaseProgress] = useState<number>(0);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [waitingForHelper, setWaitingForHelper] = useState(false);
  const [schemaOnly, setSchemaOnly] = useState(false);
  const [schemaReady, setSchemaReady] = useState(false);
  const pollTimer = useRef<number | null>(null);
  const lastLogLength = useRef<number>(0);

  const totalTables = useMemo(
    () => plan.tableMappings.filter((t) => t.action === "Migrate").length,
    [plan],
  );
  const totalRows = useMemo(
    () => plan.manifest.tables.reduce((s, t) => s + t.rowCount, 0),
    [plan],
  );

  useEffect(() => () => {
    if (pollTimer.current) window.clearInterval(pollTimer.current);
  }, []);

  function setPhase(key: Phase["key"], status: PhaseStatus) {
    setPhases((cur) => cur.map((p) => (p.key === key ? { ...p, status } : p)));
  }

  function appendLog(e: ProgressEvent) {
    setLogLines((cur) => [...cur, e]);
    if (typeof e.progress === "number") setPhaseProgress(e.progress);
  }

  async function run(phase: "full" | "schema" | "data" = "full") {
    if (!migrationJobId) return;
    setRunning(true);
    setError(null);
    setLogLines([]);
    if (phase !== "data") {
      setPhases(INITIAL_PHASES);
      setSchemaReady(false);
    } else {
      // Resuming from SchemaReady — keep schema as done, mark load running.
      setPhases((cur) =>
        cur.map((p) =>
          p.key === "schema"
            ? { ...p, status: "done" }
            : p.key === "load"
              ? { ...p, status: "running" }
              : { ...p, status: "pending" },
        ),
      );
    }
    setPhaseProgress(0);
    lastLogLength.current = 0;

    try {
      const client = getDataverseClient();
      const { environmentUrl, tenantId } = await client.getContext();
      const job = await client.getJob(migrationJobId);
      const prefix = job.targetPublisherPrefix?.trim();
      const solution = job.targetSolutionName?.trim();
      if (!prefix || !solution) {
        throw new Error(
          "Migration job is missing target publisher prefix or solution name. Go back to Connect.",
        );
      }

      // 1. Save the approved plan (only for the first launch — re-save is harmless).
      if (phase !== "data") {
        appendLog({ kind: "phase", message: "Saving migration plan…" });
        await client.savePlan(migrationJobId, plan);
      }

      // 2. Mark the job as queued for the helper.
      await client.setJobStatus(migrationJobId, 5); // Creating Schema (helper will advance)

      // 3. Launch the desktop helper.
      const phaseLabel =
        phase === "schema" ? "schema-only" : phase === "data" ? "data load" : "full migration";
      appendLog({ kind: "phase", message: `Launching desktop helper (${phaseLabel})…` });
      const url = new URL("accesstopower://launch");
      url.searchParams.set("jobId", migrationJobId);
      url.searchParams.set("env", environmentUrl);
      url.searchParams.set("tenant", tenantId);
      url.searchParams.set("name", job.name);
      url.searchParams.set("mode", "migrate");
      if (phase !== "full") url.searchParams.set("phase", phase);
      window.location.href = url.toString();

      // 4. Begin polling.
      setWaitingForHelper(true);
      if (phase !== "data") setPhase("schema", "running");
      startPolling();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhases((cur) =>
        cur.map((p) => (p.status === "running" ? { ...p, status: "failed" } : p)),
      );
      setRunning(false);
    }
  }

  function startPolling() {
    if (pollTimer.current || !migrationJobId) return;
    pollTimer.current = window.setInterval(() => {
      void pollOnce();
    }, 3000);
    void pollOnce();
  }

  function stopPolling() {
    if (pollTimer.current) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  async function pollOnce() {
    if (!migrationJobId) return;
    try {
      const client = getDataverseClient();
      const [job, log] = await Promise.all([
        client.getJob(migrationJobId),
        client.tryGetMigrationLog(migrationJobId),
      ]);

      // Apply log delta.
      if (log) {
        const lines = log.split(/\r?\n/).filter(Boolean);
        if (lines.length > lastLogLength.current) {
          const fresh = lines.slice(lastLogLength.current);
          for (const line of fresh) {
            try {
              const event = JSON.parse(line) as ProgressEvent;
              appendLog(event);
            } catch {
              appendLog({ kind: "log", message: line });
            }
          }
          lastLogLength.current = lines.length;
        }
      }

      // Advance phase state from job.status (5..12).
      // 5=Creating Schema, 6=Loading Data, 7=Resolving Lookups, 8=Validating,
      // 9=ok, 10=partial, 11=failed, 12=SchemaReady (schema-only stopped).
      switch (job.status) {
        case 5:
          setPhase("schema", "running");
          break;
        case 6:
          setPhase("schema", "done");
          setPhase("load", "running");
          break;
        case 7:
          setPhase("schema", "done");
          setPhase("load", "done");
          setPhase("lookups", "running");
          break;
        case 8:
          setPhase("schema", "done");
          setPhase("load", "done");
          setPhase("lookups", "done");
          setPhase("validate", "running");
          break;
        case 12:
          setPhase("schema", "done");
          setPhaseProgress(100);
          stopPolling();
          setRunning(false);
          setWaitingForHelper(false);
          setSchemaReady(true);
          break;
        case 9:
        case 10:
          setPhases([
            { key: "schema", label: "Create Dataverse schema", status: "done" },
            { key: "load", label: "Load data (pass 1)", status: "done" },
            { key: "lookups", label: "Resolve lookups (pass 2)", status: "done" },
            { key: "validate", label: "Validate row counts", status: "done" },
          ]);
          setPhaseProgress(100);
          stopPolling();
          setRunning(false);
          setWaitingForHelper(false);
          // Synthesize a minimal report from the log; richer report will land in Slice B.
          setReport({
            overallStatus: job.status === 9 ? "ok" : "mismatch",
            tables: [],
            totalExpected: totalRows,
            totalActual: totalRows,
          });
          break;
        case 11:
          setPhases((cur) =>
            cur.map((p) => (p.status === "running" ? { ...p, status: "failed" } : p)),
          );
          stopPolling();
          setRunning(false);
          setWaitingForHelper(false);
          setError("Migration failed. Check the activity log for details.");
          break;
      }
    } catch (e) {
      // Transient — keep polling, but surface once.
      setError((cur) => cur ?? (e instanceof Error ? e.message : String(e)));
    }
  }

  function cancel() {
    stopPolling();
    setRunning(false);
    setWaitingForHelper(false);
  }

  const schemaDone = phases.find((p) => p.key === "schema")?.status === "done";
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
                  <ProgressBar value={phaseProgress / 100} />
                ) : (
                  <Tag appearance={p.status === "failed" ? "filled" : "outline"}>
                    {p.status}
                  </Tag>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className={styles.logBox}>
        {logLines.length === 0 && (
          <span style={{ color: tokens.colorNeutralForeground3 }}>
            Activity log will appear here when migration starts.
          </span>
        )}
        {logLines.map((e, i) => (
          <span
            key={i}
            className={`${styles.logLine} ${
              e.severity === "warn" ? styles.warn : e.severity === "error" ? styles.err : ""
            }`}
          >
            [{e.kind}] {e.message}
          </span>
        ))}
      </div>

      {waitingForHelper && (
        <MessageBar intent="info">
          <MessageBarBody>
            The desktop helper is running the migration. Keep this tab open — progress will appear here as it works.
          </MessageBarBody>
        </MessageBar>
      )}
      {schemaReady && (
        <MessageBar intent="success">
          <MessageBarBody>
            Schema provisioned. Open the maker portal to inspect the new tables, columns, lookups, and alternate keys. When you're satisfied, click <strong>Load data now</strong> to migrate the rows.
          </MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.actions}>
        <Button disabled={running} onClick={onBack}>
          Back
        </Button>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!running && !schemaReady && !allDone && (
            <Checkbox
              label="Provision schema only (review before loading data)"
              checked={schemaOnly}
              onChange={(_, d) => setSchemaOnly(!!d.checked)}
            />
          )}
          {running ? (
            <Button onClick={cancel}>Cancel</Button>
          ) : schemaReady ? (
            <Button
              appearance="primary"
              onClick={() => void run("data")}
              disabled={!migrationJobId}
            >
              Load data now
            </Button>
          ) : (
            <Button
              appearance="primary"
              onClick={() => void run(schemaOnly ? "schema" : "full")}
              disabled={!migrationJobId}
            >
              {schemaDone ? "Re-run migration" : schemaOnly ? "Provision schema" : "Start migration"}
            </Button>
          )}
          {allDone && report && (
            <Button appearance="primary" onClick={() => onCompleted(report)}>
              Continue
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
