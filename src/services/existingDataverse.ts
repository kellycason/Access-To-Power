import type { FieldMapping } from "../types/manifest";
import { apiBase } from "./apiBase";

export interface ExistingTableMatch {
  logicalName: string;
  schemaName: string;
  entitySetName: string;
  displayName: string;
  displayCollectionName: string;
  isCustomEntity: boolean;
  score: number;
  matchedKeywords: string[];
}

export interface ExistingColumnMatch {
  logicalName: string;
  schemaName: string;
  displayName: string;
  attributeType: string;
  isValidForCreate: boolean;
  isPrimaryId: boolean;
  isPrimaryName: boolean;
  score: number;
}

interface SearchOptions {
  envUrl: string;
  accessTableName: string;
  signal?: AbortSignal;
}

interface ColumnOptions {
  envUrl: string;
  tableLogicalName: string;
  signal?: AbortSignal;
}

export async function findExistingTableMatches(opts: SearchOptions): Promise<ExistingTableMatch[]> {
  const tables = await fetchTables(opts.envUrl, opts.signal);
  const accessKeywords = keywords(opts.accessTableName);
  return tables
    .map((table) => {
      const tableKeywords = keywords([
        table.logicalName,
        table.schemaName,
        table.displayName,
        table.displayCollectionName,
      ].join(" "));
      const matchedKeywords = accessKeywords.filter((keyword) => tableKeywords.includes(keyword));
      const score = scoreKeywords(accessKeywords, tableKeywords, table.isCustomEntity);
      return { ...table, score, matchedKeywords };
    })
    .filter((table) => table.score > 0)
    .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName))
    .slice(0, 8);
}

export async function fetchExistingColumns(opts: ColumnOptions): Promise<ExistingColumnMatch[]> {
  const resp = await dvFetch(
    opts.envUrl,
    `EntityDefinitions(LogicalName='${escapeOData(opts.tableLogicalName)}')/Attributes?$select=LogicalName,SchemaName,DisplayName,AttributeType,IsValidForCreate,IsPrimaryId,IsPrimaryName`,
    { signal: opts.signal },
  );
  const body = (await resp.json()) as {
    value: Array<{
      LogicalName: string;
      SchemaName: string;
      DisplayName?: { UserLocalizedLabel?: { Label?: string } };
      AttributeType: string;
      IsValidForCreate?: boolean;
      IsPrimaryId?: boolean;
      IsPrimaryName?: boolean;
    }>;
  };
  return body.value
    .map((column) => ({
      logicalName: column.LogicalName,
      schemaName: column.SchemaName,
      displayName: localizedLabel(column.DisplayName) || column.SchemaName || column.LogicalName,
      attributeType: column.AttributeType,
      isValidForCreate: column.IsValidForCreate !== false,
      isPrimaryId: Boolean(column.IsPrimaryId),
      isPrimaryName: Boolean(column.IsPrimaryName),
      score: 0,
    }))
    .filter((column) => column.isValidForCreate && !column.isPrimaryId)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function suggestExistingColumnMappings(
  envUrl: string,
  tableLogicalName: string,
  fields: FieldMapping[],
  signal?: AbortSignal,
): Promise<FieldMapping[]> {
  const columns = await fetchExistingColumns({ envUrl, tableLogicalName, signal });
  const used = new Set<string>();
  return fields.map((field) => {
    const match = bestColumnMatch(field.accessColumn, field.dataverseType, columns, used);
    if (!match) {
      return { ...field, action: "Skip", targetMode: "existing" };
    }
    used.add(match.logicalName);
    return {
      ...field,
      action: "Map",
      targetMode: "existing",
      dataverseSchemaName: match.logicalName,
      dataverseDisplayName: match.displayName,
      dataverseType: toDataverseType(match.attributeType, field.dataverseType),
      isRequired: false,
    };
  });
}

function bestColumnMatch(
  accessColumn: string,
  accessType: FieldMapping["dataverseType"],
  columns: ExistingColumnMatch[],
  used: Set<string>,
): ExistingColumnMatch | null {
  const accessKeywords = keywords(accessColumn);
  const scored = columns
    .filter((column) => !used.has(column.logicalName))
    .map((column) => {
      const columnKeywords = keywords(`${column.logicalName} ${column.schemaName} ${column.displayName}`);
      const typeScore = typeLooksCompatible(accessType, column.attributeType) ? 12 : 0;
      return {
        ...column,
        score: scoreKeywords(accessKeywords, columnKeywords, false) + typeScore + (column.isPrimaryName ? 8 : 0),
      };
    })
    .filter((column) => column.score >= 20)
    .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));
  return scored[0] ?? null;
}

