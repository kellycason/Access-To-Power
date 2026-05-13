import {
  Button,
  Body1,
  Title3,
  MessageBar,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
} from "@fluentui/react-components";

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "16px" },
  actions: { display: "flex", justifyContent: "space-between" },
});

interface Props {
  migrationJobId: string | null;
  onBack: () => void;
  onRestart: () => void;
}

/**
 * Step 5 — Validate. Displays the remediation report (acp_migrationissue
 * rows) and final row counts. In production, this view is read directly out
 * of Dataverse.
 */
export function ValidateStep({ migrationJobId, onBack, onRestart }: Props) {
  const styles = useStyles();
  return (
    <div className={styles.page}>
      <Title3>Validation & remediation report</Title3>
      <Body1>
        Job: <code>{migrationJobId ?? "(none)"}</code>
      </Body1>
      <MessageBar intent="success">
        <MessageBarBody>
          Migration completed. Review any issues below; export the report or
          start a new migration.
        </MessageBarBody>
      </MessageBar>
      <Table size="small">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Severity</TableHeaderCell>
            <TableHeaderCell>Category</TableHeaderCell>
            <TableHeaderCell>Table / Column</TableHeaderCell>
            <TableHeaderCell>Message</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {/* TODO: bind to acp_migrationissue records for this job. */}
          <TableRow>
            <TableCell colSpan={4}>
              <em>No issues recorded (placeholder).</em>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <div className={styles.actions}>
        <Button onClick={onBack}>Back</Button>
        <Button appearance="primary" onClick={onRestart}>
          Start new migration
        </Button>
      </div>
    </div>
  );
}
