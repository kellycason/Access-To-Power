/**
 * Status enums and shapes for the Dataverse-backed migration records.
 * Mirrors the schema in `dataverse/migration-schema.yml`.
 */

export type MigrationJobStatus =
  | "Draft"
  | "Scanning"
  | "Mapping"
  | "ReadyToMigrate"
  | "CreatingSchema"
  | "LoadingData"
  | "ResolvingLookups"
  | "Validating"
  | "Succeeded"
  | "PartiallySucceeded"
  | "Failed"
  | "Cancelled";

export type MigrationTableStatus =
  | "Pending"
  | "SchemaCreated"
  | "Loading"
  | "Loaded"
  | "LookupsResolved"
  | "Validated"
  | "Skipped"
  | "Failed";

export interface MigrationJobRow {
  id: string;
  name: string;
  status: MigrationJobStatus;
  sourceFileName: string;
  sourceFileSize: number;
  tableCount: number;
  rowCount: number;
  rowsMigrated: number;
  issuesCount: number;
  startedOn?: string;
  completedOn?: string;
}

export interface MigrationTableRow {
  id: string;
  jobId: string;
  accessTableName: string;
  dataverseSchemaName: string;
  status: MigrationTableStatus;
  rowsExpected: number;
  rowsLoaded: number;
  rowsFailed: number;
}

export interface MigrationIssueRow {
  id: string;
  jobId: string;
  severity: "Info" | "Warning" | "Error";
  category: string;
  table?: string;
  column?: string;
  rowOrdinal?: number;
  message: string;
  createdOn: string;
}
