import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardHeader,
  Dropdown,
  Field,
  Input,
  Option,
  Radio,
  RadioGroup,
  Title3,
  Body1,
  MessageBar,
  MessageBarBody,
  Spinner,
  makeStyles,
} from "@fluentui/react-components";
import { getDataverseClient, type SolutionOption } from "../services/dataverseClient";

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "16px", maxWidth: "720px" },
  card: { padding: "16px", display: "flex", flexDirection: "column", gap: "12px" },
  actions: { display: "flex", gap: "8px", justifyContent: "flex-end" },
  hint: { color: "var(--colorNeutralForeground3)", fontSize: "12px" },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" },
  loadingLine: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    color: "var(--colorNeutralForeground3)",
    fontSize: "12px",
  },
});

interface Props {
  jobName: string;
  onJobNameChange: (v: string) => void;
  onJobCreated: (migrationJobId: string) => void;
}

const PUB_PREFIX_RE = /^[a-z][a-z0-9]{1,7}$/;
const SOL_NAME_RE = /^[A-Za-z][A-Za-z0-9]+$/;
type SolutionMode = "new" | "existing";

export function ConnectStep({ jobName, onJobNameChange, onJobCreated }: Props) {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [solutionsError, setSolutionsError] = useState<string | null>(null);
  const [solutionsLoading, setSolutionsLoading] = useState(false);
  const [solutions, setSolutions] = useState<SolutionOption[]>([]);

  const [solutionMode, setSolutionMode] = useState<SolutionMode>("new");
  const [publisherPrefix, setPublisherPrefix] = useState("");
  const [solutionName, setSolutionName] = useState("");
  const [selectedSolutionUniqueName, setSelectedSolutionUniqueName] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSolutionsLoading(true);
    setSolutionsError(null);
    getDataverseClient().listSolutions()
      .then((items) => {
        if (cancelled) return;
        setSolutions(items);
        setSelectedSolutionUniqueName((current) => current || items[0]?.uniqueName || "");
      })
      .catch((e) => {
        if (cancelled) return;
        setSolutionsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setSolutionsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const selectedSolution = useMemo(
    () => solutions.find((solution) => solution.uniqueName === selectedSolutionUniqueName) ?? null,
    [selectedSolutionUniqueName, solutions],
  );

  const derivedNewSolution = solutionName.trim() || sanitizeSolutionName(jobName);
  const derivedNewPrefix = publisherPrefix.trim() || sanitizePrefix(jobName);
  const duplicateSolution = solutionMode === "new" && derivedNewSolution
    ? solutions.find((solution) => solution.uniqueName.toLowerCase() === derivedNewSolution.toLowerCase()) ?? null
    : null;

  // Conflict check: if the typed prefix already belongs to a different
  // publisher (different solution mapping), Dataverse will reject creating
  // a second publisher with the same `customizationprefix`. Catch that here
  // (guide Part 5) instead of letting the helper fail mid-schema-phase.
  const conflictingPrefix = solutionMode === "new" && derivedNewPrefix
    ? solutions.find((s) => s.publisherPrefix.toLowerCase() === derivedNewPrefix.toLowerCase()) ?? null
    : null;

  const prefixError =
    solutionMode === "new" && publisherPrefix && !PUB_PREFIX_RE.test(publisherPrefix)
      ? "Use 2-8 lowercase letters/digits, starting with a letter."
      : solutionMode === "new" && conflictingPrefix
        ? `Prefix '${derivedNewPrefix}' is already used by publisher of solution '${conflictingPrefix.friendlyName}'. Pick a different prefix or use that existing solution.`
        : null;
  const solError =
    solutionMode === "new" && solutionName && !SOL_NAME_RE.test(solutionName)
      ? "Use letters and digits only; start with a letter."
      : null;

  const canSubmit = Boolean(
    jobName.trim() &&
    !prefixError &&
    !solError &&
    !duplicateSolution &&
    !busy &&
    (solutionMode === "new" ? derivedNewSolution && derivedNewPrefix : selectedSolution),
  );

  async function createJob() {
    setBusy(true);
    setError(null);
    try {
      const client = getDataverseClient();
      const trimmedName = jobName.trim();
      const targetSolutionName = solutionMode === "existing"
        ? selectedSolution?.uniqueName
        : derivedNewSolution;
      const targetPublisherPrefix = solutionMode === "existing"
        ? selectedSolution?.publisherPrefix
        : derivedNewPrefix;

      if (!targetSolutionName || !targetPublisherPrefix) {
        throw new Error("Choose a target solution before continuing.");
      }

      const { migrationJobId } = await client.createMigrationJob({
        name: trimmedName,
        targetSolutionName,
        targetPublisherPrefix,
      });
      onJobCreated(migrationJobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <Title3>Connect to your Access database</Title3>
      <Body1>
        Name this migration job and choose where the migrated tables should
        land. The local helper opens your <code>.accdb</code> file and uploads
        its schema and data to Dataverse — no product logic runs locally.
      </Body1>
      <Card className={styles.card}>
        <CardHeader header={<strong>Migration job</strong>} />
        <Field label="Job name" required>
          <Input
            value={jobName}
            onChange={(_e, d) => onJobNameChange(d.value)}
            placeholder="e.g. Northwind 2026 cut-over"
          />
        </Field>
      </Card>
      <Card className={styles.card}>
        <CardHeader header={<strong>Target solution &amp; publisher</strong>} />
        <Body1 className={styles.hint}>
          Create a dedicated solution for this migration, or place migrated
          tables into an existing unmanaged solution.
        </Body1>
        <RadioGroup
          layout="horizontal"
          value={solutionMode}
          onChange={(_e, d) => setSolutionMode(d.value as SolutionMode)}
        >
          <Radio value="new" label="Create new solution" />
          <Radio value="existing" label="Use existing solution" />
        </RadioGroup>

        {solutionsLoading && (
          <div className={styles.loadingLine} role="status" aria-live="polite">
            <Spinner size="tiny" />
            Loading existing solutions...
          </div>
        )}

        {solutionMode === "new" ? (
          <div className={styles.twoCol}>
            <Field
              label="Solution unique name"
              hint="Letters and digits, no spaces."
              validationState={solError ? "error" : "none"}
              validationMessage={solError ?? undefined}
            >
              <Input
                value={solutionName}
                onChange={(_e, d) => setSolutionName(d.value)}
                placeholder={sanitizeSolutionName(jobName) || "ContosoCRM"}
              />
            </Field>
            <Field
              label="Publisher prefix"
              hint="2-8 lowercase letters."
              validationState={prefixError ? "error" : "none"}
              validationMessage={prefixError ?? undefined}
            >
              <Input
                value={publisherPrefix}
                onChange={(_e, d) => setPublisherPrefix(d.value.toLowerCase())}
                placeholder={sanitizePrefix(jobName) || "contoso"}
              />
            </Field>
          </div>
        ) : (
          <Field
            label="Existing solution"
            hint={
              solutionsLoading
                ? "Loading unmanaged solutions from this environment."
                : selectedSolution
                  ? `Publisher prefix: ${selectedSolution.publisherPrefix}`
                  : undefined
            }
          >
            <Dropdown
              value={selectedSolution ? `${selectedSolution.friendlyName} (${selectedSolution.uniqueName})` : ""}
              selectedOptions={selectedSolutionUniqueName ? [selectedSolutionUniqueName] : []}
              onOptionSelect={(_e, d) => setSelectedSolutionUniqueName(String(d.optionValue ?? ""))}
              disabled={solutionsLoading || solutions.length === 0}
              placeholder={solutionsLoading ? "Loading solutions..." : "Choose a solution"}
            >
              {solutions.map((solution) => (
                <Option
                  key={solution.solutionId}
                  value={solution.uniqueName}
                  text={`${solution.friendlyName} (${solution.uniqueName})`}
                >
                  {solution.friendlyName} ({solution.uniqueName})
                </Option>
              ))}
            </Dropdown>
          </Field>
        )}

        {duplicateSolution && (
          <MessageBar intent="warning">
            <MessageBarBody>
              A solution named <strong>{duplicateSolution.uniqueName}</strong> already exists.
              Choose "Use existing solution" to target it, or enter a different unique name.
            </MessageBarBody>
          </MessageBar>
        )}
        {solutionsError && (
          <MessageBar intent="warning">
            <MessageBarBody>
              Existing solutions could not be loaded: {solutionsError}
            </MessageBarBody>
          </MessageBar>
        )}
      </Card>
      <MessageBar intent="info">
        <MessageBarBody>
          The local helper requires the 64-bit Microsoft Access Database Engine.
          Forms, reports, macros, VBA, queries, attachments, and OLE objects
          are NOT migrated — only tables, columns, relationships, and data.
        </MessageBarBody>
      </MessageBar>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      <div className={styles.actions}>
        <Button
          appearance="primary"
          disabled={!canSubmit}
          onClick={createJob}
          icon={busy ? <Spinner size="tiny" /> : undefined}
        >
          {busy ? "Creating job…" : "Create job & continue"}
        </Button>
      </div>
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
