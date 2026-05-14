import { useMemo, useRef, useState } from "react";
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
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { MigrationPlan } from "../types/manifest";
import { getDataverseClient } from "../services/dataverseClient";
import { createDataverseSchema, type ProgressEvent } from "../services/schemaCreator";
import { loadData, type IdMap } from "../services/dataLoader";
import { resolveLookups } from "../services/lookupResolver";
import { validateMigration, type ValidationReport } from "../services/validator";

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
  const abortRef = useRef<AbortController | null>(null);

  const totalTables = useMemo(
    () => plan.tableMappings.filter((t) => t.action === "Migrate").length,
    [plan],
  );
  const totalRows = useMemo(
    () => plan.manifest.tables.reduce((s, t) => s + t.rowCount, 0),
    [plan],
  );

  function setPhase(key: Phase["key"], status: PhaseStatus) {
    setPhases((cur) => cur.map((p) => (p.key === key ? { ...p, status } : p)));
  }

  function appendLog(e: ProgressEvent) {
    setLogLines((cur) => [...cur, e]);
    if (typeof e.progress === "number") setPhaseProgress(e.progress);
  }

  async function run() {
    if (!migrationJobId) return;
    setRunning(true);
    setError(null);
    setLogLines([]);
    setPhases(INITIAL_PHASES);
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      const client = getDataverseClient();
      const { environmentUrl } = await client.getContext();
      const job = await client.getJob(migrationJobId);
      const prefix = job.targetPublisherPrefix?.trim();
      const solution = job.targetSolutionName?.trim();
      if (!prefix || !solution) {
        throw new Error(
          "Migration job is missing target publisher prefix or solution name. Go back to Connect.",
        );
      }

      // Phase 1: schema
      await client.setJobStatus(migrationJobId, 5); // Creating Schema
      setPhase("schema", "running");
      await createDataverseSchema({
        envUrl: environmentUrl,
        plan,
        publisherPrefix: prefix,
        solutionUniqueName: solution,
        signal: abortRef.current.signal,
        onProgress: appendLog,
      });
      setPhase("schema", "done");

      // Phase 2: data load
      await client.setJobStatus(migrationJobId, 6); // Loading Data
      setPhase("load", "running");
      setPhaseProgress(0);
      const idMap: IdMap = await loadData({
        envUrl: environmentUrl,
        plan,
        publisherPrefix: prefix,
        signal: abortRef.current.signal,
        onProgress: appendLog,
      });
      setPhase("load", "done");

      // Phase 3: lookup resolution
      await client.setJobStatus(migrationJobId, 7); // Resolving Lookups
      setPhase("lookups", "running");
      setPhaseProgress(0);
      await resolveLookups({
        envUrl: environmentUrl,
        plan,
        publisherPrefix: prefix,
        idMap,
        signal: abortRef.current.signal,
        onProgress: appendLog,
      });
      setPhase("lookups", "done");

      // Phase 4: validation
      await client.setJobStatus(migrationJobId, 8); // Validating
      setPhase("validate", "running");
      setPhaseProgress(0);
      const validation = await validateMigration({
        envUrl: environmentUrl,
        plan,
        signal: abortRef.current.signal,
        onProgress: appendLog,
      });
      setReport(validation);
      setPhase("validate", "done");

      // Final status: 9 ok, 10 partial, 11 failed
      const finalStatus =
        validation.overallStatus === "ok" ? 9 :
        validation.overallStatus === "mismatch" ? 10 : 11;
      await client.setJobStatus(migrationJobId, finalStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhases((cur) =>
        cur.map((p) => (p.status === "running" ? { ...p, status: "failed" } : p)),
      );
    } finally {
      setRunning(false);
    }
  }

  function cancel() {
    abortRef.current?.abort();
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

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.actions}>
        <Button disabled={running} onClick={onBack}>
          Back
        </Button>
        <div style={{ display: "flex", gap: 8 }}>
          {running ? (
            <Button onClick={cancel}>Cancel</Button>
          ) : (
            <Button appearance="primary" onClick={run} disabled={!migrationJobId}>
              {schemaDone ? "Re-run migration" : "Start migration"}
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
