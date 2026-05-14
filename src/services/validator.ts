/**
 * Validator (pass 3).
 *
 * Counts rows in each migrated Dataverse table and compares against the
 * expected row count from the manifest. Returns a summary suitable for the
 * Validate step UI.
 */

import type { MigrationPlan } from "../types/manifest";
import type { ProgressCallback } from "./schemaCreator";
import { apiBase } from "./apiBase";

export interface ValidateOptions {
  envUrl: string;
  plan: MigrationPlan;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

export interface TableValidation {
  accessTable: string;
  dataverseTable: string;
  expectedRows: number;
  actualRows: number;
  delta: number;
  status: "ok" | "mismatch" | "error";
  message?: string;
}

export interface ValidationReport {
  tables: TableValidation[];
  totalExpected: number;
  totalActual: number;
  overallStatus: "ok" | "mismatch" | "error";
}

export async function validateMigration(opts: ValidateOptions): Promise<ValidationReport> {
  const { envUrl, plan } = opts;
  const log = opts.onProgress ?? (() => {});
  const migrateTables = plan.tableMappings.filter((t) => t.action === "Migrate");

  log({ kind: "phase", message: `Validating ${migrateTables.length} tables…` });

  const results: TableValidation[] = [];
  for (let i = 0; i < migrateTables.length; i++) {
    opts.signal?.throwIfAborted();
    const tm = migrateTables[i];
    const accessTable = plan.manifest.tables.find((t) => t.name === tm.accessTable);
    const expected = accessTable?.rowCount ?? 0;
    let actual = 0;
    let status: TableValidation["status"] = "ok";
    let message: string | undefined;
    try {
      const entitySet = await resolveEntitySet(envUrl, tm.dataverseSchemaName.toLowerCase(), opts.signal);
      actual = await count(envUrl, entitySet, opts.signal);
      if (actual !== expected) status = "mismatch";
    } catch (e) {
      status = "error";
      message = e instanceof Error ? e.message : String(e);
    }
    const delta = actual - expected;
    const result: TableValidation = {
      accessTable: tm.accessTable,
      dataverseTable: tm.dataverseSchemaName,
      expectedRows: expected,
      actualRows: actual,
      delta,
      status,
      message,
    };
    results.push(result);

    log({
      kind: "log",
      severity: status === "ok" ? undefined : status === "mismatch" ? "warn" : "error",
      message: `${tm.accessTable}: expected ${expected}, got ${actual} (${delta >= 0 ? "+" : ""}${delta})`,
      progress: Math.round(((i + 1) / migrateTables.length) * 100),
    });
  }

  const totalExpected = results.reduce((s, r) => s + r.expectedRows, 0);
  const totalActual = results.reduce((s, r) => s + r.actualRows, 0);
  const overallStatus: ValidationReport["overallStatus"] =
    results.some((r) => r.status === "error") ? "error" :
    results.some((r) => r.status === "mismatch") ? "mismatch" : "ok";

  log({
    kind: "phase",
    message: `Validation complete: ${overallStatus}.`,
    progress: 100,
    severity: overallStatus === "ok" ? undefined : overallStatus === "mismatch" ? "warn" : "error",
  });

  return { tables: results, totalExpected, totalActual, overallStatus };
}

async function count(envUrl: string, entitySet: string, signal?: AbortSignal): Promise<number> {
  // FetchXML aggregate count is the only way to get an exact count past 5000.
  const fetchXml = `<fetch aggregate='true'><entity name='${stripSetSuffix(entitySet)}'><attribute name='${stripSetSuffix(entitySet)}id' alias='c' aggregate='count'/></entity></fetch>`;
  const resp = await dvFetch(envUrl, `${entitySet}?fetchXml=${encodeURIComponent(fetchXml)}`, { signal });
  const body = (await resp.json()) as { value: Array<{ c: number }> };
  return body.value[0]?.c ?? 0;
}

// Dataverse entity set names are pluralized using English rules. The simplest
// way to back into the entity logical name is to strip the trailing 's' if
// present — but that breaks 'addresses' -> 'address'. Use the metadata endpoint
// instead when in doubt; for our count() helper above we just need the logical
// name as it appears in the fetch element, which is the singular form.
// For brevity we maintain a cache populated by resolveEntitySet().
const setToLogical = new Map<string, string>();
function stripSetSuffix(entitySet: string): string {
  return setToLogical.get(entitySet) ?? entitySet;
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
  setToLogical.set(body.EntitySetName, logical);
  return body.EntitySetName;
}

async function dvFetch(envUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${apiBase(envUrl)}/${path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
    Prefer: 'odata.include-annotations="*"',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const resp = await fetch(url, { ...init, headers, credentials: "include" });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dataverse ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`);
  }
  return resp;
}
