import type {
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
 * - Unsupported types (Binary, OleObject, Attachment) are auto-skipped.
 * - Relationships are not realised here — they're applied in the
 *   CreateDataverseSchema flow once all tables exist.
 */
export function buildDefaultPlan(
  manifest: AccessSchemaManifest,
  publisherPrefix: string,
): MigrationPlan {
  const prefix = publisherPrefix.toLowerCase();
  const tableMappings: TableMapping[] = manifest.tables.map((t) => {
    const schema = `${prefix}_${slug(t.name)}`;
    const primaryName =
      t.columns.find((c) => c.dataType === "Text" && !c.isAutoNumber)?.name ??
      t.columns[0]?.name;

    return {
      accessTable: t.name,
      action: "Migrate",
      dataverseSchemaName: schema,
      dataverseDisplayName: t.name,
      dataversePluralName: pluralize(t.name),
      primaryNameAccessColumn: primaryName,
      fields: t.columns.map((c) => {
        const supported = isSupported(c.dataType);
        const dvType = mapType(c.dataType);
        return {
          accessTable: t.name,
          accessColumn: c.name,
          action: supported ? "Map" : "Skip",
          dataverseSchemaName: `${prefix}_${slug(c.name)}`,
          dataverseDisplayName: c.name,
          dataverseType: dvType,
          maxLength: c.maxLength,
          precision: c.precision,
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

function isSupported(t: string): boolean {
  return !["Binary", "OleObject", "Attachment", "Unknown"].includes(t);
}

function mapType(t: string): TableMapping["fields"][number]["dataverseType"] {
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
      return "Double";
    case "Decimal":
      return "Decimal";
    case "Currency":
      return "Money";
    case "DateTime":
      return "DateTime";
    case "Boolean":
      return "Boolean";
    default:
      return "String";
  }
}

function slug(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 50);
}

function pluralize(name: string): string {
  if (/(s|x|z|ch|sh)$/i.test(name)) return `${name}es`;
  if (/[^aeiou]y$/i.test(name)) return name.replace(/y$/i, "ies");
  return `${name}s`;
}
