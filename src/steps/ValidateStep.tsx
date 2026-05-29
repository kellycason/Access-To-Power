import { useState } from "react";
import { Fragment } from "react";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Spinner } from "../ui/Spinner";
import { Table, THead, TBody, TR, TH, TD } from "../ui/Table";
import type { ValidationReport } from "../services/validator";
import { cx } from "../ui/cx";
import { getDataverseClient } from "../services/dataverseClient";
import { generateModelDrivenApp } from "../services/modelDrivenAppBuilder";
import type { MigrationPlan } from "../types/manifest";

interface Props {
  migrationJobId: string | null;
  report: ValidationReport | null;
  plan: MigrationPlan | null;
  onBack: () => void;
  onRestart: () => void;
}

export function ValidateStep({ migrationJobId, report, plan, onBack, onRestart }: Props) {
  // Treat tables with dropped columns or warnings as "needs attention" even
  // when the overall status is ok — row counts can match while data still
  // got nulled out (Multivalue, Attachment, OLE) or quietly coerced.
  const tablesWithIssues =
    report?.tables.filter(
      (t) =>
        t.status !== "ok" ||
        t.rejectedRows > 0 ||
        t.droppedColumns.length > 0 ||
        t.warnings.length > 0,
    ) ?? [];
  const hasErrors = report?.overallStatus === "error" || tablesWithIssues.some((t) => t.status === "error");
  const hasMismatch = report?.tables.some((t) => t.status === "mismatch" || t.rejectedRows > 0) ?? false;
  const hasDropped = report?.tables.some((t) => t.droppedColumns.length > 0) ?? false;
  const hasWarnings = report?.tables.some((t) => t.warnings.length > 0) ?? false;
  const cleanRun =
    report?.overallStatus === "ok" && !hasMismatch && !hasDropped && !hasWarnings;

  const intent: "success" | "warning" | "error" | "info" = !report
    ? "info"
    : hasErrors
      ? "error"
      : cleanRun
        ? "success"
        : "warning";

  const [mdaState, setMdaState] = useState<
    | { kind: "idle" }
    | { kind: "running"; message: string }
    | { kind: "done"; playUrl: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function handleGenerateApp() {
    if (!plan) return;
    setMdaState({ kind: "running", message: "Launching desktop helper…" });
    try {
      const client = getDataverseClient();
      const { environmentUrl, tenantId } = await client.getContext();
      if (!migrationJobId) throw new Error("Missing migration job id.");
      const job = await client.getJob(migrationJobId);
      const prefix = job.targetPublisherPrefix?.trim();
      if (!prefix) {
        throw new Error("Job is missing target publisher prefix.");
      }
      const result = await generateModelDrivenApp({
        environmentUrl,
        tenantId,
        migrationJobId,
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

  const canGenerate =
    !!plan &&
    !!migrationJobId &&
    report?.overallStatus !== undefined &&
    report.overallStatus !== "error";

  return (
    <div className="space-y-5">
      <Alert intent={intent}>
        {!report && "Migration not run yet."}
        {report && cleanRun && (
          <>
            <strong>Migration complete — no issues detected.</strong> All{" "}
            {report.tables.length} table{report.tables.length === 1 ? "" : "s"} loaded the
            expected number of rows ({report.totalActual.toLocaleString()} total) with no
            dropped columns or warnings.
          </>
        )}
        {report && !cleanRun && hasErrors && (
          <>
            <strong>Migration finished with errors.</strong>{" "}
            {tablesWithIssues.filter((t) => t.status === "error").length} of{" "}
            {report.tables.length} table
            {report.tables.length === 1 ? "" : "s"} could not be validated. Review the
            table below; the per-row details are in the migration log on the job record.
          </>
        )}
        {report && !cleanRun && !hasErrors && (
          <>
            <strong>Migration finished — review needed.</strong> Loaded{" "}
            {report.totalActual.toLocaleString()} of {report.totalExpected.toLocaleString()}{" "}
            row{report.totalExpected === 1 ? "" : "s"}.
            {report.totalRejected > 0 ? (
              <>
                {" "}
                <strong>{report.totalRejected.toLocaleString()}</strong> row
                {report.totalRejected === 1 ? " was" : "s were"} rejected.
              </>
            ) : null}
            {hasDropped ? " Some source columns could not be migrated (see below)." : ""}
            {hasWarnings ? " Some columns had warnings during migration." : ""}
          </>
        )}
      </Alert>

      <Card padding="none">
        <div className="px-5 pt-5 pb-3 flex items-center justify-between">
          <div>
            <div className="text-base font-semibold text-ink-900">Validation results</div>
            <div className="text-sm text-ink-500 mt-0.5 font-mono">
              Job: {migrationJobId ?? "(none)"}
            </div>
          </div>
          {report && (
            <div className="text-right">
              <div className="text-xs text-ink-500">Total rows loaded</div>
              <div className="text-lg font-semibold text-ink-900">
                {report.totalActual.toLocaleString()} /{" "}
                {report.totalExpected.toLocaleString()}
              </div>
              {report.totalRejected > 0 && (
                <div className="text-xs text-amber-700 mt-0.5">
                  {report.totalRejected.toLocaleString()} rejected
                </div>
              )}
            </div>
          )}
        </div>
        <Table>
          <THead>
            <TR>
              <TH>Access table</TH>
              <TH>Dataverse table</TH>
              <TH align="right">Expected</TH>
              <TH align="right">Loaded</TH>
              <TH align="right">Rejected</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {!report && (
              <TR>
                <TD className="italic text-ink-500">No validation data yet.</TD>
                <TD>—</TD>
                <TD>—</TD>
                <TD>—</TD>
                <TD>—</TD>
                <TD>—</TD>
              </TR>
            )}
            {report?.tables.map((t) => {
              const rowHasIssues =
                t.status !== "ok" ||
                t.rejectedRows > 0 ||
                t.droppedColumns.length > 0 ||
                t.warnings.length > 0;
              return (
                <Fragment key={t.dataverseTable}>
                  <TR>
                    <TD>{t.accessTable}</TD>
                    <TD className="font-mono">{t.dataverseTable}</TD>
                    <TD align="right">{t.expectedRows.toLocaleString()}</TD>
                    <TD
                      align="right"
                      className={cx(
                        t.actualRows !== t.expectedRows && "text-amber-700 font-medium",
                      )}
                    >
                      {t.actualRows.toLocaleString()}
                    </TD>
                    <TD
                      align="right"
                      className={cx(t.rejectedRows > 0 && "text-amber-700 font-medium")}
                    >
                      {t.rejectedRows > 0 ? t.rejectedRows.toLocaleString() : "—"}
                    </TD>
                    <TD>
                      <Badge
                        tone={
                          t.status === "ok"
                            ? rowHasIssues
                              ? "warning"
                              : "success"
                            : t.status === "error"
                              ? "danger"
                              : "warning"
                        }
                      >
                        {t.status === "ok" && rowHasIssues ? "review" : t.status}
                      </Badge>
                    </TD>
                  </TR>
                  {(t.droppedColumns.length > 0 ||
                    t.warnings.length > 0 ||
                    t.message) && (
                    <TR key={`${t.dataverseTable}-detail`}>
                      <TD colSpan={6} className="bg-amber-50/30 !border-t-0">
                        <div className="text-xs space-y-2 py-1">
                          {t.message && (
                            <div className={t.status === "error" ? "text-rose-700" : "text-ink-700"}>
                              <span className="font-semibold">
                                {t.status === "error" ? "Error:" : "Note:"}
                              </span>{" "}
                              {t.message}
                            </div>
                          )}
                          {t.droppedColumns.length > 0 && (
                            <div>
                              <div className="font-semibold text-amber-800 mb-0.5">
                                Columns not migrated ({t.droppedColumns.length})
                              </div>
                              <ul className="list-disc list-inside text-ink-700 space-y-0.5">
                                {t.droppedColumns.map((d, i) => (
                                  <li key={i} className="font-mono text-[11px]">
                                    {d}
                                  </li>
                                ))}
                              </ul>
                              <div className="text-ink-500 mt-1">
                                These columns exist in Access but their data type
                                (Multi-value lookups, Attachments, OLE objects, Binary)
                                isn't supported by this tool yet. The destination column
                                was not created.
                              </div>
                            </div>
                          )}
                          {t.warnings.length > 0 && (
                            <div>
                              <div className="font-semibold text-amber-800 mb-0.5">
                                Warnings ({t.warnings.length})
                              </div>
                              <ul className="list-disc list-inside text-ink-700 space-y-0.5">
                                {t.warnings.map((w, i) => (
                                  <li key={i}>{w}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </TD>
                    </TR>
                  )}
                </Fragment>
              );
            })}
          </TBody>
        </Table>
        {report && report.unresolvedLookups > 0 && (
          <div className="px-5 py-3 border-t border-ink-200 text-xs text-amber-700">
            <strong>{report.unresolvedLookups.toLocaleString()}</strong> lookup
            reference{report.unresolvedLookups === 1 ? "" : "s"} couldn&apos;t be resolved
            during pass 2 (the foreign-key value didn&apos;t match any imported row). The
            affected rows are still in Dataverse but with that field empty — check the
            log on the migration job to see which rows.
          </div>
        )}
      </Card>

      <Card>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="text-base font-semibold text-ink-900">
              Generate model-driven app
            </div>
            <p className="text-sm text-ink-600 mt-1">
              Auto-create a Dataverse model-driven app for the migrated tables. Includes a
              sitemap with one navigation entry per table; auto-generated forms and views
              are picked up from each entity. You can customize everything afterward in
              the maker portal.
            </p>
            {mdaState.kind === "running" && (
              <div className="mt-3 inline-flex items-center gap-2 text-sm text-ink-700">
                <Spinner size={14} /> {mdaState.message}
              </div>
            )}
            {mdaState.kind === "done" && (
              <Alert intent="success" className="mt-3">
                App created.{" "}
                <a
                  href={mdaState.playUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline font-medium"
                >
                  Open it in Power Apps →
                </a>
              </Alert>
            )}
            {mdaState.kind === "error" && (
              <Alert intent="error" className="mt-3">
                {mdaState.message}
              </Alert>
            )}
          </div>
          <Button
            variant="primary"
            onClick={() => void handleGenerateApp()}
            disabled={!canGenerate || mdaState.kind === "running"}
          >
            {mdaState.kind === "done" ? "Regenerate" : "Generate app"}
          </Button>
        </div>
      </Card>

      <div className="flex items-center justify-between pt-2">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" onClick={onRestart}>
          Start new migration
        </Button>
      </div>
    </div>
  );
}
