import type {
  AccessColumn,
  AccessSchemaManifest,
  MigrationPlan,
  TableMapping,
} from "../types/manifest";

/**
 * Build a default MigrationPlan from a freshly scanned manifest.
 *
 * Rules:
 * - Every Access table maps to a Dataverse table with the configured prefix.
 * - Every Access column maps to a sensible Dataverse type (see typeMap).
 * - Primary keys are flagged as alternate keys (idempotent re-runs).
 * - Foreign-key source columns default to Skip because Dataverse lookups
 *   preserve the relationship and the raw FK value is still read from NDJSON.
 * - Unsupported types (Binary, OleObject, Attachment) are auto-skipped.
 * - Relationships are not realised here — they're applied in the
 *   CreateDataverseSchema flow once all tables exist.
 */
export function buildDefaultPlan(
  manifest: AccessSchemaManifest,
  publisherPrefix: string,
): MigrationPlan {
  const prefix = publisherPrefix.toLowerCase();
  const foreignKeyColumns = collectForeignKeyColumns(manifest);
  const usedTableSchemas = new Set<string>();

  // Surface PK shape gotchas (guide Part 3) so the customer sees them in the
  // MapStep UI before we lose the original keys in Dataverse:
  //  - Text PKs: Dataverse always generates a GUID, so the original text
  //    value survives only as an alternate key. We'll create one automatically
  //    during the schema phase.
  //  - Composite PKs: not modelable directly; we keep only the first column
  //    as an alt-key candidate (re-run upserts won't be unique).
  //  - No PK at all: surrogate GUID will be generated, but re-runs will
  //    insert duplicates.
  manifest.issues ??= [];
  for (const t of manifest.tables) {
    const pkCols = t.columns.filter((c) => c.isPrimaryKey);
    if (pkCols.length > 1) {
      manifest.issues.push({
        severity: "Warning",
        category: "CompositePrimaryKey",
        message: `Table '${t.name}' has a composite primary key (${pkCols
          .map((c) => c.name)
          .join(", ")}). Dataverse will generate a GUID; only the first column will become an alternate key.`,
        table: t.name,
      });
    } else if (pkCols.length === 1 && pkCols[0].dataType !== "Long" && pkCols[0].dataType !== "Integer" && !pkCols[0].isAutoNumber) {
      manifest.issues.push({
        severity: "Info",
        category: "TextPrimaryKey",
        message: `Table '${t.name}' uses a non-integer primary key '${pkCols[0].name}' (${pkCols[0].dataType}). Dataverse will generate a GUID and preserve '${pkCols[0].name}' as an alternate key so re-runs can upsert.`,
        table: t.name,
        column: pkCols[0].name,
      });
    }

    // N:N junction-table detection (guide Part 4). A junction is a table whose
    // non-PK columns are exactly two FK columns referencing two different
    // tables. We warn so the migrator knows a native Dataverse N:N may be a
    // better fit — for the baseline we still load it as a regular entity so
    // no data is lost.
    const fkCols = manifest.relationships
      .filter((r) => r.childTable.toLowerCase() === t.name.toLowerCase() && r.childColumns.length === 1)
      .map((r) => ({ col: r.childColumns[0], parent: r.parentTable }));
    const nonPkNonFkCount = t.columns.filter(
      (c) => !c.isPrimaryKey && !fkCols.some((fk) => fk.col.toLowerCase() === c.name.toLowerCase()),
    ).length;
    if (fkCols.length === 2 && fkCols[0].parent !== fkCols[1].parent && nonPkNonFkCount === 0) {
      manifest.issues.push({
        severity: "Info",
        category: "Other",
        message: `Table '${t.name}' looks like an N:N junction between '${fkCols[0].parent}' and '${fkCols[1].parent}'. It will be migrated as a regular entity; consider a Dataverse N:N relationship if you don't need extra columns on it.`,
        table: t.name,
      });
    }
  }

  const tableMappings: TableMapping[] = manifest.tables.map((t) => {
    // Access tables are almost always plural ("Orders"). Dataverse auto-
    // pluralizes the logical name to produce the OData EntitySetName, so
    // feeding it a plural like `acp_orders` yields the ugly `acp_orderses`.
    // We default the logical name and display name to the singular form;
    // the user can override both in MapStep before migrating.
    const singularName = singularize(t.name);
    const tableSlug = sanitizeSchemaSegment(singularName, prefix.length, usedTableSchemas, "table");
    usedTableSchemas.add(tableSlug);
    const schema = `${prefix}_${tableSlug}`;
    const primaryName =
      t.columns.find((c) => c.dataType === "Text" && !c.isAutoNumber)?.name ??
      t.columns[0]?.name;

    const usedColumnSchemas = new Set<string>();
    return {
      accessTable: t.name,
      action: "Migrate",
      targetMode: "new",
      dataverseSchemaName: schema,
      dataverseDisplayName: singularName,
      dataversePluralName: pluralize(singularName),
      primaryNameAccessColumn: primaryName,
      fields: t.columns.map((c) => {
        const supported = isSupported(c.dataType);
        const isForeignKey = foreignKeyColumns.has(`${t.name}\u0000${c.name}`);
        const dvType = isForeignKey ? "Lookup" : mapType(c.dataType, c);
        const colSlug = sanitizeSchemaSegment(c.name, prefix.length, usedColumnSchemas, "column");
        usedColumnSchemas.add(colSlug);
        // Promote Single/Double to Decimal when scan-phase saw more decimal
        // digits than Float's 5-digit cap (guide Part 2).
        const precision =
          dvType === "Decimal" && (c.dataType === "Single" || c.dataType === "Double")
            ? Math.min(c.detectedMaxDecimals ?? 5, 10)
            : c.precision;
        return {
          accessTable: t.name,
          accessColumn: c.name,
          action: supported ? "Map" : "Skip",
          targetMode: "new",
          dataverseSchemaName: `${prefix}_${colSlug}`,
          dataverseDisplayName: c.name,
          dataverseType: dvType,
          maxLength: c.maxLength,
          precision,
          isAlternateKey: c.isPrimaryKey,
          isRequired: c.isRequired,
        };
      }),
    };
  });

  return {
    migrationJobId: manifest.migrationJobId,
    manifest,
    tableMappings,
    resolveLookupsAfterLoad: manifest.relationships.length > 0,
    strictRowValidation: false,
  };
}

