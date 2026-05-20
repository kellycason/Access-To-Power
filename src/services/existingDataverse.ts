import type { FieldMapping } from "../types/manifest";
import { apiBase } from "./apiBase";

export const EXISTING_TABLES_SNAPSHOT_MISSING =
  "This environment doesn\u2019t have an existing-table snapshot yet. Re-run the desktop helper for this migration job to capture the schema, then come back to map to existing tables. Creating new Dataverse tables still works.";

export class SchemaSnapshotMissingError extends Error {
  readonly snapshotMissing = true;
  constructor() {
    super(EXISTING_TABLES_SNAPSHOT_MISSING);
    this.name = "SchemaSnapshotMissingError";
  }
}

export function isSchemaSnapshotMissing(err: unknown): err is SchemaSnapshotMissingError {
  return Boolean(err && typeof err === "object" && (err as { snapshotMissing?: boolean }).snapshotMissing === true);
}

export interface SchemaSnapshotColumn {
  logicalName: string;
  schemaName: string;
  displayName: string;
  attributeType: string;
  isValidForCreate: boolean;
  isPrimaryId: boolean;
  isPrimaryName: boolean;
}

export interface SchemaSnapshotTable {
  logicalName: string;
  schemaName: string;
  entitySetName: string;
  displayName: string;
  displayCollectionName: string;
  isCustomEntity: boolean;
  columns: SchemaSnapshotColumn[];
}

export interface SchemaSnapshot {
  capturedAt: string;
  environmentUrl?: string;
  tables: SchemaSnapshotTable[];
}

export interface ExistingDataverseTable {
  logicalName: string;
  schemaName: string;
  entitySetName: string;
  displayName: string;
  displayCollectionName: string;
  isCustomEntity: boolean;
}

export interface ExistingTableMatch extends ExistingDataverseTable {
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
  snapshot?: SchemaSnapshot | null;
  signal?: AbortSignal;
}

interface ColumnOptions {
  envUrl: string;
  tableLogicalName: string;
  snapshot?: SchemaSnapshot | null;
  signal?: AbortSignal;
}

const ENTITY_DEFINITIONS_CACHE_PREFIX = "acp_entity_definitions_v1";
const ENTITY_DEFINITIONS_CACHE_MS = 5 * 60 * 1000;

export async function findExistingTableMatches(opts: SearchOptions): Promise<ExistingTableMatch[]> {
  const tables = await fetchTables(opts.envUrl, opts.snapshot ?? null, opts.signal);
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

export async function listExistingDataverseTables(
  envUrl: string,
  snapshot: SchemaSnapshot | null,
  signal?: AbortSignal,
): Promise<ExistingDataverseTable[]> {
  const tables = await fetchTables(envUrl, snapshot, signal);
  return [...tables].sort((a, b) => {
    if (a.isCustomEntity !== b.isCustomEntity) return a.isCustomEntity ? -1 : 1;
    return a.displayName.localeCompare(b.displayName) || a.logicalName.localeCompare(b.logicalName);
  });
}

export async function fetchExistingColumns(opts: ColumnOptions): Promise<ExistingColumnMatch[]> {
  opts.signal?.throwIfAborted();
  if (opts.snapshot) {
    const table = opts.snapshot.tables.find((t) => t.logicalName === opts.tableLogicalName);
    if (!table) return [];
    return table.columns
      .filter((column) => column.isValidForCreate && !column.isPrimaryId)
      .map((column) => ({
        logicalName: column.logicalName,
        schemaName: column.schemaName,
        displayName: column.displayName || column.schemaName || column.logicalName,
        attributeType: column.attributeType,
        isValidForCreate: column.isValidForCreate,
        isPrimaryId: column.isPrimaryId,
        isPrimaryName: column.isPrimaryName,
        score: 0,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  if (!import.meta.env.DEV) {
    throw new SchemaSnapshotMissingError();
  }
  const body = await fetchExistingColumnsWithWebApi(opts);
  opts.signal?.throwIfAborted();
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
  snapshot: SchemaSnapshot | null,
  signal?: AbortSignal,
): Promise<FieldMapping[]> {
  const columns = await fetchExistingColumns({ envUrl, tableLogicalName, snapshot, signal });
  const used = new Set<string>();
  return fields.map((field) => {
    const match = bestColumnMatch(field.accessColumn, field.dataverseType, columns, used);
    if (!match) {
      // No good existing column — default to creating a new column on the existing table.
      return { ...field, action: "Map", targetMode: "new" };
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
    // HARD GATE: types must be structurally compatible. A keyword match is
    // never enough to override an obvious type mismatch (e.g. Integer Access
    // column suggested into a Lookup Dataverse column).
    .filter((column) => typesAreCompatible(accessType, column.attributeType))
    .map((column) => {
      const columnKeywords = keywords(`${column.logicalName} ${column.schemaName} ${column.displayName}`);
      return {
        ...column,
        score: scoreKeywords(accessKeywords, columnKeywords, false) + (column.isPrimaryName ? 8 : 0),
      };
    })
    .filter((column) => column.score >= 20)
    .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));
  return scored[0] ?? null;
}

async function fetchTables(
  envUrl: string,
  snapshot: SchemaSnapshot | null,
  signal?: AbortSignal,
): Promise<ExistingDataverseTable[]> {
  if (snapshot) {
    return snapshot.tables.map((table) => ({
      logicalName: table.logicalName,
      schemaName: table.schemaName,
      entitySetName: table.entitySetName,
      displayName: table.displayName || table.schemaName || table.logicalName,
      displayCollectionName: table.displayCollectionName || table.entitySetName,
      isCustomEntity: table.isCustomEntity,
    }));
  }
  const cacheKey = `${ENTITY_DEFINITIONS_CACHE_PREFIX}:${envUrl.toLowerCase()}`;
  const cached = readCachedTables(cacheKey);
  if (cached) return cached;

  signal?.throwIfAborted();
  if (!import.meta.env.DEV) {
    throw new SchemaSnapshotMissingError();
  }
  const body = await fetchTablesWithWebApi(envUrl, signal);
  signal?.throwIfAborted();

  const tables = body.value
    .filter((table) => !table.IsPrivate && table.EntitySetName)
    .map((table) => ({
      logicalName: table.LogicalName,
      schemaName: table.SchemaName,
      entitySetName: table.EntitySetName,
      displayName: localizedLabel(table.DisplayName) || table.SchemaName || table.LogicalName,
      displayCollectionName: localizedLabel(table.DisplayCollectionName) || table.EntitySetName,
      isCustomEntity: Boolean(table.IsCustomEntity),
    }));
  writeCachedTables(cacheKey, tables);
  return tables;
}

async function fetchTablesWithWebApi(envUrl: string, signal?: AbortSignal): Promise<EntityDefinitionsResponse> {
  const resp = await dvFetch(
    envUrl,
    "EntityDefinitions?$select=LogicalName,SchemaName,EntitySetName,DisplayName,DisplayCollectionName,IsCustomEntity,IsPrivate",
    { signal },
  );
  return (await resp.json()) as EntityDefinitionsResponse;
}

async function fetchExistingColumnsWithWebApi(opts: ColumnOptions): Promise<EntityAttributesResponse> {
  const resp = await dvFetch(
    opts.envUrl,
    `EntityDefinitions(LogicalName='${escapeOData(opts.tableLogicalName)}')/Attributes?$select=LogicalName,SchemaName,DisplayName,AttributeType,IsValidForCreate,IsPrimaryId,IsPrimaryName`,
    { signal: opts.signal },
  );
  return (await resp.json()) as EntityAttributesResponse;
}

interface EntityDefinitionsResponse {
  value: EntityDefinitionRow[];
}

interface EntityDefinitionRow {
  LogicalName: string;
  SchemaName: string;
  EntitySetName: string;
  DisplayName?: { UserLocalizedLabel?: { Label?: string } };
  DisplayCollectionName?: { UserLocalizedLabel?: { Label?: string } };
  IsCustomEntity?: boolean;
  IsPrivate?: boolean;
}

interface EntityAttributesResponse {
  value: EntityAttributeRow[];
}

interface EntityAttributeRow {
  LogicalName: string;
  SchemaName: string;
  DisplayName?: { UserLocalizedLabel?: { Label?: string } };
  AttributeType: string;
  IsValidForCreate?: boolean;
  IsPrimaryId?: boolean;
  IsPrimaryName?: boolean;
}

interface CachedTables {
  createdAt: number;
  tables: ExistingDataverseTable[];
}

function readCachedTables(key: string): ExistingDataverseTable[] | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedTables;
    if (Date.now() - cached.createdAt > ENTITY_DEFINITIONS_CACHE_MS) return null;
    if (!Array.isArray(cached.tables)) return null;
    return cached.tables;
  } catch {
    return null;
  }
}

function writeCachedTables(
  key: string,
  tables: ExistingDataverseTable[],
): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ createdAt: Date.now(), tables } satisfies CachedTables));
  } catch {
    /* ignore cache write failures */
  }
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

