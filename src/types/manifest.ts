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
  /**
   * Discovered value-list labels for Lookup-Wizard-style columns (read via
   * DAO since OLEDB doesn't expose RowSourceType / RowSource). When present
   * the plan builder upgrades the column to a Dataverse Choice attribute and
   * materializes integer codes for each label.
   */
  valueList?: string[];
  /** True when DAO reports LimitToList=true on the column (informational). */
  limitToList?: boolean;
  /**
   * Set when the column carries data that can't be represented in Dataverse
   * via the baseline migration (multi-value lookup, attachment, OLE blob).
   * The column's row values are emitted as null in NDJSON and the migration
   * report surfaces the column under "dropped" so the user sees it.
   *
   * NOTE: "Binary"/"OleObject"/"Attachment" no longer mean "dropped" —
   * the plan builder routes them to Dataverse File / Image columns or
   * note annotations (see binaryHint + FieldMapping.dataverseType).
   * The reason string is retained for UI labelling and source-of-truth
   * about the original Access type.
   */
  unsupportedReason?:
    | "Multivalue"
    | "Attachment"
    | "OleObject"
    | "Binary";
  /**
   * Scan-phase evidence about what binary bytes actually look like. Used by
   * the plan builder to default Binary/OleObject columns to either a File
   * column (generic blob) or an Image column (when image magic bytes were
   * detected). Absent when the column has no rows or no bytes survived
   * sampling. `hasOleWrapper` flags Access OLE Package envelopes — the data
   * loader strips that prefix before upload so consumers get a clean file.
   */
  binaryHint?: {
    detectedKind: "image" | "pdf" | "document" | "binary";
    sampleMime?: string;
    hasOleWrapper?: boolean;
    /** Largest byte count observed across sampled rows. */
    maxBytes?: number;
    /** Number of rows the helper sampled to produce this hint. */
    sampleSize?: number;
  };
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
  | "Choice"
  /** Dataverse File column — stores any blob. Bytes uploaded out-of-band. */
  | "File"
  /** Dataverse Image column — stores image bytes with thumbnails. */
  | "Image"
  /**
   * Special sentinel: not a Dataverse column. Bytes for the row are written
   * as an `annotation` (note) attachment instead. SchemaCreator skips it;
   * DataLoader uploads via POST /annotations after row insert.
   */
  | "NoteAttachment";

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
  /**
   * For Choice: materialized option list (label → integer value). Populated
   * by the plan builder when the source column has a valueList. SchemaCreator
   * uses it to build the inline OptionSet at attribute-create time; the data
   * loader uses it to translate raw row labels into integer values at insert.
   */
  choiceOptions?: Array<{ value: number; label: string }>;
  /**
   * For File / Image columns: max size in KB written into the attribute
   * metadata at create time. Defaults: File = 32768 (32 MB),
   * Image = 30720 (30 MB). Plan builder may bump this when scan-phase
   * sampling saw a larger blob.
   */
  binaryMaxSizeKb?: number;
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
 * - Binary / OLE Object / Attachment cells are NEVER emitted in NDJSON
 *   (would bloat annotation storage). The migrate phase re-opens the
 *   source .accdb on the local machine to stream bytes directly into
 *   Dataverse File / Image columns or note annotations.
 * - Memo fields stay as full strings.
 * - Currency / Decimal as JSON numbers (precision preserved by the helper).
 */
export type AccessRowValue = string | number | boolean | null;
export type AccessRow = Record<string, AccessRowValue>;
