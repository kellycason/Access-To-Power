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
  makeStyles,
} from "@fluentui/react-components";

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "16px", maxWidth: "720px" },
  card: { padding: "16px" },
  actions: { display: "flex", gap: "8px", justifyContent: "flex-end" },
});

interface Props {
  jobName: string;
  onJobNameChange: (v: string) => void;
  onJobCreated: (migrationJobId: string) => void;
}

/**
 * Step 1 — Connect.
 *
 * User names the job. The Code App calls Dataverse to create an
 * `acp_migrationjob` record (status = Draft) and returns its GUID.
 *
 * The local helper is launched here too. Two acceptable forms:
 *   - PAD flow triggered via Power Automate (v1 / demo)
 *   - Signed .NET tray app via `accesstopower://` protocol handler (v1.5)
 *
 * Either way, the contract is identical: a manifest + NDJSON files land in a
 * known location, then Step 2 (Scan) consumes them.
 */
export function ConnectStep({ jobName, onJobNameChange, onJobCreated }: Props) {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);

  async function createJob() {
    setBusy(true);
    // TODO: replace with Power Apps SDK call to create acp_migrationjob.
    await new Promise((r) => setTimeout(r, 300));
    const fakeId = crypto.randomUUID();
    setBusy(false);
    onJobCreated(fakeId);
  }

  return (
    <div className={styles.page}>
      <Title3>Connect to your Access database</Title3>
      <Body1>
        Name this migration job and launch the local Access helper. The helper
        opens your <code>.accdb</code> file and uploads its schema and data to
        Dataverse — no product logic runs locally.
      </Body1>
      <Card className={styles.card}>
        <CardHeader header={<strong>Migration job</strong>} />
        <Field label="Job name" required>
          <Input
            value={jobName}
            onChange={(_e, d) => onJobNameChange(d.value)}
            placeholder="e.g. Northwind 2025 cut-over"
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
      <div className={styles.actions}>
        <Button
          appearance="primary"
          disabled={!jobName.trim() || busy}
          onClick={createJob}
        >
          {busy ? "Creating job…" : "Create job & launch helper"}
        </Button>
      </div>
    </div>
  );
}
