import { useEffect, useState } from "react";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Card, CardHeader } from "../ui/Card";
import { Input } from "../ui/Input";
import { Spinner } from "../ui/Spinner";
import { cx } from "../ui/cx";
import { HelperInstallPanel } from "../ui/HelperInstallPanel";
import { getDataverseClient, type SolutionOption } from "../services/dataverseClient";

interface Props {
  jobName: string;
  onJobNameChange: (v: string) => void;
  onJobCreated: (migrationJobId: string) => void;
}

const PUB_PREFIX_RE = /^[a-z][a-z0-9]{1,7}$/;
const SOL_NAME_RE = /^[A-Za-z][A-Za-z0-9]+$/;

export function ConnectStep({ jobName, onJobNameChange, onJobCreated }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [solutionsError, setSolutionsError] = useState<string | null>(null);
  const [solutionsLoading, setSolutionsLoading] = useState(false);
  const [solutions, setSolutions] = useState<SolutionOption[]>([]);
  // All publisher prefixes in this environment (lowercased) — independent of
  // which solutions are surfaced in listSolutions(). Used to refuse a new
  // prefix that collides with ANY existing publisher (managed/unmanaged/orphan).
  const [allPublisherPrefixes, setAllPublisherPrefixes] = useState<string[]>([]);

  const [solutionFriendlyName, setSolutionFriendlyName] = useState("");
  const [publisherPrefix, setPublisherPrefix] = useState("");
  const [solutionName, setSolutionName] = useState("");
  // Track whether the user has manually edited the unique name / prefix so we
  // know whether to keep auto-filling them from the friendly name.
  const [solutionNameEdited, setSolutionNameEdited] = useState(false);
  const [publisherPrefixEdited, setPublisherPrefixEdited] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSolutionsLoading(true);
    setSolutionsError(null);
    const client = getDataverseClient();
    Promise.all([client.listSolutions(), client.listAllPublisherPrefixes()])
      .then(([items, prefixes]) => {
        if (cancelled) return;
        setSolutions(items);
        setAllPublisherPrefixes(prefixes);
      })
      .catch((e) => {
        if (cancelled) return;
        setSolutionsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setSolutionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const nameSource = solutionFriendlyName.trim() || jobName;
  const derivedNewSolution = solutionName.trim() || sanitizeSolutionName(nameSource);
  const derivedNewPrefix = publisherPrefix.trim() || sanitizePrefix(nameSource);
  const duplicateSolution = derivedNewSolution
    ? solutions.find((s) => s.uniqueName.toLowerCase() === derivedNewSolution.toLowerCase()) ?? null
    : null;
  const conflictingPrefix = derivedNewPrefix
    ? solutions.find((s) => s.publisherPrefix.toLowerCase() === derivedNewPrefix.toLowerCase()) ?? null
    : null;
  // A prefix that doesn't belong to any unmanaged+visible solution may still be
  // taken by another publisher in the environment (managed solution, orphan
  // publisher, etc.). Refuse those too so the helper doesn't fail mid-flight.
  const prefixTakenByOtherPublisher =
    derivedNewPrefix && !conflictingPrefix
      ? allPublisherPrefixes.includes(derivedNewPrefix.toLowerCase())
      : false;

  const prefixError =
    publisherPrefix && !PUB_PREFIX_RE.test(publisherPrefix)
      ? "Use 2-8 lowercase letters/digits, starting with a letter."
      : conflictingPrefix
        ? `Prefix '${derivedNewPrefix}' is already used by publisher of solution '${conflictingPrefix.friendlyName}'. Pick a different prefix.`
        : prefixTakenByOtherPublisher
          ? `Prefix '${derivedNewPrefix}' is already taken by another publisher in this environment. Pick a different prefix.`
          : null;
  const solError =
    solutionName && !SOL_NAME_RE.test(solutionName)
      ? "Use letters and digits only; start with a letter."
      : null;

  const canSubmit = Boolean(
    jobName.trim() &&
      !prefixError &&
      !solError &&
      !duplicateSolution &&
      !busy &&
      derivedNewSolution &&
      derivedNewPrefix,
  );

  async function createJob() {
    setBusy(true);
    setError(null);
    try {
      const client = getDataverseClient();
      const trimmedName = jobName.trim();
      const { migrationJobId } = await client.createMigrationJob({
        name: trimmedName,
        targetSolutionName: derivedNewSolution,
        targetPublisherPrefix: derivedNewPrefix,
      });
      onJobCreated(migrationJobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <Card>
        <CardHeader title="Migration job" description="Give this run a memorable name." />
        <Input
          label="Job name"
          value={jobName}
          onChange={(e) => onJobNameChange(e.target.value)}
          placeholder="e.g. Northwind 2026 cut-over"
        />
      </Card>

      <Card>
        <CardHeader
          title="Target solution & publisher"
          description="A dedicated unmanaged solution and publisher will be created for this migration."
        />

        <div className="mb-4">
          <ModeTile
            active
            title="Create new solution"
            description="Spin up a fresh unmanaged solution and publisher."
          />
        </div>

        {solutionsLoading && (
          <div className="flex items-center gap-2 text-xs text-ink-500 mb-2">
            <Spinner size={12} /> Checking existing solutions and publishers…
          </div>
        )}

        <div className="mb-4">
          <Input
            label="Solution name"
            hint="Friendly display name. Auto-fills the unique name and prefix below."
            value={solutionFriendlyName}
            onChange={(e) => setSolutionFriendlyName(e.target.value)}
            placeholder={jobName || "Contoso CRM"}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="Solution unique name"
            hint="Letters and digits, no spaces."
            value={solutionNameEdited ? solutionName : derivedNewSolution}
            onChange={(e) => {
              setSolutionNameEdited(true);
              setSolutionName(e.target.value);
            }}
            placeholder={sanitizeSolutionName(nameSource) || "ContosoCRM"}
            error={solError ?? undefined}
          />
          <Input
            label="Publisher prefix"
            hint="2-8 lowercase letters."
            value={publisherPrefixEdited ? publisherPrefix : derivedNewPrefix}
            onChange={(e) => {
              setPublisherPrefixEdited(true);
              setPublisherPrefix(e.target.value.toLowerCase());
            }}
            placeholder={sanitizePrefix(nameSource) || "contoso"}
            error={prefixError ?? undefined}
          />
        </div>

        {duplicateSolution && (
          <Alert intent="warning" className="mt-3">
            A solution named <strong>{duplicateSolution.uniqueName}</strong> already exists in this
            environment. Enter a different unique name.
          </Alert>
        )}
        {solutionsError && (
          <Alert intent="warning" className="mt-3">
            Existing solutions could not be loaded: {solutionsError}
          </Alert>
        )}
      </Card>

      <Alert intent="info" title="Before you start">
        The local helper requires the 64-bit Microsoft Access Database Engine. Forms, reports,
        macros, VBA, queries, attachments, and OLE objects are <strong>not</strong> migrated — only
        tables, columns, relationships, and data.
      </Alert>

      <HelperInstallPanel />

      {error && <Alert intent="error">{error}</Alert>}

      <div className="flex justify-end">
        <Button variant="primary" size="lg" disabled={!canSubmit} onClick={createJob} loading={busy}>
          {busy ? "Creating job…" : "Create job & continue"}
        </Button>
      </div>
    </div>
  );
}

function ModeTile({
  active,
  title,
  description,
}: {
  active: boolean;
  title: string;
  description: string;
}) {
  return (
    <div
      className={cx(
        "text-left rounded-xl border-2 p-4 transition",
        active
          ? "border-brand-500 bg-brand-50"
          : "border-ink-200 bg-white",
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <div
          className={cx(
            "h-4 w-4 rounded-full border-2 flex items-center justify-center transition",
            active ? "border-brand-500 bg-brand-500" : "border-ink-300",
          )}
        >
          {active && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
        </div>
        <div className="text-sm font-semibold text-ink-900">{title}</div>
      </div>
      <div className="text-xs text-ink-500 ml-6">{description}</div>
    </div>
  );
}

function sanitizePrefix(name: string): string {
  const lower = name.toLowerCase().replace(/[^a-z]/g, "");
  if (!lower) return "";
  return lower.slice(0, 8);
}

function sanitizeSolutionName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9]/g, "");
  if (!clean) return "";
  return /^[A-Za-z]/.test(clean) ? clean : "Sol" + clean;
}
