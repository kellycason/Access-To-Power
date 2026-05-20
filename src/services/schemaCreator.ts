/**
 * Client-side schema orchestrator. Reads the approved MigrationPlan and
 * creates the customer's Dataverse publisher, solution, tables, columns,
 * and N:1 lookups via the Dataverse Web API.
 *
 * Why in-process instead of a cloud flow: this runs while the user is
 * watching a progress bar; round-trip latency and per-table progress matter
 * more than disconnected execution. The set of HTTP calls is identical to
 * what a cloud flow would make, so we can extract this to a flow later if
 * scheduled / disconnected execution becomes a requirement.
 */

import type { FieldMapping, MigrationPlan, TableMapping } from "../types/manifest";
import { apiBase } from "./apiBase";

export type Severity = "info" | "warn" | "error";
export interface ProgressEvent {
  kind:
    | "phase"
    | "table:start"
    | "table:done"
    | "column"
    | "lookup"
    | "publish"
    | "log";
  message: string;
  severity?: Severity;
  /** Optional 0–100 progress for the current phase. */
  progress?: number;
  /** Logical name of the affected Dataverse table, if applicable. */
  entityLogicalName?: string;
}
export type ProgressCallback = (e: ProgressEvent) => void;

interface CreateOptions {
  envUrl: string;
  plan: MigrationPlan;
  /** Target publisher prefix (lower-case 2-8 chars). */
  publisherPrefix: string;
  /** Solution unique name. */
  solutionUniqueName: string;
  /** Friendly name shown in solution explorer. */
  solutionFriendlyName?: string;
  /** Publisher friendly name. */
  publisherFriendlyName?: string;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

const ODATA_HEADERS = {
  Accept: "application/json",
  "OData-MaxVersion": "4.0",
  "OData-Version": "4.0",
} as const;

export async function createDataverseSchema(opts: CreateOptions): Promise<void> {
  const { envUrl, plan, publisherPrefix, solutionUniqueName } = opts;
  const log = opts.onProgress ?? (() => {});

  log({ kind: "phase", message: "Ensuring publisher and solution…" });
  const publisherId = await ensurePublisher(
    envUrl,
    publisherPrefix,
    opts.publisherFriendlyName ?? capitalize(publisherPrefix),
    opts.signal,
    log,
  );
  await ensureSolution(
    envUrl,
    solutionUniqueName,
    opts.solutionFriendlyName ?? solutionUniqueName,
    publisherId,
    opts.signal,
    log,
  );

  const headers: Record<string, string> = {
    ...ODATA_HEADERS,
    "MSCRM.SolutionUniqueName": solutionUniqueName,
  };

  const migrateTables = plan.tableMappings.filter((t) => t.action === "Migrate");

  log({ kind: "phase", message: `Creating ${migrateTables.length} tables…` });

  // Pass 1: entities with their primary-name attribute only.
  for (let i = 0; i < migrateTables.length; i++) {
    opts.signal?.throwIfAborted();
    const t = migrateTables[i];
    if (t.targetMode === "existing") {
      log({ kind: "table:done", message: `Using existing table ${t.dataverseSchemaName}.`, entityLogicalName: t.dataverseSchemaName });
      continue;
    }
    const pct = Math.round((i / migrateTables.length) * 100);
    log({ kind: "table:start", message: `Creating table ${t.dataverseSchemaName}`, progress: pct, entityLogicalName: t.dataverseSchemaName });
    await createEntityIfMissing(envUrl, headers, t, publisherPrefix, opts.signal, log);
  }

  // Pass 2: non-lookup attributes per entity.
  log({ kind: "phase", message: "Creating columns…" });
  for (const t of migrateTables) {
    opts.signal?.throwIfAborted();
    if (t.targetMode === "existing") {
      // For existing tables we only create columns that were explicitly marked targetMode === "new".
      const newFields = t.fields.filter((f) => f.action === "Map" && f.targetMode === "new" && f.dataverseType !== "Lookup");
      if (newFields.length === 0) {
        log({ kind: "log", message: `Using existing columns on ${t.dataverseSchemaName}.` });
        continue;
      }
      log({ kind: "log", message: `Adding ${newFields.length} new column(s) to existing table ${t.dataverseSchemaName}…` });
      for (const f of newFields) {
        await createAttributeIfMissing(envUrl, headers, t.dataverseSchemaName, f, opts.signal, log);
      }
      continue;
    }
    for (const f of t.fields) {
      // Primary key in Access becomes Dataverse's auto GUID — don't create it.
      // Lookups are handled in pass 3 (need all entities to exist first).
      if (f.action !== "Map") continue;
      if (f.isAlternateKey && manifestColumnIsPrimaryKey(t, f)) continue;
      if (f.dataverseType === "Lookup") continue;
      // The primary-name column was already created with the entity.
      if (t.primaryNameAccessColumn && f.accessColumn === t.primaryNameAccessColumn) continue;

      await createAttributeIfMissing(envUrl, headers, t.dataverseSchemaName, f, opts.signal, log);
    }
  }

  // Pass 3: relationships (lookups). Use plan.manifest.relationships.
  log({ kind: "phase", message: "Creating relationships…" });
  for (const rel of plan.manifest.relationships) {
    opts.signal?.throwIfAborted();
    const parentMap = migrateTables.find((t) => t.accessTable === rel.parentTable);
    const childMap = migrateTables.find((t) => t.accessTable === rel.childTable);
    if (!parentMap || !childMap) continue;
    if (childMap.targetMode === "existing") {
      log({ kind: "log", message: `Skipping relationship creation on existing table ${childMap.dataverseSchemaName}.` });
      continue;
    }
    // Single-column FK only (composite keys not supported in v1).
    if (rel.childColumns.length !== 1) {
      log({
        kind: "log",
        severity: "warn",
        message: `Skipping composite FK ${rel.name} (${rel.childColumns.length} columns).`,
      });
      continue;
    }
    const childCol = rel.childColumns[0];
    const lookupName = lookupBaseName(childCol);
    const lookupSchema = `${publisherPrefix}_${slug(lookupName)}`;
    await createLookupIfMissing(
      envUrl,
      headers,
      childMap.dataverseSchemaName,
      parentMap.dataverseSchemaName,
      lookupSchema,
      displayLookupName(lookupName),
      opts.signal,
      log,
    );
  }

  log({ kind: "publish", message: "Publishing customizations…" });
  await dvFetch(envUrl, "PublishAllXml", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: "{}",
    signal: opts.signal,
  });

