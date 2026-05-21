import { useEffect, useState } from "react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Alert } from "../ui/Alert";
import { Spinner } from "../ui/Spinner";
import { Table, THead, TBody, TR, TH, TD } from "../ui/Table";
import {
  getDataverseClient,
  type MigrationJobListItem,
} from "../services/dataverseClient";
import { formatDate, relativeTime, statusLabel, statusTone } from "./statusFormat";

interface Props {
  onOpen: (jobId: string) => void;
  onStartNew: () => void;
}

export function HistoryListPage({ onOpen, onStartNew }: Props) {
  const [jobs, setJobs] = useState<MigrationJobListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setError(null);
    setRefreshing(true);
    try {
      const items = await getDataverseClient().listMigrationJobs();
      setJobs(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const succeeded = jobs?.filter((j) => j.status === 9).length ?? 0;
  const inProgress = jobs?.filter((j) => j.status >= 5 && j.status <= 8).length ?? 0;
  const failed = jobs?.filter((j) => j.status === 11).length ?? 0;

  return (
    <>
      <header className="bg-white border-b border-ink-200 px-8 py-5">
        <div className="flex items-center justify-between gap-6">
          <div>
            <h1 className="text-xl font-semibold text-ink-900">Migration history</h1>
            <p className="text-sm text-ink-500 mt-0.5">
              Every Access → Dataverse migration in this environment.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => void load()}
              loading={refreshing}
              iconLeft={
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
                  <path
                    d="M3 10a7 7 0 0 1 12-5l2-1v5h-5l2-2A5 5 0 1 0 15 12l1.7.5A7 7 0 0 1 3 10z"
                    fill="currentColor"
                  />
                </svg>
              }
            >
              Refresh
            </Button>
            <Button variant="primary" onClick={onStartNew}>
              + New migration
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-8 py-8">
        <div className="max-w-6xl mx-auto space-y-6">
          {/* KPI strip */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <KpiCard label="Total jobs" value={jobs?.length ?? "—"} tone="brand" />
            <KpiCard label="Succeeded" value={succeeded} tone="success" />
            <KpiCard label="In progress" value={inProgress} tone="info" />
            <KpiCard label="Failed" value={failed} tone="danger" />
          </div>

          {error && <Alert intent="error" title="Couldn't load migration jobs">{error}</Alert>}

          <Card padding="none">
            {!jobs && !error && (
              <div className="flex items-center gap-3 p-8 text-ink-500 text-sm">
                <Spinner size={16} />
                Loading migration history…
              </div>
            )}
            {jobs && jobs.length === 0 && (
              <div className="p-12 text-center">
                <div className="mx-auto h-12 w-12 rounded-2xl bg-brand-50 text-brand-600 flex items-center justify-center mb-3">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <div className="text-sm font-semibold text-ink-900">No migrations yet</div>
                <div className="text-sm text-ink-500 mt-1 mb-4">
                  Start your first Access → Dataverse migration to see it here.
                </div>
                <Button variant="primary" onClick={onStartNew}>
                  Start a migration
                </Button>
              </div>
            )}
            {jobs && jobs.length > 0 && (
              <Table>
                <THead>
                  <TR>
                    <TH>Job</TH>
                    <TH>Status</TH>
                    <TH>Solution</TH>
                    <TH>Created</TH>
                    <TH>Updated</TH>
                    <TH align="right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {jobs.map((job) => (
                    <TR
                      key={job.migrationJobId}
                      hoverable
                      onClick={() => onOpen(job.migrationJobId)}
                    >
                      <TD>
                        <div className="font-medium text-ink-900">{job.name || "(unnamed)"}</div>
                        <div className="text-xs text-ink-500 font-mono mt-0.5">
                          {job.migrationJobId.slice(0, 8)}…
                        </div>
                      </TD>
                      <TD>
                        <Badge tone={statusTone(job.status)}>{statusLabel(job.status)}</Badge>
                      </TD>
                      <TD>
                        <div className="text-ink-700">{job.targetSolutionName || "—"}</div>
                        {job.targetPublisherPrefix && (
                          <div className="text-xs text-ink-500 font-mono mt-0.5">
                            {job.targetPublisherPrefix}_
                          </div>
                        )}
                      </TD>
                      <TD>
                        <div className="text-sm">{relativeTime(job.createdOn)}</div>
                        <div className="text-xs text-ink-500">{formatDate(job.createdOn)}</div>
                      </TD>
                      <TD>
                        <div className="text-sm">{relativeTime(job.modifiedOn)}</div>
                      </TD>
                      <TD align="right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(job.migrationJobId);
                          }}
                        >
                          View →
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>
      </main>
    </>
  );
}

function KpiCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: "brand" | "success" | "info" | "danger";
}) {
  const ACCENTS = {
    brand: "from-brand-500/10 to-brand-500/0 text-brand-600",
    success: "from-emerald-500/10 to-emerald-500/0 text-emerald-600",
    info: "from-sky-500/10 to-sky-500/0 text-sky-600",
    danger: "from-rose-500/10 to-rose-500/0 text-rose-600",
  } as const;
  return (
    <Card padding="md" className={`bg-gradient-to-br ${ACCENTS[tone]}`}>
      <div className="text-xs uppercase tracking-wide text-ink-500 font-medium">{label}</div>
      <div className="text-2xl font-semibold text-ink-900 mt-1">{value}</div>
    </Card>
  );
}
