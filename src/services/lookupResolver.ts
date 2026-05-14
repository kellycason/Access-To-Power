/**
 * Lookup resolver (pass 2).
 *
 * After loadData(), every migrated table has rows in Dataverse but their
 * lookup columns are blank. This pass uses the in-memory id map to patch
 * each child row's lookup column with the corresponding parent GUID via
 * @odata.bind.
 *
 * One PATCH per child row that has a non-null FK. Throttle-aware.
 */

import type { MigrationPlan } from "../types/manifest";
import type { IdMap } from "./dataLoader";
import type { ProgressCallback } from "./schemaCreator";
import { apiBase } from "./apiBase";

export interface ResolveOptions {
  envUrl: string;
  plan: MigrationPlan;
  publisherPrefix: string;
  idMap: IdMap;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

export async function resolveLookups(opts: ResolveOptions): Promise<void> {
  const { envUrl, plan, publisherPrefix, idMap } = opts;
  const log = opts.onProgress ?? (() => {});

  const relevant = plan.manifest.relationships.filter((r) => r.childColumns.length === 1);
  if (relevant.length === 0) {
    log({ kind: "phase", message: "No relationships to resolve." });
    return;
  }
  log({ kind: "phase", message: `Resolving ${relevant.length} lookups…` });

  for (let i = 0; i < relevant.length; i++) {
    opts.signal?.throwIfAborted();
    const rel = relevant[i];
    const parentMap = plan.tableMappings.find(
      (t) => t.accessTable === rel.parentTable && t.action === "Migrate",
    );
    const childMap = plan.tableMappings.find(
      (t) => t.accessTable === rel.childTable && t.action === "Migrate",
    );
    if (!parentMap || !childMap) continue;

    const childRows = plan.manifest.tables.find((t) => t.name === rel.childTable);
    if (!childRows) continue;

    const childLogical = childMap.dataverseSchemaName.toLowerCase();
    const parentLogical = parentMap.dataverseSchemaName.toLowerCase();
    const childIdByPk = idMap.get(childLogical);
    const parentIdByPk = idMap.get(parentLogical);
    if (!childIdByPk || !parentIdByPk) continue;

    const childFkCol = rel.childColumns[0];
    const childPkCol = childRows.columns.find((c) => c.isPrimaryKey)?.name;
    if (!childPkCol) continue;

    const lookupLogical = `${publisherPrefix.toLowerCase()}_${slug(lookupBaseName(childFkCol))}`;
    const parentEntitySet = parentMap.dataverseEntitySetName ?? await resolveEntitySet(envUrl, parentLogical, opts.signal);
    const childEntitySet = childMap.dataverseEntitySetName ?? await resolveEntitySet(envUrl, childLogical, opts.signal);

    const rows = await fetchNdjsonRows(envUrl, plan.migrationJobId, childRows.rowsFile, opts.signal);
    let patched = 0;
    let missing = 0;
    const pct = Math.round((i / relevant.length) * 100);

    for (const row of rows) {
      opts.signal?.throwIfAborted();
      const pkVal = row[childPkCol];
      const fkVal = row[childFkCol];
      if (pkVal === null || pkVal === undefined) continue;
      if (fkVal === null || fkVal === undefined) continue;
      const childId = childIdByPk.get(String(pkVal));
      const parentId = parentIdByPk.get(String(fkVal));
      if (!childId || !parentId) {
        missing++;
        continue;
      }
      await patchLookup(envUrl, childEntitySet, childId, lookupLogical, parentEntitySet, parentId, opts.signal);
      patched++;
    }

    log({
      kind: "lookup",
      message: `${rel.name}: patched ${patched} rows (${missing} unresolved)`,
      progress: pct,
      severity: missing > 0 ? "warn" : undefined,
    });
  }

  log({ kind: "phase", message: "Lookup resolution complete.", progress: 100 });
}

async function patchLookup(
  envUrl: string,
  childEntitySet: string,
  childId: string,
  lookupLogical: string,
  parentEntitySet: string,
  parentId: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const body: Record<string, unknown> = {};
  body[`${lookupLogical}@odata.bind`] = `/${parentEntitySet}(${parentId})`;
  await dvFetch(envUrl, `${childEntitySet}(${childId})`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "If-Match": "*",
    },
    body: JSON.stringify(body),
    signal,
  });
}

const entitySetCache = new Map<string, string>();

async function resolveEntitySet(envUrl: string, logical: string, signal?: AbortSignal): Promise<string> {
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
    try { rows.push(JSON.parse(clean) as Record<string, unknown>); } catch { /* skip */ }
  }
  return rows;
}

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

async function dvFetch(envUrl: string, path: string, init: RequestInit): Promise<Response> {
  const url = `${apiBase(envUrl)}/${path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  let attempt = 0;
  while (true) {
    const resp = await fetch(url, { ...init, headers, credentials: "include" });
    if (resp.status === 429 || resp.status === 503) {
      const retryAfter = parseFloat(resp.headers.get("Retry-After") ?? "2");
      await sleep(Math.min(30000, Math.max(500, retryAfter * 1000)));
      attempt++;
      if (attempt > 5) throw new Error(`Dataverse throttled after ${attempt} retries.`);
      continue;
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Dataverse ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`);
    }
    return resp;
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function slug(s: string): string { return s.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase().slice(0, 40); }
function lookupBaseName(accessForeignKeyColumn: string): string { const trimmed = accessForeignKeyColumn.trim(); return trimmed.replace(/(?:_?id)$/i, "") || trimmed; }
function escapeOData(s: string): string { return s.replace(/'/g, "''"); }