/**
 * Strict compatibility gate for auto-suggesting existing Dataverse columns.
 *
 * Rules (safe by default — when in doubt, do NOT match):
 * - Never auto-match into structural / system types: Lookup, Customer, Owner,
 *   Uniqueidentifier, State, Status, EntityName, ManagedProperty, Virtual,
 *   PartyList, CalendarRules, File, Image. These either can't hold scalar
 *   Access data or are system-managed.
 * - Numeric Access types may only match the matching numeric Dataverse type
 *   (Integer/BigInt → Integer/BigInt; Decimal/Double → Decimal/Double;
 *   Money → Money). No cross-family suggestions like Integer → Money.
 * - String/Memo may match either String or Memo (text↔memo is a common,
 *   non-destructive widen/narrow).
 * - DateTime and Boolean only match their exact counterparts.
 * - A Lookup Access field never auto-binds — relationships handle that pass.
 */
function typesAreCompatible(accessType: FieldMapping["dataverseType"], attributeType: string): boolean {
  const normalized = (attributeType || "").toLowerCase();

  // Hard deny: never auto-bind these target types.
  const BLOCKED_TARGETS = [
    "lookup",
    "customer",
    "owner",
    "uniqueidentifier",
    "state",
    "status",
    "picklist",
    "multiselectpicklist",
    "entityname",
    "managedproperty",
    "virtual",
    "partylist",
    "calendarrules",
    "file",
    "image",
  ];
  if (BLOCKED_TARGETS.some((blocked) => normalized === blocked)) return false;

  // Access-side Lookup/Choice/Uniqueidentifier are handled by other passes —
  // never auto-bind from them either.
  if (accessType === "Lookup" || accessType === "Choice" || accessType === "Uniqueidentifier") {
    return false;
  }

  switch (accessType) {
    case "String":
    case "Memo":
      return normalized === "string" || normalized === "memo";
    case "Integer":
    case "BigInt":
      return normalized === "integer" || normalized === "bigint";
    case "Decimal":
    case "Double":
      return normalized === "decimal" || normalized === "double";
    case "Money":
      return normalized === "money";
    case "DateTime":
      return normalized === "datetime";
    case "Boolean":
      return normalized === "boolean";
    default:
      return false;
  }
}

export function toDataverseType(attributeType: string, fallback: FieldMapping["dataverseType"]): FieldMapping["dataverseType"] {
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
