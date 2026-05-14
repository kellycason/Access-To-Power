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
  Tag,
  makeStyles,
} from "@fluentui/react-components";
import type { ValidationReport } from "../services/validator";

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "16px" },
  actions: { display: "flex", justifyContent: "space-between" },
});

interface Props {
  migrationJobId: string | null;
  report: ValidationReport | null;
  onBack: () => void;
  onRestart: () => void;
}

export function ValidateStep({ migrationJobId, report, onBack, onRestart }: Props) {
  const styles = useStyles();
  const intent =
    report?.overallStatus === "ok" ? "success" :
    report?.overallStatus === "mismatch" ? "warning" :
    report?.overallStatus === "error" ? "error" : "info";

  return (
    <div className={styles.page}>
      <Title3>Validation & remediation report</Title3>
      <Body1>
        Job: <code>{migrationJobId ?? "(none)"}</code>
      </Body1>
      <MessageBar intent={intent}>
        <MessageBarBody>
          {!report && "Migration not run yet."}
          {report?.overallStatus === "ok" &&
            `All ${report.tables.length} tables match expected row counts (${report.totalActual.toLocaleString()} rows).`}
          {report?.overallStatus === "mismatch" &&
            `${report.tables.filter((t) => t.status !== "ok").length} of ${report.tables.length} tables have row count mismatches.`}
          {report?.overallStatus === "error" &&
            "One or more tables could not be validated. See details below."}
        </MessageBarBody>
      </MessageBar>
      <Table size="small">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Access table</TableHeaderCell>
            <TableHeaderCell>Dataverse table</TableHeaderCell>
            <TableHeaderCell>Expected</TableHeaderCell>
            <TableHeaderCell>Actual</TableHeaderCell>
            <TableHeaderCell>Delta</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!report && (
            <TableRow>
              <TableCell colSpan={6}><em>No validation data yet.</em></TableCell>
            </TableRow>
          )}
          {report?.tables.map((t) => (
            <TableRow key={t.dataverseTable}>
              <TableCell>{t.accessTable}</TableCell>
              <TableCell><code>{t.dataverseTable}</code></TableCell>
              <TableCell>{t.expectedRows.toLocaleString()}</TableCell>
              <TableCell>{t.actualRows.toLocaleString()}</TableCell>
              <TableCell>{t.delta >= 0 ? `+${t.delta}` : t.delta}</TableCell>
              <TableCell>
                <Tag appearance={t.status === "ok" ? "outline" : "filled"}>
                  {t.status}
                </Tag>
              </TableCell>
            </TableRow>
          ))}
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
