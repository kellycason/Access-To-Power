/**
 * Manifest contract emitted by the local Access helper (PAD flow or signed
 * .NET tray app) and consumed by the Code App. This is the seam between the
 * dumb local file reader and the Power Platform orchestrator.
 *
 * The helper is intentionally minimal: open the .accdb via ACE OLEDB, read
 * schema + rows, write this manifest, stream NDJSON row chunks, hand off to
 * Dataverse. It has NO product logic.
 */

export type AccessDataType =
  | "Text"
  | "Memo"
  | "Byte"
  | "Integer"
  | "Long"
  | "Single"
  | "Double"
  | "Currency"
  | "Decimal"
  | "DateTime"
  | "Boolean"
  | "Guid"
  | "Binary"
  | "OleObject"
  | "Attachment"
  | "Hyperlink"
  | "AutoNumber"
  | "Unknown";

export interface AccessColumn {
  /** Logical name as it exists in Access (e.g., "CustomerID"). */
  name: string;
  /** Inferred Access type, used to decide the Dataverse attribute type. */
  dataType: AccessDataType;
  /** Max length for text columns (Access default 255). */
  maxLength?: number;
  /** Numeric precision/scale (for Decimal/Currency). */
  precision?: number;
  scale?: number;
  /** True when the column is the (single or composite) primary key. */
  isPrimaryKey: boolean;
  /** True when the column is required (NOT NULL). */
  isRequired: boolean;
  /** True when Access marks the column as AutoNumber. */
  isAutoNumber: boolean;
  /** Default value expression as Access reported it (informational only). */
  defaultValue?: string;
  /** Column description from Access, if any. */
  description?: string;
  /**
   * True when scan-phase row sampling found every value at midnight, meaning
   * the column is logically date-only (no clock component). Drives a Dataverse
   * DateOnly attribute instead of DateAndTime. Permanent at create time.
   */
  detectedDateOnly?: boolean;
  /**
   * Max number of decimal digits observed in scan-phase samples for Single /
   * Double / Decimal columns. Used to decide whether Single/Double should be
   * promoted to Dataverse Decimal (precision &gt; 5) for fidelity.
   */
  detectedMaxDecimals?: number;
  /** Issues the helper found while reading this column. */
  issues?: ManifestIssue[];
}

export interface AccessRelationship {
  name: string;
  /** Name of the parent ("one" side) table. */
  parentTable: string;
  parentColumns: string[];
  /** Name of the child ("many" side) table. */
  childTable: string;
  childColumns: string[];
  /** Access "Enforce Referential Integrity" flag. */
  enforceReferentialIntegrity: boolean;
  cascadeUpdate: boolean;
  cascadeDelete: boolean;
}

export interface AccessTable {
  /** Logical name as it exists in Access. */
  name: string;
  /** Total row count reported by the helper at scan time. */
  rowCount: number;
  /** Path to the NDJSON file for this table's rows, relative to the manifest. */
  rowsFile: string;
  /** SHA-256 of the rows file. */
  rowsSha256?: string;
  columns: AccessColumn[];
  /** Indexes (informational; helps decide Dataverse alternate keys). */
  indexes?: Array<{
    name: string;
    columns: string[];
    unique: boolean;
  }>;
  /** Table-level issues. */
  issues?: ManifestIssue[];
}

export type ManifestIssueSeverity = "Info" | "Warning" | "Error";
export type ManifestIssueCategory =
  | "UnsupportedType"
  | "Truncated"
  | "Renamed"
  | "DataValidation"
  | "MissingPrimaryKey"
  | "CompositePrimaryKey"
  | "TextPrimaryKey"
  | "LinkedTable"
  | "DateOnly"
  | "FloatPrecisionLoss"
  | "SamplingSkipped"
  | "Other";

export interface ManifestIssue {
  severity: ManifestIssueSeverity;
  category: ManifestIssueCategory;
  message: string;
  /** Optional column/row reference. */
  table?: string;
  column?: string;
  rowOrdinal?: number;
}

export interface AccessSchemaManifest {
  /** Version of the manifest contract. */
  manifestVersion: "1.0";
  /** Stable identifier (GUID) for this migration job. */
  migrationJobId: string;
  /** Display name to show in the UI. */
  jobName: string;
  /** Absolute path to the source .accdb the helper opened. */
  sourcePath: string;
  /** File size of the source .accdb in bytes. */
  sourceSize: number;
  sourceSha256?: string;
  /** ISO 8601 timestamp produced by the helper. */
  capturedAt: string;
  /** Tool that emitted this manifest. */
  emittedBy: "PAD" | "DotNetHelper" | "Mock";
  emitterVersion: string;
  tables: AccessTable[];
  relationships: AccessRelationship[];
  /** Issues that span tables. */
  issues?: ManifestIssue[];
}

/* ----------------------------------------------------------------------- */
/* User-driven mapping decisions stored in Dataverse                       */
/* ----------------------------------------------------------------------- */

export type DataverseAttributeType =
  | "String"
  | "Memo"
  | "Integer"
  | "BigInt"
  | "Decimal"
  | "Money"
  | "Double"
  | "DateTime"
  | "DateOnly"
  | "Boolean"
  | "Uniqueidentifier"
  | "Lookup"
  | "Choice";

export interface FieldMapping {
  accessTable: string;
  accessColumn: string;
  /** Skip = don't migrate this column at all. */
  action: "Map" | "Skip";
  /** New = create/use a generated column; Existing = bind to an existing Dataverse column. */
  targetMode?: "new" | "existing";
  dataverseSchemaName: string;
  dataverseDisplayName: string;
  dataverseType: DataverseAttributeType;
  /** For String/Memo. */
  maxLength?: number;
  /** For Decimal/Money. */
  precision?: number;
  /** Mark as alternate key for idempotent re-runs (recommended for PKs). */
  isAlternateKey: boolean;
  /** Required at Dataverse level (note: not all Access-required cols can be). */
  isRequired: boolean;
  /** For Lookup: target Dataverse logical name. */
  lookupTarget?: string;
}

export interface TableMapping {
  accessTable: string;
  action: "Migrate" | "Skip";
  /** New = create a table; Existing = load into an existing Dataverse table. */
  targetMode?: "new" | "existing";
  dataverseSchemaName: string;
  dataverseDisplayName: string;
  dataversePluralName: string;
  dataverseEntitySetName?: string;
  /** Primary name column for the Dataverse table. */
  primaryNameAccessColumn?: string;
  fields: FieldMapping[];
}

export interface MigrationPlan {
  migrationJobId: string;
  manifest: AccessSchemaManifest;
  tableMappings: TableMapping[];
  /** When true, run the second-pass lookup patch after row inserts. */
  resolveLookupsAfterLoad: boolean;
  /** When true, fail fast on the first row-level error per table. */
  strictRowValidation: boolean;
}

/* ----------------------------------------------------------------------- */
/* NDJSON row chunk format                                                 */
/* ----------------------------------------------------------------------- */

/**
 * Each line in the rows NDJSON file is one row. Keys are Access column names.
 * Special handling:
 * - Dates serialized as ISO 8601 UTC strings.
 * - Booleans as true/false.
 * - Binary / OLE Object / Attachment columns are NEVER emitted (the helper
 *   logs a ManifestIssue with category "UnsupportedType").
 * - Memo fields stay as full strings.
 * - Currency / Decimal as JSON numbers (precision preserved by the helper).
 */
export type AccessRowValue = string | number | boolean | null;
export type AccessRow = Record<string, AccessRowValue>;
