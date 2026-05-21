import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Checkbox } from "../ui/Checkbox";
import { HelperLaunchModal, type HelperMode } from "../ui/HelperLaunchModal";
import { HelperWaitingPanel } from "../ui/HelperWaitingPanel";
import { ProgressBar } from "../ui/ProgressBar";
import { Spinner } from "../ui/Spinner";
import { cx } from "../ui/cx";
import type { MigrationPlan } from "../types/manifest";
import { getDataverseClient } from "../services/dataverseClient";
import type { ProgressEvent } from "../services/schemaCreator";
import { parseHelperMigrationReport, type ValidationReport } from "../services/validator";

interface Props {
  plan: MigrationPlan;
  migrationJobId: string | null;
  onCompleted: (report: ValidationReport) => void;
  /** Fired the first time the helper launch is triggered for this job. */
  onStarted?: () => void;
  onBack: () => void;
}

type PhaseStatus = "pending" | "running" | "done" | "failed";
interface Phase {
  key: "schema" | "load" | "lookups" | "validate";
  label: string;
  description: string;
  status: PhaseStatus;
}

const INITIAL_PHASES: Phase[] = [
  {
    key: "schema",
    label: "Create Dataverse schema",
    description: "Tables, columns, lookups, and alternate keys.",
    status: "pending",
  },
  {
    key: "load",
    label: "Load data (pass 1)",
    description: "Insert rows; defer cross-table lookups.",
    status: "pending",
  },
  {
    key: "lookups",
    label: "Resolve lookups (pass 2)",
    description: "Wire up foreign keys with the GUIDs we just minted.",
    status: "pending",
  },
  {
    key: "validate",
    label: "Validate row counts",
    description: "Compare actual rows in Dataverse vs. expected from Access.",
    status: "pending",
  },
];

const PHASE_TONE: Record<PhaseStatus, "neutral" | "brand" | "success" | "danger"> = {
  pending: "neutral",
  running: "brand",
  done: "success",
  failed: "danger",
};

