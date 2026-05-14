import { useState } from "react";
import {
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Title3,
  Body1,
  MessageBar,
  MessageBarBody,
  Spinner,
  makeStyles,
} from "@fluentui/react-components";
import { getDataverseClient } from "../services/dataverseClient";

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "16px", maxWidth: "720px" },
  card: { padding: "16px", display: "flex", flexDirection: "column", gap: "12px" },
  actions: { display: "flex", gap: "8px", justifyContent: "flex-end" },
  hint: { color: "var(--colorNeutralForeground3)", fontSize: "12px" },
});

interface Props {
  jobName: string;
  onJobNameChange: (v: string) => void;
  onJobCreated: (migrationJobId: string) => void;
}

const PUB_PREFIX_RE = /^[a-z][a-z0-9]{1,7}$/;
const SOL_NAME_RE = /^[A-Za-z][A-Za-z0-9]+$/;

export function ConnectStep({ jobName, onJobNameChange, onJobCreated }: Props) {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [publisherPrefix, setPublisherPrefix] = useState("");
  const [solutionName, setSolutionName] = useState("");

  const prefixError =
    publisherPrefix && !PUB_PREFIX_RE.test(publisherPrefix)
      ? "Use 2-8 lowercase letters/digits, starting with a letter."
      : null;
  const solError =
    solutionName && !SOL_NAME_RE.test(solutionName)
      ? "Use letters and digits only; start with a letter."
      : null;

  const canSubmit = jobName.trim() && !prefixError && !solError && !busy;

  async function createJob() {
    setBusy(true);
    setError(null);
    try {
      const client = getDataverseClient();
      const trimmedName = jobName.trim();
      const derivedPrefix = publisherPrefix.trim() || sanitizePrefix(trimmedName);
      const derivedSolution = solutionName.trim() || sanitizeSolutionName(trimmedName);

      const { migrationJobId } = await client.createMigrationJob({
        name: trimmedName,
        targetSolutionName: derivedSolution,
        targetPublisherPrefix: derivedPrefix,
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
          A new solution and publisher will be created for the migrated tables.
          Defaults are derived from the job name; override here if you prefer.
        </Body1>
        <Field
          label="Publisher prefix"
          hint="2-8 lowercase letters, used to prefix the migrated table names (e.g. contoso_customer)."
          validationState={prefixError ? "error" : "none"}
          validationMessage={prefixError ?? undefined}
        >
          <Input
            value={publisherPrefix}
            onChange={(_e, d) => setPublisherPrefix(d.value.toLowerCase())}
            placeholder={sanitizePrefix(jobName) || "contoso"}
          />
        </Field>
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