  log({ kind: "phase", message: "Schema creation complete.", progress: 100 });
}

/* ----------------------------------------------------------------------- */
/* Publisher / solution                                                    */
/* ----------------------------------------------------------------------- */

async function ensurePublisher(
  envUrl: string,
  prefix: string,
  friendlyName: string,
  signal: AbortSignal | undefined,
  log: ProgressCallback,
): Promise<string> {
  const existing = await dvJson<{ value: Array<{ publisherid: string }> }>(
    envUrl,
    `publishers?$filter=customizationprefix eq '${prefix}'&$select=publisherid&$top=1`,
    { signal },
  );
  if (existing.value.length > 0) {
    log({ kind: "log", message: `Publisher '${prefix}' already exists.` });
    return existing.value[0].publisherid;
  }
  const ovp = 10000 + Math.floor(Math.random() * 80000);
  const body = JSON.stringify({
    uniquename: prefix,
    friendlyname: friendlyName,
    customizationprefix: prefix,
    customizationoptionvalueprefix: ovp,
  });
  const resp = await dvFetch(envUrl, "publishers", {
    method: "POST",
    headers: { ...ODATA_HEADERS, "Content-Type": "application/json", Prefer: "return=representation" },
    body,
    signal,
  });
  const created = (await resp.json()) as { publisherid: string };
  log({ kind: "log", message: `Created publisher '${prefix}'.` });
  return created.publisherid;
}