function collectForeignKeyColumns(manifest: AccessSchemaManifest): Set<string> {
  const columns = new Set<string>();
  for (const rel of manifest.relationships) {
    if (rel.childColumns.length !== 1) continue;
    columns.add(`${rel.childTable}\u0000${rel.childColumns[0]}`);
  }
  return columns;
}

function isSupported(t: string): boolean {
  return !["Binary", "OleObject", "Attachment", "Unknown"].includes(t);
}

function mapType(t: string, col?: AccessColumn): TableMapping["fields"][number]["dataverseType"] {
  switch (t) {
    case "Text":
    case "Hyperlink":
    case "Guid":
      return "String";
    case "Memo":
      return "Memo";
    case "Byte":
    case "Integer":
    case "Long":
    case "AutoNumber":
      return "Integer";
    case "Single":
    case "Double":
      // Promote to Decimal when sampling saw more decimal digits than Float
      // can represent (guide Part 2). Otherwise keep as Double.
      return col && (col.detectedMaxDecimals ?? 0) > 5 ? "Decimal" : "Double";
    case "Decimal":
      return "Decimal";
    case "Currency":
      return "Money";
    case "DateTime":
      // Logical Dataverse type. SchemaCreator emits a DateTime attribute
      // with Format=DateOnly + DateTimeBehavior=DateOnly. Permanent at create.
      return col?.detectedDateOnly ? "DateOnly" : "DateTime";
    case "Boolean":
      return "Boolean";
    default:
      return "String";
  }
}

// Total Dataverse schema name max is 50 chars (prefix + "_" + slug).
const MAX_TOTAL_SCHEMA_LENGTH = 50;

// Reserved Dataverse logical names — using one of these for a custom table
// or column results in a 0x8004f021 conflict at create time. Source: guide
// Part 6 + Dataverse base entity column list.
const RESERVED_LOGICAL_NAMES = new Set<string>([
  "name", "status", "statecode", "statuscode", "type", "id", "owner",
  "owninguser", "owningteam", "owningbusinessunit",
  "createdon", "createdby", "modifiedon", "modifiedby",
  "versionnumber", "importsequencenumber", "overriddencreatedon",
  "timezoneruleversionnumber", "utcconversiontimezonecode",
]);