export function MigrateStep({ plan, migrationJobId, onCompleted, onStarted, onBack }: Props) {
  const [phases, setPhases] = useState<Phase[]>(INITIAL_PHASES);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<ProgressEvent[]>([]);
  const [phaseProgress, setPhaseProgress] = useState<number>(0);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [waitingForHelper, setWaitingForHelper] = useState(false);
  const [schemaOnly, setSchemaOnly] = useState(false);
  const [schemaReady, setSchemaReady] = useState(false);
  const [launch, setLaunch] = useState<{ mode: HelperMode; url: string; phase: "full" | "schema" | "data" } | null>(null);
  const [migrateModalOpen, setMigrateModalOpen] = useState(false);
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

  useEffect(
    () => () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    },
    [],
  );

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
    onStarted?.();
    if (phase !== "data") {
      setPhases(INITIAL_PHASES);
      setSchemaReady(false);
    } else {
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
      if (phase !== "data") {
        appendLog({ kind: "phase", message: "Saving migration plan…" });
        await client.savePlan(migrationJobId, plan);
      }
      await client.setJobStatus(migrationJobId, 5);

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
      const helperMode: HelperMode =
        phase === "schema" ? "migrate-schema" : phase === "data" ? "migrate-data" : "migrate-full";
      setLaunch({ mode: helperMode, url: url.toString(), phase });
      setMigrateModalOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhases((cur) => cur.map((p) => (p.status === "running" ? { ...p, status: "failed" } : p)));
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
          setPhases(INITIAL_PHASES.map((p) => ({ ...p, status: "done" })));
          setPhaseProgress(100);
          stopPolling();
          setRunning(false);
          setWaitingForHelper(false);
          // Pull the rich migration-report.json the helper just wrote so the
          // Validate step can show per-table row counts, dropped columns,
          // warnings, and rejected rows — not just a thumbs-up / thumbs-down.
          void (async () => {
            const fallback: ValidationReport = {
              overallStatus: job.status === 9 ? "ok" : "mismatch",
              tables: [],
              totalExpected: totalRows,
              totalActual: totalRows,
              totalRejected: 0,
              unresolvedLookups: 0,
            };
            try {
              const client = getDataverseClient();
              if (!migrationJobId) {
                setReport(fallback);
                return;
              }
              const raw = await client.tryGetMigrationReport(migrationJobId);
              const parsed = raw ? parseHelperMigrationReport(raw) : null;
              setReport(parsed ?? fallback);
            } catch {
              setReport(fallback);
            }
          })();
          break;
        case 11:
          setPhases((cur) =>
            cur.map((p) => (p.status === "running" ? { ...p, status: "failed" } : p)),
          );
          stopPolling();
          setRunning(false);
          setWaitingForHelper(false);
          setError("Migration failed. Check the activity log for details.");
          // Even on failure the helper may have written a partial report —
          // surface whatever it has so the user can see which tables made it.
          void (async () => {
            try {
              if (!migrationJobId) return;
              const client = getDataverseClient();
              const raw = await client.tryGetMigrationReport(migrationJobId);
              const parsed = raw ? parseHelperMigrationReport(raw) : null;
              if (parsed) setReport(parsed);
            } catch {
              /* ignore — error banner is already shown */
            }
          })();
          break;
      }
    } catch (e) {
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
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-4">
        <Stat label="Tables to migrate" value={totalTables.toLocaleString()} />
        <Stat label="Rows" value={totalRows.toLocaleString()} />
        <Stat
          label="Job ID"
          value={migrationJobId ? `${migrationJobId.slice(0, 8)}…` : "—"}
          mono
        />
      </div>

      <Card>
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-base font-semibold text-ink-900">Migration phases</div>
            <div className="text-sm text-ink-500 mt-0.5">
              The desktop helper drives each phase and reports back to this view.
            </div>
          </div>
        </div>
        <ol className="space-y-3">
          {phases.map((p, i) => (
            <li
              key={p.key}
              className={cx(
                "flex items-start gap-4 p-3 rounded-xl border transition",
                p.status === "running" && "border-brand-200 bg-brand-50/40",
                p.status === "done" && "border-emerald-200 bg-emerald-50/40",
                p.status === "failed" && "border-rose-200 bg-rose-50/40",
                p.status === "pending" && "border-ink-200 bg-white",
              )}
            >
              <div
                className={cx(
                  "h-8 w-8 rounded-full flex items-center justify-center text-sm font-semibold shrink-0",
                  p.status === "done" && "bg-emerald-500 text-white",
                  p.status === "running" && "bg-brand-600 text-white",
                  p.status === "failed" && "bg-rose-500 text-white",
                  p.status === "pending" && "bg-ink-100 text-ink-500",
                )}
              >
                {p.status === "done" ? (
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                    <path d="M16.7 5.3a1 1 0 010 1.4l-7 7a1 1 0 01-1.4 0l-3.5-3.5a1 1 0 011.4-1.4L9 11.6l6.3-6.3a1 1 0 011.4 0z" />
                  </svg>
                ) : p.status === "running" ? (
                  <Spinner size={14} />
                ) : (
                  i + 1
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-ink-900">{p.label}</div>
                  <Badge tone={PHASE_TONE[p.status]}>{p.status}</Badge>
                </div>
                <div className="text-xs text-ink-500 mt-0.5">{p.description}</div>
                {p.status === "running" && (
                  <ProgressBar value={phaseProgress} className="mt-2" size="sm" />
                )}
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card padding="none">
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div className="text-sm font-semibold text-ink-900">Activity log</div>
          <div className="text-xs text-ink-500">{logLines.length} entries</div>
        </div>
        <div className="bg-ink-900 text-ink-100 font-mono text-xs leading-relaxed max-h-72 overflow-y-auto rounded-b-2xl">
          {logLines.length === 0 ? (
            <div className="px-5 py-4 text-ink-400">
              Activity log will appear here when the migration starts.
            </div>
          ) : (
            logLines.map((e, i) => (
              <div
                key={i}
                className={cx(
                  "px-5 py-1 whitespace-pre-wrap break-words",
                  e.severity === "error" && "bg-rose-900/20 text-rose-200",
                  e.severity === "warn" && "text-amber-200",
                  e.kind === "phase" && "text-brand-200 font-semibold",
                )}
              >
                <span className="text-ink-400 mr-2">[{e.kind}]</span>
                {e.message}
              </div>
            ))
          )}
        </div>
      </Card>

      {waitingForHelper && logLines.length === 0 && (
        <HelperWaitingPanel
          title="Waiting for the helper"
          description="The helper is starting the migration. Live progress and logs will stream in here as soon as it begins."
          helperUrl={launch?.url ?? null}
          onRelaunch={launch ? () => setMigrateModalOpen(true) : undefined}
        />
      )}
      {waitingForHelper && logLines.length > 0 && (
        <Alert intent="info">
          The desktop helper is running the migration. Keep this tab open — progress will appear
          here as it works.
        </Alert>
      )}
      {schemaReady && (
        <Alert intent="success" title="Schema provisioned">
          Open the maker portal to inspect the new tables, columns, lookups, and alternate keys.
          When you're satisfied, click <strong>Load data now</strong> to migrate the rows.
        </Alert>
      )}
      {error && <Alert intent="error">{error}</Alert>}

      <div className="flex items-center justify-between pt-2">
        <Button variant="secondary" disabled={running} onClick={onBack}>
          Back
        </Button>
        <div className="flex items-center gap-3">
          {!running && !schemaReady && !allDone && (
            <Checkbox
              label="Provision schema only"
              description="Review tables before loading data."
              checked={schemaOnly}
              onChange={(e) => setSchemaOnly(e.target.checked)}
            />
          )}
          {running ? (
            <Button variant="secondary" onClick={cancel}>
              Cancel
            </Button>
          ) : schemaReady ? (
            <Button variant="primary" onClick={() => void run("data")} disabled={!migrationJobId}>
              Load data now
            </Button>
          ) : schemaDone || allDone ? null : (
            // Once schema is in Dataverse there's no safe "Re-run" — it would
            // duplicate rows or fail on unique keys. If the run failed midway,
            // the user should go Back and start a fresh job rather than
            // retrying on top of a partial migration.
            <Button
              variant="primary"
              onClick={() => void run(schemaOnly ? "schema" : "full")}
              disabled={!migrationJobId}
            >
              {schemaOnly ? "Provision schema" : "Start migration"}
            </Button>
          )}
          {allDone && report && (
            <Button variant="primary" onClick={() => onCompleted(report)}>
              Continue
            </Button>
          )}
        </div>
      </div>

      <HelperLaunchModal
        open={migrateModalOpen}
        mode={launch?.mode ?? "migrate-full"}
        helperUrl={launch?.url ?? ""}
        onClose={() => setMigrateModalOpen(false)}
        onLaunched={() => {
          setWaitingForHelper(true);
          if (launch && launch.phase !== "data") setPhase("schema", "running");
          startPolling();
        }}
      />
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Card>
      <div className="text-xs uppercase tracking-wide text-ink-500 font-medium">{label}</div>
      <div
        className={cx(
          "text-2xl font-semibold text-ink-900 mt-1",
          mono && "font-mono text-base",
        )}
      >
        {value}
      </div>
    </Card>
  );
}