async function fetchTables(envUrl: string, signal?: AbortSignal): Promise<Omit<ExistingTableMatch, "score" | "matchedKeywords">[]> {
  const resp = await dvFetch(
    envUrl,
    "EntityDefinitions?$select=LogicalName,SchemaName,EntitySetName,DisplayName,DisplayCollectionName,IsCustomEntity,IsPrivate",
    { signal },
  );
  const body = (await resp.json()) as {
    value: Array<{
      LogicalName: string;
      SchemaName: string;
      EntitySetName: string;
      DisplayName?: { UserLocalizedLabel?: { Label?: string } };
      DisplayCollectionName?: { UserLocalizedLabel?: { Label?: string } };
      IsCustomEntity?: boolean;
      IsPrivate?: boolean;
    }>;
  };
  return body.value
    .filter((table) => !table.IsPrivate && table.EntitySetName)
    .map((table) => ({
      logicalName: table.LogicalName,
      schemaName: table.SchemaName,
      entitySetName: table.EntitySetName,
      displayName: localizedLabel(table.DisplayName) || table.SchemaName || table.LogicalName,
      displayCollectionName: localizedLabel(table.DisplayCollectionName) || table.EntitySetName,
      isCustomEntity: Boolean(table.IsCustomEntity),
    }));
}

async function dvFetch(envUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  const resp = await fetch(`${apiBase(envUrl)}/${path}`, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dataverse ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`);
  }
  return resp;
}

function scoreKeywords(source: string[], target: string[], customBoost: boolean): number {
  if (source.length === 0 || target.length === 0) return 0;
  let score = customBoost ? 2 : 0;
  for (const sourceKeyword of source) {
    if (target.includes(sourceKeyword)) score += 30;
    else if (target.some((targetKeyword) => targetKeyword.includes(sourceKeyword) || sourceKeyword.includes(targetKeyword))) score += 12;
  }
  return score;
}

function keywords(value: string): string[] {
  const raw = value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map(singularize)
    .filter((part) => part.length > 1 && !STOP_WORDS.has(part));
  return Array.from(new Set(raw));
}

const STOP_WORDS = new Set(["id", "guid", "table", "entity", "new", "old", "tbl", "msdyn"]);

function singularize(value: string): string {
  if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith("ses") && value.length > 4) return value.slice(0, -2);
  if (value.endsWith("s") && value.length > 3) return value.slice(0, -1);
  return value;
}

function localizedLabel(label?: { UserLocalizedLabel?: { Label?: string } }): string {
  return label?.UserLocalizedLabel?.Label ?? "";
}

function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}

function typeLooksCompatible(accessType: FieldMapping["dataverseType"], attributeType: string): boolean {
  const normalized = attributeType.toLowerCase();
  if (["String", "Memo"].includes(accessType)) return normalized.includes("string") || normalized.includes("memo");
  if (["Integer", "BigInt"].includes(accessType)) return normalized.includes("integer") || normalized.includes("bigint");
  if (["Decimal", "Double"].includes(accessType)) return normalized.includes("decimal") || normalized.includes("double");
  if (accessType === "Money") return normalized.includes("money");
  if (accessType === "DateTime") return normalized.includes("datetime");
  if (accessType === "Boolean") return normalized.includes("boolean");
  if (accessType === "Lookup") return normalized.includes("lookup") || normalized.includes("customer") || normalized.includes("owner");
  return true;
}

function toDataverseType(attributeType: string, fallback: FieldMapping["dataverseType"]): FieldMapping["dataverseType"] {
  switch (attributeType) {
    case "String": return "String";
    case "Memo": return "Memo";
    case "Integer": return "Integer";
    case "BigInt": return "BigInt";
    case "Decimal": return "Decimal";
    case "Double": return "Double";
    case "Money": return "Money";
    case "DateTime": return "DateTime";
    case "Boolean": return "Boolean";
    case "Lookup":
    case "Customer":
    case "Owner": return "Lookup";
    case "Picklist":
    case "State":
    case "Status": return "Choice";
    case "Uniqueidentifier": return "Uniqueidentifier";
    default: return fallback;
  }
}
