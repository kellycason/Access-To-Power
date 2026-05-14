/**
 * Data loader (pass 1).
 *
 * Reads the NDJSON row files uploaded as annotations on the migration job,
 * bulk-upserts them into the customer's newly-created Dataverse tables,
 * and records an Access-PK -> Dataverse-GUID id map per table for the
 * second-pass lookup resolver.
 *
 * Strategy:
 *  - One $batch request per ~100-row chunk per table
 *  - Throttle-aware: honour Retry-After on 429 / 503
 *  - Lookups are intentionally NOT set in pass 1; they're patched in pass 2
 *    once all rows of every table exist (so we have GUIDs to bind to)
 *  - The id map is kept in memory and returned at the end; the caller
 *    persists it to acp_migrationtable.acp_idmap if desired
 */

import type {
  AccessTable,
  FieldMapping,
  MigrationPlan,
  TableMapping,
} from "../types/manifest";
import type { ProgressCallback } from "./schemaCreator";
import { apiBase } from "./apiBase";

const BATCH_SIZE = 100;

export interface LoadOptions {
  envUrl: string;
  plan: MigrationPlan;
  publisherPrefix: string;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

/**
 * Map from Dataverse logical table name -> (Access PK string -> Dataverse GUID).
 * Keys are stringified Access PK values so integer/string/GUID PKs all hash.
 */
export type IdMap = Map<string, Map<string, string>>;

export async function loadData(opts: LoadOptions): Promise<IdMap> {
  const { envUrl, plan } = opts;
  const log = opts.onProgress ?? (() => {});
  const idMap: IdMap = new Map();

  const migrateTables = plan.tableMappings.filter((t) => t.action === "Migrate");
  log({ kind: "phase", message: `Loading rows for ${migrateTables.length} tables…` });

  for (let i = 0; i < migrateTables.length; i++) {
    opts.signal?.throwIfAborted();
    const tm = migrateTables[i];
    const accessTable = plan.manifest.tables.find((t) => t.name === tm.accessTable);
    if (!accessTable) {
      log({ kind: "log", severity: "warn", message: `No manifest entry for ${tm.accessTable}; skipping.` });
      continue;
    }
    const pct = Math.round((i / migrateTables.length) * 100);
    log({
      kind: "table:start",
      message: `Loading ${accessTable.name} (${accessTable.rowCount} rows)`,
      progress: pct,
      entityLogicalName: tm.dataverseSchemaName,
    });

    const rows = await fetchNdjsonRows(envUrl, plan.migrationJobId, accessTable.rowsFile, opts.signal);
    const tableIdMap = new Map<string, string>();
    idMap.set(tm.dataverseSchemaName.toLowerCase(), tableIdMap);

    const pkAccessCol = findPrimaryKeyAccessColumn(accessTable);
    const entitySet = tm.dataverseEntitySetName ?? await resolveEntitySetName(envUrl, tm.dataverseSchemaName, opts.signal);

    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      opts.signal?.throwIfAborted();
      const chunk = rows.slice(offset, offset + BATCH_SIZE);
      const results = await executeCreateBatch(
        envUrl,
        entitySet,
        tm,
        accessTable,
        chunk,
        opts.signal,
      );
      for (let j = 0; j < chunk.length; j++) {
        const id = results[j];
        if (!id) continue;
        if (pkAccessCol) {
          const pkVal = chunk[j][pkAccessCol];
          if (pkVal !== null && pkVal !== undefined) {
            tableIdMap.set(String(pkVal), id);
          }
        }
      }
      log({
        kind: "log",
        message: `${accessTable.name}: ${Math.min(offset + BATCH_SIZE, rows.length)}/${rows.length} rows`,
      });
    }

    log({ kind: "table:done", message: `Loaded ${accessTable.name}.`, entityLogicalName: tm.dataverseSchemaName });
  }

  log({ kind: "phase", message: "Row load complete.", progress: 100 });
  return idMap;
}

/* ----------------------------------------------------------------------- */
/* Annotation fetch                                                        */
/* ----------------------------------------------------------------------- */

