import { useEffect, useMemo, useState } from "react";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, CardHeader } from "../ui/Card";
import { ConfirmModal } from "../ui/Modal";
import { HelperLaunchModal } from "../ui/HelperLaunchModal";
import { Spinner } from "../ui/Spinner";
import { Table, THead, TBody, TR, TH, TD } from "../ui/Table";
import { cx } from "../ui/cx";
import {
  getDataverseClient,
  type MigrationAnnotationInfo,
  type MigrationJobSnapshot,
} from "../services/dataverseClient";
import { generateModelDrivenApp } from "../services/modelDrivenAppBuilder";
import type { ProgressEvent } from "../services/schemaCreator";
import type { ValidationReport } from "../services/validator";
import type { MigrationPlan } from "../types/manifest";
import { formatDate, statusLabel, statusTone } from "./statusFormat";

interface Props {
  jobId: string;
  onBack: () => void;
}

interface ReportShape {
  totals?: { expected?: number; actual?: number; rejected?: number };
  tables?: Array<{
    accessTable: string;
    dataverseTable: string;
    expectedRows?: number;
    actualRows?: number;
    rejected?: number;
    status?: string;
    message?: string;
  }>;
  validation?: ValidationReport;
}

export function HistoryDetailPage({ jobId, onBack }: Props) {
  const [job, setJob] = useState<MigrationJobSnapshot | null>(null);
  const [report, setReport] = useState<ReportShape | null>(null);
  const [logLines, setLogLines] = useState<ProgressEvent[] | null>(null);
  const [annotations, setAnnotations] = useState<MigrationAnnotationInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [rerunLaunchUrl, setRerunLaunchUrl] = useState<string | null>(null);
  const [rerunBusy, setRerunBusy] = useState(false);
  const [logFilter, setLogFilter] = useState<"all" | "warn" | "error" | "phase">("all");
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [mdaState, setMdaState] = useState<
    | { kind: "idle" }
    | { kind: "running"; message: string }
    | { kind: "done"; playUrl: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function load() {
    setError(null);
    setLoading(true);
    try {
      const client = getDataverseClient();
      const [j, r, log, anns, p, mda] = await Promise.all([
        client.getJob(jobId),
        client.tryGetMigrationReport(jobId).catch(() => null),
        client.tryGetMigrationLog(jobId).catch(() => null),
        client.listJobAnnotations(jobId).catch(() => []),
        client.tryGetPlan(jobId).catch(() => null),
        client.tryGetMdaResult(jobId).catch(() => null),
      ]);
      setJob(j);
      setReport(r as ReportShape | null);
      setAnnotations(anns);
      setPlan(p);
      setMdaState(mda?.playUrl ? { kind: "done", playUrl: mda.playUrl } : { kind: "idle" });
      if (log) {
        const events: ProgressEvent[] = log
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line) as ProgressEvent;
            } catch {
              return { kind: "log", message: line } as ProgressEvent;
            }
          });
        setLogLines(events);
      } else {
        setLogLines([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const filteredLog = useMemo(() => {
    if (!logLines) return [];
    if (logFilter === "all") return logLines;
    if (logFilter === "warn") return logLines.filter((e) => e.severity === "warn" || e.severity === "error");
    if (logFilter === "error") return logLines.filter((e) => e.severity === "error");
    if (logFilter === "phase") return logLines.filter((e) => e.kind === "phase");
    return logLines;
  }, [logLines, logFilter]);

  const tableRows = report?.tables ?? report?.validation?.tables.map((t) => ({
    accessTable: t.accessTable,
    dataverseTable: t.dataverseTable,
    expectedRows: t.expectedRows,
    actualRows: t.actualRows,
    status: t.status,
    message: t.message,
  })) ?? [];

  const totalExpected = report?.totals?.expected ?? report?.validation?.totalExpected ?? 0;
  const totalActual = report?.totals?.actual ?? report?.validation?.totalActual ?? 0;
  const totalRejected = report?.totals?.rejected ?? 0;
  const errorCount = logLines?.filter((e) => e.severity === "error").length ?? 0;
  const warnCount = logLines?.filter((e) => e.severity === "warn").length ?? 0;

  async function rerun() {
    if (!job) return;
    setRerunBusy(true);
    try {
      const client = getDataverseClient();
      const { environmentUrl, tenantId } = await client.getContext();
      const url = new URL("accesstopower://launch");
      url.searchParams.set("jobId", jobId);
      url.searchParams.set("env", environmentUrl);
      url.searchParams.set("tenant", tenantId);
      url.searchParams.set("name", job.name);
      url.searchParams.set("mode", "migrate");
      setRerunLaunchUrl(url.toString());
      setRerunOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRerunBusy(false);
    }
  }

  async function handleGenerateApp() {
    if (!plan || !job?.targetPublisherPrefix) return;
    setMdaState({ kind: "running", message: "Launching desktop helper…" });
    try {
      const client = getDataverseClient();
      const { environmentUrl, tenantId } = await client.getContext();
      const result = await generateModelDrivenApp({
        environmentUrl,
        tenantId,
        migrationJobId: jobId,
        jobName: job.name,
        launchDisplayName: `${job.name} App`,
        client,
        onProgress: (e) => setMdaState({ kind: "running", message: e.message }),
      });
      setMdaState({ kind: "done", playUrl: result.playUrl });
    } catch (e) {
      setMdaState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <>
      <header className="bg-white border-b border-ink-200 px-8 py-5">
        <div className="flex items-center justify-between gap-6">
          <div className="min-w-0">
            <button
              onClick={onBack}
              className="text-sm text-brand-600 hover:text-brand-700 font-medium mb-1 inline-flex items-center gap-1"
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
                <path d="M12 15l-5-5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              History
            </button>
            <h1 className="text-xl font-semibold text-ink-900 truncate">
              {job?.name || (loading ? "Loading…" : "(unnamed)")}
            </h1>
            <div className="flex items-center gap-2 mt-1 text-sm text-ink-500">
              <span className="font-mono text-xs">{jobId}</span>
              {job && <Badge tone={statusTone(job.status)}>{statusLabel(job.status)}</Badge>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {mdaState.kind !== "done" && (
              <Button
                variant="secondary"
                onClick={() => void handleGenerateApp()}
                disabled={!plan || !job?.targetPublisherPrefix || mdaState.kind === "running"}
                title={!plan ? "No migration plan was saved for this job." : undefined}
              >
                {mdaState.kind === "running" ? "Generating…" : "Generate model-driven app"}
              </Button>
            )}
            <Button variant="primary" onClick={() => setRerunOpen(true)} disabled={!job}>
              Re-run migration
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-8 py-8">
        <div className="max-w-6xl mx-auto space-y-6">
          {error && <Alert intent="error" title="Couldn't load this migration">{error}</Alert>}

          {mdaState.kind === "running" && (
            <Alert intent="info" title="Generating model-driven app">
              <div className="flex items-center gap-2">
                <Spinner size={14} />
                <span>{mdaState.message}</span>
              </div>
            </Alert>
          )}
          {mdaState.kind === "done" && (
            <Alert intent="success" title="Model-driven app ready">
              <a
                href={mdaState.playUrl}
                target="_blank"
                rel="noreferrer"
                className="text-brand-600 hover:text-brand-700 underline break-all"
              >
                {mdaState.playUrl}
              </a>
            </Alert>
          )}
          {mdaState.kind === "error" && (
            <Alert intent="error" title="Couldn't generate the app">
              {mdaState.message}
            </Alert>
          )}

          {loading && !job && (
            <div className="flex items-center gap-3 text-sm text-ink-500">
              <Spinner size={16} />
              Loading job…
            </div>
          )}

          {job && (
            <>
              {/* KPI strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <Stat label="Expected rows" value={totalExpected.toLocaleString()} />
                <Stat label="Loaded rows" value={totalActual.toLocaleString()} />
                <Stat
                  label="Rejected"
                  value={totalRejected.toLocaleString()}
                  tone={totalRejected > 0 ? "warning" : "neutral"}
                />
                <Stat
                  label="Errors"
                  value={errorCount.toLocaleString()}
                  tone={errorCount > 0 ? "danger" : warnCount > 0 ? "warning" : "success"}
                  hint={warnCount > 0 ? `${warnCount} warning(s)` : undefined}
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <Card className="lg:col-span-2">
                  <CardHeader title="Job details" />
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                    <dt className="text-ink-500">Solution</dt>
                    <dd className="text-ink-900 font-medium">{job.targetSolutionName || "—"}</dd>
                    <dt className="text-ink-500">Publisher prefix</dt>
                    <dd className="text-ink-900 font-mono">{job.targetPublisherPrefix || "—"}</dd>
                    <dt className="text-ink-500">Status</dt>
                    <dd>
                      <Badge tone={statusTone(job.status)}>{statusLabel(job.status)}</Badge>
                    </dd>
                    <dt className="text-ink-500">Manifest uploaded</dt>
                    <dd className="text-ink-900">{job.manifestPresent ? "Yes" : "No"}</dd>
                  </dl>
                </Card>

                <Card>
                  <CardHeader title="Annotations" description={`${annotations.length} attached files`} />
                  {annotations.length === 0 ? (
                    <div className="text-sm text-ink-500">No files attached yet.</div>
                  ) : (
                    <ul className="space-y-1.5">
                      {annotations.map((a) => (
                        <li key={a.annotationId} className="text-sm flex items-center justify-between gap-2">
                          <span className="font-mono text-xs text-ink-700 truncate">{a.fileName}</span>
                          <span className="text-xs text-ink-400 shrink-0">{formatDate(a.createdOn)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>

              {/* Per-table results */}
              <Card padding="none">
                <div className="px-5 pt-5 pb-3">
                  <div className="text-base font-semibold text-ink-900">Per-table results</div>
                  <div className="text-sm text-ink-500 mt-0.5">
                    {tableRows.length === 0
                      ? "No detailed table report uploaded for this job."
                      : `${tableRows.length} table(s) processed.`}
                  </div>
                </div>
                {tableRows.length > 0 && (
                  <Table>
                    <THead>
                      <TR>
                        <TH>Access table</TH>
                        <TH>Dataverse table</TH>
                        <TH align="right">Expected</TH>
                        <TH align="right">Actual</TH>
                        <TH>Status</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {tableRows.map((t) => {
                        const ok = (t.status ?? "").toLowerCase() === "ok";
                        const tone = ok ? "success" : (t.status ?? "").toLowerCase() === "error" ? "danger" : "warning";
                        return (
                          <TR key={`${t.accessTable}-${t.dataverseTable}`}>
                            <TD>{t.accessTable}</TD>
                            <TD className="font-mono">{t.dataverseTable}</TD>
                            <TD align="right">{(t.expectedRows ?? 0).toLocaleString()}</TD>
                            <TD align="right">{(t.actualRows ?? 0).toLocaleString()}</TD>
                            <TD>
                              <Badge tone={tone}>{t.status ?? "—"}</Badge>
                            </TD>
                          </TR>
                        );
                      })}
                    </TBody>
                  </Table>
                )}
              </Card>

              {/* Activity log */}
              <Card padding="none">
                <div className="flex items-center justify-between gap-4 px-5 pt-5 pb-3">
                  <div>
                    <div className="text-base font-semibold text-ink-900">Activity log</div>
                    <div className="text-sm text-ink-500 mt-0.5">
                      {logLines === null
                        ? "Loading…"
                        : logLines.length === 0
                          ? "No log uploaded for this job."
                          : `${logLines.length} entries`}
                    </div>
                  </div>
                  {logLines && logLines.length > 0 && (
                    <div className="flex items-center gap-1 bg-ink-100 rounded-lg p-0.5 text-xs">
                      {(["all", "phase", "warn", "error"] as const).map((f) => (
                        <button
                          key={f}
                          onClick={() => setLogFilter(f)}
                          className={cx(
                            "px-2.5 py-1 rounded-md transition capitalize font-medium",
                            logFilter === f
                              ? "bg-white text-ink-900 shadow-soft"
                              : "text-ink-500 hover:text-ink-700",
                          )}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {logLines && logLines.length > 0 && (
                  <div className="max-h-96 overflow-y-auto bg-ink-900 text-ink-100 font-mono text-xs leading-relaxed">
                    {filteredLog.map((e, i) => (
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
                    ))}
                    {filteredLog.length === 0 && (
                      <div className="px-5 py-3 text-ink-400">No entries match this filter.</div>
                    )}
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      </main>

      <ConfirmModal
        open={rerunOpen}
        onClose={() => setRerunOpen(false)}
        onConfirm={rerun}
        title="Re-run this migration?"
        description="The desktop helper will be launched again. The existing migration plan and Dataverse schema are reused; data will be reloaded."
        confirmLabel="Launch helper"
        loading={rerunBusy}
      >
        <ul className="list-disc list-inside space-y-1 text-sm text-ink-600">
          <li>Existing rows in target tables may be updated or duplicated depending on alternate keys.</li>
          <li>Schema is not changed unless you migrate from the wizard with new mappings.</li>
          <li>You can clean up first if you want a fresh load.</li>
        </ul>
      </ConfirmModal>

      <HelperLaunchModal
        open={!!rerunLaunchUrl}
        mode="migrate-full"
        helperUrl={rerunLaunchUrl ?? ""}
        onClose={() => setRerunLaunchUrl(null)}
      />
    </>
  );
}

interface StatProps {
  label: string;
  value: string;
  tone?: "neutral" | "warning" | "danger" | "success";
  hint?: string;
}

function Stat({ label, value, tone = "neutral", hint }: StatProps) {
  const toneClass = {
    neutral: "text-ink-900",
    warning: "text-amber-700",
    danger: "text-rose-700",
    success: "text-emerald-700",
  }[tone];
  return (
    <Card>
      <div className="text-xs uppercase tracking-wide text-ink-500 font-medium">{label}</div>
      <div className={cx("text-2xl font-semibold mt-1", toneClass)}>{value}</div>
      {hint && <div className="text-xs text-ink-500 mt-0.5">{hint}</div>}
    </Card>
  );
}