async function ensureSolution(
  envUrl: string,
  uniqueName: string,
  friendlyName: string,
  publisherId: string,
  signal: AbortSignal | undefined,
  log: ProgressCallback,
): Promise<void> {
  const existing = await dvJson<{ value: Array<{ solutionid: string }> }>(
    envUrl,
    `solutions?$filter=uniquename eq '${uniqueName}'&$select=solutionid&$top=1`,
    { signal },
  );
  if (existing.value.length > 0) {
    log({ kind: "log", message: `Solution '${uniqueName}' already exists.` });
    return;
  }
  await dvFetch(envUrl, "solutions", {
    method: "POST",
    headers: { ...ODATA_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      uniquename: uniqueName,
      friendlyname: friendlyName,
      version: "1.0.0.0",
      "publisherid@odata.bind": `/publishers(${publisherId})`,
    }),
    signal,
  });
  log({ kind: "log", message: `Created solution '${uniqueName}'.` });
}

/* ----------------------------------------------------------------------- */
/* Entities                                                                */
/* ----------------------------------------------------------------------- */

async function createEntityIfMissing(
  envUrl: string,
  headers: Record<string, string>,
  t: TableMapping,
  prefix: string,
  signal: AbortSignal | undefined,
  log: ProgressCallback,
): Promise<void> {
  const logical = t.dataverseSchemaName.toLowerCase();
  const exists = await entityExists(envUrl, logical, signal);
  if (exists) {
    log({ kind: "log", message: `Entity ${logical} already exists.` });
    return;
  }

  const primaryNameField =
    t.fields.find((f) => f.accessColumn === t.primaryNameAccessColumn) ?? t.fields[0];
  const primaryNameSchema =
    primaryNameField?.dataverseSchemaName ?? `${prefix}_name`;
  const primaryNameDisplay = primaryNameField?.dataverseDisplayName ?? "Name";

  const body = {
    "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
    SchemaName: t.dataverseSchemaName,
    LogicalName: logical,
    DisplayName: label(t.dataverseDisplayName),
    DisplayCollectionName: label(t.dataversePluralName),
    OwnershipType: "UserOwned",
    HasActivities: false,
    HasNotes: false,
    IsActivity: false,
    Attributes: [
      {
        "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
        SchemaName: primaryNameSchema,
        LogicalName: primaryNameSchema.toLowerCase(),
        DisplayName: label(primaryNameDisplay),
        RequiredLevel: { Value: "ApplicationRequired" },
        MaxLength: Math.min(primaryNameField?.maxLength ?? 200, 4000),
        FormatName: { Value: "Text" },
        IsPrimaryName: true,
      },
    ],
  };

  await dvFetch(envUrl, "EntityDefinitions", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  log({ kind: "table:done", message: `Created ${logical}.`, entityLogicalName: logical });
}

async function entityExists(envUrl: string, logical: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await dvFetch(envUrl, `EntityDefinitions(LogicalName='${logical}')?$select=LogicalName`, {
      method: "GET",
      headers: { ...ODATA_HEADERS },
      signal,
    });
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------------- */
/* Attributes                                                              */
/* ----------------------------------------------------------------------- */

function manifestColumnIsPrimaryKey(t: TableMapping, f: FieldMapping): boolean {
  const col = t.fields.find((x) => x.accessColumn === f.accessColumn);
  return Boolean(col?.isAlternateKey && col?.dataverseType === "Integer");
}

async function createAttributeIfMissing(
  envUrl: string,
  headers: Record<string, string>,
  entitySchema: string,
  f: FieldMapping,
  signal: AbortSignal | undefined,
  log: ProgressCallback,
): Promise<void> {
  const entityLogical = entitySchema.toLowerCase();
  const attrLogical = f.dataverseSchemaName.toLowerCase();
  const exists = await attributeExists(envUrl, entityLogical, attrLogical, signal);
  if (exists) {
    log({ kind: "column", message: `${entityLogical}.${attrLogical} already exists.` });
    return;
  }

  const reqLevel = f.isRequired ? "ApplicationRequired" : "None";
  let body: Record<string, unknown> | null = null;

  switch (f.dataverseType) {
    case "String":
      body = {
        "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
        SchemaName: f.dataverseSchemaName,
        LogicalName: attrLogical,
        DisplayName: label(f.dataverseDisplayName),
        RequiredLevel: { Value: reqLevel },
        MaxLength: Math.min(Math.max(f.maxLength ?? 255, 1), 4000),
        FormatName: { Value: "Text" },
      };
      break;
    case "Memo":
      body = {
        "@odata.type": "Microsoft.Dynamics.CRM.MemoAttributeMetadata",
        SchemaName: f.dataverseSchemaName,
        LogicalName: attrLogical,
        DisplayName: label(f.dataverseDisplayName),
        RequiredLevel: { Value: reqLevel },
        MaxLength: 100000,
        Format: "TextArea",
      };
      break;
    case "Integer":
      body = {
        "@odata.type": "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
        SchemaName: f.dataverseSchemaName,
        LogicalName: attrLogical,
        DisplayName: label(f.dataverseDisplayName),
        RequiredLevel: { Value: reqLevel },
        Format: "None",
        MinValue: -2147483648,
        MaxValue: 2147483647,
      };
      break;
    case "BigInt":
      body = {
        "@odata.type": "Microsoft.Dynamics.CRM.BigIntAttributeMetadata",
        SchemaName: f.dataverseSchemaName,
        LogicalName: attrLogical,
        DisplayName: label(f.dataverseDisplayName),
        RequiredLevel: { Value: reqLevel },
      };
      break;
    case "Decimal":
      body = {
        "@odata.type": "Microsoft.Dynamics.CRM.DecimalAttributeMetadata",
        SchemaName: f.dataverseSchemaName,
        LogicalName: attrLogical,
        DisplayName: label(f.dataverseDisplayName),
        RequiredLevel: { Value: reqLevel },
        Precision: Math.min(Math.max(f.precision ?? 2, 0), 10),
        MinValue: -100000000000,
        MaxValue: 100000000000,
      };
      break;
    case "Money":
      body = {
        "@odata.type": "Microsoft.Dynamics.CRM.MoneyAttributeMetadata",
        SchemaName: f.dataverseSchemaName,
        LogicalName: attrLogical,
        DisplayName: label(f.dataverseDisplayName),
        RequiredLevel: { Value: reqLevel },
        PrecisionSource: 2,
        MinValue: -922337203685477,
        MaxValue: 922337203685477,
      };
      break;
    case "Double":
      body = {
        "@odata.type": "Microsoft.Dynamics.CRM.DoubleAttributeMetadata",
        SchemaName: f.dataverseSchemaName,
        LogicalName: attrLogical,
        DisplayName: label(f.dataverseDisplayName),
        RequiredLevel: { Value: reqLevel },
        Precision: 5,
        MinValue: -100000000000,
        MaxValue: 100000000000,
      };
      break;
    case "DateTime":
      body = {
        "@odata.type": "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
        SchemaName: f.dataverseSchemaName,
        LogicalName: attrLogical,
        DisplayName: label(f.dataverseDisplayName),
        RequiredLevel: { Value: reqLevel },
        Format: "DateAndTime",
        DateTimeBehavior: { Value: "UserLocal" },
      };
      break;
    case "Boolean":
      body = {
        "@odata.type": "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
        SchemaName: f.dataverseSchemaName,
        LogicalName: attrLogical,
        DisplayName: label(f.dataverseDisplayName),
        RequiredLevel: { Value: reqLevel },
        DefaultValue: false,
        OptionSet: {
          "@odata.type": "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata",
          TrueOption: { Value: 1, Label: label("Yes") },
          FalseOption: { Value: 0, Label: label("No") },
        },
      };
      break;
    default:
      log({ kind: "log", severity: "warn", message: `Unsupported type ${f.dataverseType} for ${attrLogical}, skipped.` });
      return;
  }

  try {
    await dvFetch(
      envUrl,
      `EntityDefinitions(LogicalName='${entityLogical}')/Attributes`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    );
  } catch (e) {
    if (isAlreadyExistsError(e)) {
      log({ kind: "column", message: `${entityLogical}.${attrLogical} already exists.` });
      return;
    }
    throw e;
  }
  log({ kind: "column", message: `Created ${entityLogical}.${attrLogical}` });
}

async function attributeExists(
  envUrl: string,
  entityLogical: string,
  attrLogical: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await dvFetch(
      envUrl,
      `EntityDefinitions(LogicalName='${entityLogical}')/Attributes(LogicalName='${attrLogical}')?$select=LogicalName`,
      { method: "GET", headers: { ...ODATA_HEADERS }, signal },
    );
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------------- */
/* Lookups                                                                 */
/* ----------------------------------------------------------------------- */

async function createLookupIfMissing(
  envUrl: string,
  headers: Record<string, string>,
  childEntity: string,
  parentEntity: string,
  lookupSchema: string,
  displayName: string,
  signal: AbortSignal | undefined,
  log: ProgressCallback,
): Promise<void> {
  const childLogical = childEntity.toLowerCase();
  const parentLogical = parentEntity.toLowerCase();
  const attrLogical = lookupSchema.toLowerCase();
  if (await attributeExists(envUrl, childLogical, attrLogical, signal)) {
    log({ kind: "lookup", message: `${childLogical}.${attrLogical} already exists.` });
    return;
  }
  const relSchema = truncate(
    `${parentLogical}_${childLogical}_${attrLogical}`,
    100,
  );
  const body = {
    "@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
    SchemaName: relSchema,
    ReferencedEntity: parentLogical,
    ReferencingEntity: childLogical,
    Lookup: {
      "@odata.type": "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
      SchemaName: lookupSchema,
      LogicalName: attrLogical,
      DisplayName: label(displayName),
      RequiredLevel: { Value: "None" },
    },
    AssociatedMenuConfiguration: {
      Behavior: "UseCollectionName",
      Group: "Details",
      Order: 10000,
    },
    CascadeConfiguration: {
      Assign: "NoCascade",
      Delete: "RemoveLink",
      Merge: "NoCascade",
      Reparent: "NoCascade",
      Share: "NoCascade",
      Unshare: "NoCascade",
    },
  };
  try {
    await dvFetch(envUrl, "RelationshipDefinitions", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (isAlreadyExistsError(e)) {
      log({ kind: "lookup", message: `${childLogical}.${attrLogical} already exists.` });
      return;
    }
    throw e;
  }
  log({ kind: "lookup", message: `Created ${childLogical}.${attrLogical} -> ${parentLogical}` });
}

function isAlreadyExistsError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return message.includes("0x80047013") || /already exists/i.test(message);
}

/* ----------------------------------------------------------------------- */
/* HTTP helpers                                                            */
/* ----------------------------------------------------------------------- */

async function dvFetch(envUrl: string, path: string, init: RequestInit): Promise<Response> {
  const url = `${apiBase(envUrl)}/${path}`;
  const resp = await fetch(url, { ...init, credentials: "include" });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dataverse ${resp.status} ${resp.statusText}: ${truncate(text, 500)}`);
  }
  return resp;
}

async function dvJson<T>(envUrl: string, path: string, init: RequestInit): Promise<T> {
  const resp = await dvFetch(envUrl, path, {
    ...init,
    method: init.method ?? "GET",
    headers: { ...ODATA_HEADERS, ...(init.headers as Record<string, string>) },
  });
  return (await resp.json()) as T;
}

function label(text: string) {
  return {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    LocalizedLabels: [
      {
        "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
        Label: text,
        LanguageCode: 1033,
      },
    ],
  };
}

function slug(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 40);
}

function lookupBaseName(accessForeignKeyColumn: string): string {
  const trimmed = accessForeignKeyColumn.trim();
  return trimmed.replace(/(?:_?id)$/i, "") || trimmed;
}

function displayLookupName(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