async function fetchNdjsonRows(
  envUrl: string,
  jobId: string,
  fileName: string,
  signal: AbortSignal | undefined,
): Promise<Array<Record<string, unknown>>> {
  const filter = `_objectid_value eq ${jobId} and filename eq '${escapeOData(fileName)}'`;
  const listResp = await dvFetch(envUrl,
    `annotations?$select=annotationid&$filter=${encodeURIComponent(filter)}&$top=1`,
    { signal },
  );
  const list = (await listResp.json()) as { value: Array<{ annotationid: string }> };
  if (list.value.length === 0) return [];

  const fileResp = await dvFetch(envUrl,
    `annotations(${list.value[0].annotationid})?$select=documentbody`,
    { signal },
  );
  const row = (await fileResp.json()) as { documentbody?: string };
  if (!row.documentbody) return [];

  const text = decodeBase64Utf8(row.documentbody);
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/^\uFEFF/, "");
    if (!clean.trim()) continue;
    try {
      rows.push(JSON.parse(clean) as Record<string, unknown>);
    } catch {
      // ignore malformed lines; the validator will flag count mismatches
    }
  }
  return rows;
}

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

/* ----------------------------------------------------------------------- */
/* Entity-set name resolution                                              */
/* ----------------------------------------------------------------------- */

const entitySetCache = new Map<string, string>();

async function resolveEntitySetName(
  envUrl: string,
  schemaName: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const logical = schemaName.toLowerCase();
  const hit = entitySetCache.get(logical);
  if (hit) return hit;
  const resp = await dvFetch(envUrl,
    `EntityDefinitions(LogicalName='${logical}')?$select=EntitySetName`,
    { signal },
  );
  const body = (await resp.json()) as { EntitySetName: string };
  entitySetCache.set(logical, body.EntitySetName);
  return body.EntitySetName;
}

/* ----------------------------------------------------------------------- */
/* Batch create                                                            */
/* ----------------------------------------------------------------------- */

async function executeCreateBatch(
  envUrl: string,
  entitySet: string,
  tm: TableMapping,
  accessTable: AccessTable,
  rows: Array<Record<string, unknown>>,
  signal: AbortSignal | undefined,
): Promise<Array<string | null>> {
  const boundary = `batch_${crypto.randomUUID()}`;
  const changesetBoundary = `changeset_${crypto.randomUUID()}`;
  const parts: string[] = [];
  parts.push(`--${boundary}`);
  parts.push(`Content-Type: multipart/mixed; boundary=${changesetBoundary}`);
  parts.push("");

  rows.forEach((row, idx) => {
    const body = projectRow(row, tm, accessTable);
    parts.push(`--${changesetBoundary}`);
    parts.push("Content-Type: application/http");
    parts.push("Content-Transfer-Encoding: binary");
    parts.push(`Content-ID: ${idx + 1}`);
    parts.push("");
    parts.push(`POST ${entitySet} HTTP/1.1`);
    parts.push("Content-Type: application/json;type=entry");
    parts.push("Prefer: return=representation");
    parts.push("");
    parts.push(JSON.stringify(body));
  });
  parts.push(`--${changesetBoundary}--`);
  parts.push(`--${boundary}--`);
  parts.push("");

  const payload = parts.join("\r\n");
  const resp = await dvFetch(envUrl, "$batch", {
    method: "POST",
    headers: {
      "Content-Type": `multipart/mixed; boundary=${boundary}`,
      Accept: "application/json",
    },
    body: payload,
    signal,
  });
  const text = await resp.text();
  throwIfBatchContainsErrors(text, rows, tm);
  return parseBatchEntityIds(text, rows.length);
}

function throwIfBatchContainsErrors(
  responseText: string,
  rows: Array<Record<string, unknown>>,
  tm: TableMapping,
): void {
  const subResponses = responseText.split(/\r?\nContent-ID: /).slice(1);
  const failures: string[] = [];
  for (const sub of subResponses) {
    const cidMatch = sub.match(/^(\d+)/);
    const statusMatch = sub.match(/HTTP\/1\.1\s+(\d{3})\s+([^\r\n]+)/);
    if (!cidMatch || !statusMatch) continue;
    const status = parseInt(statusMatch[1], 10);
    if (status < 400) continue;
    const cid = parseInt(cidMatch[1], 10);
    const row = rows[cid - 1];
    const pkField = tm.fields.find((f) => f.isAlternateKey)?.accessColumn;
    const pk = pkField && row ? row[pkField] : undefined;
    const jsonMatch = sub.match(/\{\s*"error"\s*:\s*\{[\s\S]*?\}\s*\}/);
    let detail = sub.slice(0, 500);
    if (jsonMatch) {
      try {
        const body = JSON.parse(jsonMatch[0]) as { error?: { code?: string; message?: string } };
        detail = `${body.error?.code ?? status}: ${body.error?.message ?? statusMatch[2]}`;
      } catch {
        detail = jsonMatch[0];
      }
    }
    failures.push(`row ${cid}${pk !== undefined ? ` (Access PK ${String(pk)})` : ""}: ${detail}`);
  }
  if (failures.length > 0) {
    throw new Error(`Batch create failed for ${tm.accessTable}: ${failures.slice(0, 3).join(" | ")}`);
  }
}