/**
 * Normalize an Access identifier into a Dataverse-safe schema-name segment.
 *
 * Guarantees:
 *  - lowercase, only [a-z0-9_]
 *  - never starts with a digit (prepends `t_` / `c_` fallback)
 *  - not in {@link RESERVED_LOGICAL_NAMES} (appended `_x` if so)
 *  - unique within `used` (numeric suffix `_2`, `_3`, … if collision)
 *  - total length with prefix never exceeds {@link MAX_TOTAL_SCHEMA_LENGTH}
 *  - never empty (falls back to `t` / `c`)
 */
function sanitizeSchemaSegment(
  raw: string,
  prefixLength: number,
  used: Set<string>,
  kind: "table" | "column",
): string {
  // +1 for the underscore between prefix and segment.
  const maxSegmentLength = Math.max(1, MAX_TOTAL_SCHEMA_LENGTH - prefixLength - 1);
  const fallback = kind === "table" ? "tbl" : "col";

  let s = (raw ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  if (s.length === 0) s = fallback;
  if (/^[0-9]/.test(s)) s = `${kind === "table" ? "t" : "c"}_${s}`;
  if (RESERVED_LOGICAL_NAMES.has(s)) s = `${s}_x`;

  // Truncate to fit; reserve 4 chars for a potential dedupe suffix like "_99".
  const reserveForSuffix = 4;
  const baseMax = Math.max(1, maxSegmentLength - reserveForSuffix);
  if (s.length > baseMax) s = s.slice(0, baseMax).replace(/_+$/g, "");
  if (s.length === 0) s = fallback;

  // Dedupe.
  let candidate = s;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${s}_${n}`;
    if (candidate.length > maxSegmentLength) {
      const trim = candidate.length - maxSegmentLength;
      candidate = `${s.slice(0, s.length - trim)}_${n}`;
    }
    n++;
    if (n > 999) {
      // Pathological — bail with a guid suffix.
      candidate = `${fallback}_${Math.random().toString(36).slice(2, 8)}`;
      break;
    }
  }
  return candidate;
}

function pluralize(name: string): string {
  // Access tables are almost always already plural ("Orders", "Customers",
  // "Categories"). If a name already looks plural, leave it alone — appending
  // 'es' yields ridiculous DisplayCollectionName values like "Orderses".
  if (/(ses|xes|zes|ches|shes|ies)$/i.test(name)) return name; // already pluralized form
  if (/s$/i.test(name)) return name; // ends in 's' but not a special plural ending
  if (/(x|z|ch|sh)$/i.test(name)) return `${name}es`;
  if (/[^aeiou]y$/i.test(name)) return name.replace(/y$/i, "ies");
  return `${name}s`;
}

/**
 * Best-effort English singularizer for Access table names. Conservative —
 * only rewrites forms we can confidently invert. Words like "Status",
 * "Address", "Analysis", "News" are left alone (ends in `ss`/`us`/`is`/`ews`).
 *
 *   Categories → Category   (ies → y)
 *   Boxes      → Box        (xes → x)
 *   Dishes     → Dish       (shes → sh)
 *   Watches    → Watch      (ches → ch)
 *   Quizzes    → Quiz       (zzes → z)
 *   Buses      → Bus        (uses → us only when preceded by vowel+s — skipped)
 *   Orders     → Order      (s → ø)
 *   Suppliers  → Supplier   (s → ø)
 */
function singularize(name: string): string {
  if (!name) return name;
  // Leave alone: ends in ss/us/is/ews (Status, Address, Analysis, News).
  if (/(ss|us|is|ews)$/i.test(name)) return name;
  // -ies → -y  (Categories → Category, but not "Series", caught above? "Series" ends in "ies" but also is its own plural — leave it alone if 4 chars or fewer.)
  if (/ies$/i.test(name) && name.length > 4) return name.replace(/ies$/i, "y");
  // -zzes → -z (Quizzes → Quiz)
  if (/zzes$/i.test(name)) return name.replace(/zzes$/i, "z");
  // -ches/-shes/-xes/-ses/-zes → drop "es"
  if (/(ches|shes|xes|ses|zes)$/i.test(name)) return name.replace(/es$/i, "");
  // Generic trailing -s (Orders → Order, Suppliers → Supplier).
  if (/s$/i.test(name)) return name.replace(/s$/i, "");
  return name;
}