function parseBatchEntityIds(responseText: string, expected: number): Array<string | null> {
  // OData-EntityId header per sub-response gives us the new GUID.
  // Dataverse may instead return only the JSON representation, so use that
  // as a fallback. Failed sub-responses leave a null slot.
  const ids: Array<string | null> = new Array(expected).fill(null);
  // Split on Content-ID markers to keep ordering.
  const subResponses = responseText.split(/\r?\nContent-ID: /).slice(1);
  for (const sub of subResponses) {
    const cidMatch = sub.match(/^(\d+)/);
    if (!cidMatch) continue;
    const cid = parseInt(cidMatch[1], 10) - 1;
    const idMatch = sub.match(/OData-EntityId:\s*[^(]+\(([0-9a-f-]{36})\)/i);
    if (idMatch && cid >= 0 && cid < expected) {
      ids[cid] = idMatch[1];
      continue;
    }
    const jsonMatch = sub.match(/\{[\s\S]*\}/);
    if (jsonMatch && cid >= 0 && cid < expected) {
      try {
        const body = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        const guid = Object.entries(body).find(
          ([key, value]) =>
            !key.includes("@") &&
            key.toLowerCase().endsWith("id") &&
            typeof value === "string" &&
            /^[0-9a-f-]{36}$/i.test(value),
        )?.[1];
        if (typeof guid === "string") ids[cid] = guid;
      } catch {
        // leave null; lookup resolution will report unresolved rows
      }
    }
  }
  return ids;
}

/* ----------------------------------------------------------------------- */
/* Row projection: Access row -> Dataverse payload                         */
/* ----------------------------------------------------------------------- */

function projectRow(
  row: Record<string, unknown>,
  tm: TableMapping,
  accessTable: AccessTable,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of tm.fields) {
    if (f.action !== "Map") continue;
    if (accessTable.columns.some((c) => c.name === f.accessColumn && c.isPrimaryKey)) continue;
    if (f.dataverseType === "Lookup") continue; // pass 2
    const v = row[f.accessColumn];
    if (v === null || v === undefined) continue;
    out[f.dataverseSchemaName.toLowerCase()] = coerce(v, f);
  }
  return out;
}

function coerce(value: unknown, f: FieldMapping): unknown {
  switch (f.dataverseType) {
    case "Integer":
    case "BigInt":
      if (typeof value === "number") return Math.trunc(value);
      return parseInt(String(value), 10);
    case "Decimal":
    case "Double":
    case "Money":
      if (typeof value === "number") return value;
      return parseFloat(String(value));
    case "Boolean":
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      return /^(true|1|yes|y)$/i.test(String(value));
    case "DateTime":
      // Helper emits ISO 8601 already; pass through.
      return String(value);
    default:
      return String(value);
  }
}

function findPrimaryKeyAccessColumn(t: AccessTable): string | undefined {
  const pkCol = t.columns.find((c) => c.isPrimaryKey);
  return pkCol?.name;
}

/* ----------------------------------------------------------------------- */
/* HTTP                                                                    */
/* ----------------------------------------------------------------------- */

async function dvFetch(envUrl: string, path: string, init: RequestInit): Promise<Response> {
  const url = `${apiBase(envUrl)}/${path}`;
  const defaultHeaders: Record<string, string> = {
    Accept: "application/json",
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
  };
  const headers: Record<string, string> = {
    ...defaultHeaders,
    ...((init.headers as Record<string, string>) ?? {}),
  };

  let attempt = 0;
  while (true) {
    const resp = await fetch(url, { ...init, headers, credentials: "include" });
    if (resp.status === 429 || resp.status === 503) {
      const retryAfter = parseFloat(resp.headers.get("Retry-After") ?? "2");
      const waitMs = Math.min(30000, Math.max(500, retryAfter * 1000));
      await sleep(waitMs);
      attempt++;
      if (attempt > 5) throw new Error(`Dataverse throttled (${resp.status}) after ${attempt} retries.`);
      continue;
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Dataverse ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`);
    }
    return resp;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeOData(s: string): string {
  return s.replace(/'/g, "''");
}
