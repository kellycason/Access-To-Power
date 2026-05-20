/**
 * Dataverse client used by the Code App. Exposes only the operations the
 * wizard actually needs against the `acp_*` tables. Three implementations:
 *
 * - PowerAppsSdkDataverseClient — uses the Power Apps Code Apps host bridge
 *   and generated data-source services. This is the hosted Power Platform path
 *   and avoids browser CORS/auth failures.
 *
 * - WebApiDataverseClient — calls `/api/data/v9.2/` directly using the
 *   Vite dev-server proxy. This is local-development only.
 *
 * - MockDataverseClient — keeps state in sessionStorage so the wizard is
 *   usable in `npm run dev` with no environment configured.
 *
 * The Connect / Scan / Validate steps depend only on this interface so
 * we can swap the impl based on whether the SDK context resolves.
 */

import { getContext as getPowerAppsContext } from "@microsoft/power-apps/app";
import { getClient, type IOperationResult } from "@microsoft/power-apps/data";
import type { AccessSchemaManifest, MigrationPlan } from "../types/manifest";
import type { SchemaSnapshot } from "./existingDataverse";
import { apiBase } from "./apiBase";

export interface CreateJobInput {
  name: string;
  /** Optional: target solution unique name (defaults to a generated one). */
  targetSolutionName?: string;
  /** Optional: target publisher prefix (defaults to a generated one). */
  targetPublisherPrefix?: string;
}

export interface MigrationJobSnapshot {
  migrationJobId: string;
  name: string;
  /** Numeric status from acp_status choice (1=Draft … 12=Cancelled). */
  status: number;
  manifestPresent: boolean;
  targetSolutionName?: string;
  targetPublisherPrefix?: string;
}

export interface SolutionOption {
  solutionId: string;
  uniqueName: string;
  friendlyName: string;
  publisherPrefix: string;
  publisherName?: string;
}

export interface DataverseClient {
  /** Resolve environment URL + tenant for the helper protocol launch. */
  getContext(): Promise<{ environmentUrl: string; tenantId: string }>;

  createMigrationJob(input: CreateJobInput): Promise<{ migrationJobId: string }>;

  getJob(migrationJobId: string): Promise<MigrationJobSnapshot>;

  /** Patches acp_status on the migration job. */
  setJobStatus(migrationJobId: string, status: number): Promise<void>;

  /** Returns the parsed manifest JSON if it's been uploaded, otherwise null. */
  tryGetManifest(migrationJobId: string): Promise<AccessSchemaManifest | null>;

  /** Returns the schema snapshot captured by the desktop helper, otherwise null. */
  tryGetSchemaSnapshot(migrationJobId: string): Promise<SchemaSnapshot | null>;

  /** Uploads (or replaces) the approved MigrationPlan as a JSON annotation. */
  savePlan(migrationJobId: string, plan: MigrationPlan): Promise<void>;

  /** Returns parsed migration plan JSON if it's been uploaded, otherwise null. */
  tryGetPlan(migrationJobId: string): Promise<MigrationPlan | null>;

  /** Returns the helper's migration progress log (NDJSON, one event per line) if present. */
  tryGetMigrationLog(migrationJobId: string): Promise<string | null>;

  /** Existing unmanaged solutions that can receive migrated tables. */
  listSolutions(): Promise<SolutionOption[]>;
}

/* ----------------------------------------------------------------------- */
/* Web API implementation                                                  */
/* ----------------------------------------------------------------------- */

const ACCESS_TOPOWER_JOB_SET = "acp_migrationjobs";
const ANNOTATION_SET = "annotations";
const SOLUTION_SET = "solutions";
const PUBLISHER_SET = "publishers";
const SOLUTIONS_CACHE_PREFIX = "acp_solution_options_v2";
const SOLUTIONS_CACHE_MS = 5 * 60 * 1000;

const powerAppsDataClient = getClient({
  [ACCESS_TOPOWER_JOB_SET]: {
    tableId: "",
    version: "",
    primaryKey: "acp_migrationjobid",
    dataSourceType: "Dataverse",
    apis: {},
  },
  [ANNOTATION_SET]: {
    tableId: "",
    version: "",
    primaryKey: "annotationid",
    dataSourceType: "Dataverse",
    apis: {},
  },
  [SOLUTION_SET]: {
    tableId: "",
    version: "",
    primaryKey: "solutionid",
    dataSourceType: "Dataverse",
    apis: {},
  },
  [PUBLISHER_SET]: {
    tableId: "",
    version: "",
    primaryKey: "publisherid",
    dataSourceType: "Dataverse",
    apis: {},
  },
});

interface MigrationJobRow {
  acp_migrationjobid: string;
  acp_name: string;
  acp_status?: number;
  acp_targetsolutionname?: string;
  acp_targetpublisherprefix?: string;
}

interface AnnotationRow {
  annotationid: string;
  documentbody?: string;
}

interface SolutionRow {
  solutionid: string;
  uniquename: string;
  friendlyname: string;
  ismanaged?: boolean;
  isvisible?: boolean;
  _publisherid_value?: string;
}

interface PublisherRow {
  publisherid: string;
  friendlyname?: string;
  customizationprefix?: string;
}

export class PowerAppsSdkDataverseClient implements DataverseClient {
  private readonly envUrl: string;
  private readonly tenantId: string | undefined;

  constructor(envUrl: string, tenantId?: string) {
    this.envUrl = envUrl.replace(/\/+$/, "");
    this.tenantId = tenantId;
  }

  async getContext() {
    const context = await getPowerAppsContext().catch(() => null);
    const tenantId =
      context?.user.tenantId ??
      this.tenantId ??
      (import.meta.env.VITE_TENANT_ID as string | undefined);

    if (!this.envUrl) {
      throw new Error(
        "Dataverse environment URL is not configured. Set VITE_DATAVERSE_URL before building the Code App.",
      );
    }
    if (!tenantId) {
      throw new Error(
        "Tenant ID is not available from Power Apps context or VITE_TENANT_ID.",
      );
    }

    return { environmentUrl: this.envUrl, tenantId };
  }

  async createMigrationJob(input: CreateJobInput): Promise<{ migrationJobId: string }> {
    const result = await powerAppsDataClient.createRecordAsync<Record<string, unknown>, MigrationJobRow>(
      ACCESS_TOPOWER_JOB_SET,
      {
        acp_name: input.name,
        acp_status: 1,
        acp_targetsolutionname: input.targetSolutionName,
        acp_targetpublisherprefix: input.targetPublisherPrefix,
      },
    );
    const row = assertOperation(result, "create migration job");
    return { migrationJobId: row.acp_migrationjobid };
  }

  async getJob(migrationJobId: string): Promise<MigrationJobSnapshot> {
    const result = await powerAppsDataClient.retrieveRecordAsync<MigrationJobRow>(
      ACCESS_TOPOWER_JOB_SET,
      migrationJobId,
      {
        select: [
          "acp_migrationjobid",
          "acp_name",
          "acp_status",
          "acp_targetsolutionname",
          "acp_targetpublisherprefix",
        ],
      },
    );
    const row = assertOperation(result, "get migration job");
    const manifestPresent = await this.hasManifestAnnotation(migrationJobId);
    return {
      migrationJobId: row.acp_migrationjobid,
      name: row.acp_name,
      status: row.acp_status ?? 1,
      manifestPresent,
      targetSolutionName: row.acp_targetsolutionname,
      targetPublisherPrefix: row.acp_targetpublisherprefix,
    };
  }

  async setJobStatus(migrationJobId: string, status: number): Promise<void> {
    const result = await powerAppsDataClient.updateRecordAsync<Record<string, unknown>, MigrationJobRow>(
      ACCESS_TOPOWER_JOB_SET,
      migrationJobId,
      { acp_status: status },
    );
    assertOperation(result, "update migration job status");
  }

  async tryGetManifest(migrationJobId: string): Promise<AccessSchemaManifest | null> {
    const annotation = await this.findManifestAnnotation(migrationJobId, ["annotationid", "documentbody"]);
    if (!annotation?.documentbody) return null;
    return JSON.parse(decodeBase64Utf8(annotation.documentbody)) as AccessSchemaManifest;
  }

  async tryGetSchemaSnapshot(migrationJobId: string): Promise<SchemaSnapshot | null> {
    const annotation = await this.findAnnotationByName(migrationJobId, "schema-snapshot.json", ["annotationid", "documentbody"]);
    if (!annotation?.documentbody) return null;
    try {
      return JSON.parse(decodeBase64Utf8(annotation.documentbody)) as SchemaSnapshot;
    } catch {
      return null;
    }
  }

  async savePlan(migrationJobId: string, plan: MigrationPlan): Promise<void> {
    const json = JSON.stringify(plan);
    const body = encodeBase64Utf8(json);
    // Replace any existing plan annotation by deleting first; the SDK does not expose PATCH-by-filter.
    const existing = await this.findAnnotationByName(migrationJobId, "migration-plan.json", ["annotationid"]);
    if (existing?.annotationid) {
      const del = await powerAppsDataClient.deleteRecordAsync(ANNOTATION_SET, existing.annotationid);
      assertOperation(del, "delete previous migration-plan.json");
    }
    const create = await powerAppsDataClient.createRecordAsync<Record<string, unknown>, AnnotationRow>(
      ANNOTATION_SET,
      {
        subject: "migration-plan.json",
        filename: "migration-plan.json",
        mimetype: "application/json",
        documentbody: body,
        "objectid_acp_migrationjob@odata.bind": `/acp_migrationjobs(${migrationJobId})`,
      },
    );
    assertOperation(create, "save migration plan");
  }

  async tryGetPlan(migrationJobId: string): Promise<MigrationPlan | null> {
    const annotation = await this.findAnnotationByName(migrationJobId, "migration-plan.json", ["annotationid", "documentbody"]);
    if (!annotation?.documentbody) return null;
    try {
      return JSON.parse(decodeBase64Utf8(annotation.documentbody)) as MigrationPlan;
    } catch {
      return null;
    }
  }

  async tryGetMigrationLog(migrationJobId: string): Promise<string | null> {
    const annotation = await this.findAnnotationByName(migrationJobId, "migration-log.ndjson", ["annotationid", "documentbody"]);
    if (!annotation?.documentbody) return null;
    try {
      return decodeBase64Utf8(annotation.documentbody);
    } catch {
      return null;
    }
  }

  private async hasManifestAnnotation(migrationJobId: string): Promise<boolean> {
    return Boolean(await this.findManifestAnnotation(migrationJobId, ["annotationid"]));
  }

  private async findManifestAnnotation(
    migrationJobId: string,
    select: string[],
  ): Promise<AnnotationRow | null> {
    return this.findAnnotationByName(migrationJobId, "manifest.json", select);
  }

  private async findAnnotationByName(
    migrationJobId: string,
    fileName: string,
    select: string[],
  ): Promise<AnnotationRow | null> {
    const result = await powerAppsDataClient.retrieveMultipleRecordsAsync<AnnotationRow>(ANNOTATION_SET, {
      select,
      filter: `_objectid_value eq ${migrationJobId} and filename eq '${escapeOData(fileName)}'`,
      top: 1,
    });
    const rows = assertOperation(result, `find ${fileName} annotation`);
    return rows[0] ?? null;
  }

  async listSolutions(): Promise<SolutionOption[]> {
    const cacheKey = solutionCacheKey(this.envUrl);
    const cached = readCachedSolutions(cacheKey);
    if (cached) return cached;

    const solutionResult = await powerAppsDataClient.retrieveMultipleRecordsAsync<SolutionRow>(SOLUTION_SET, {
      select: ["solutionid", "uniquename", "friendlyname", "ismanaged", "isvisible", "_publisherid_value"],
      filter: "ismanaged eq false and isvisible eq true",
      orderBy: ["friendlyname asc"],
    });
    const solutionRows = assertOperation(solutionResult, "list solutions");
    const publisherIds = Array.from(new Set(
      solutionRows
        .map((solution) => solution._publisherid_value?.toLowerCase())
        .filter((value): value is string => Boolean(value)),
    ));

    if (publisherIds.length === 0) {
      writeCachedSolutions(cacheKey, []);
      return [];
    }

    const publisherResult = await powerAppsDataClient.retrieveMultipleRecordsAsync<PublisherRow>(PUBLISHER_SET, {
      select: ["publisherid", "friendlyname", "customizationprefix"],
      filter: publisherIds.map((id) => `publisherid eq ${id}`).join(" or "),
    });
    const publishers = new Map(
      assertOperation(publisherResult, "list publishers")
        .filter((publisher) => publisher.publisherid)
        .map((publisher) => [publisher.publisherid.toLowerCase(), publisher]),
    );

    const solutions = toSolutionOptions(solutionRows, publishers);
    writeCachedSolutions(cacheKey, solutions);
    return solutions;
  }
}

export class WebApiDataverseClient implements DataverseClient {
  private readonly envUrl: string;
  private readonly tenantId: string;

  constructor(envUrl: string, tenantId: string) {
    this.envUrl = envUrl.replace(/\/+$/, "");
    this.tenantId = tenantId;
  }

  async getContext() {
    return { environmentUrl: this.envUrl, tenantId: this.tenantId };
  }

  async createMigrationJob(input: CreateJobInput): Promise<{ migrationJobId: string }> {
    const body: Record<string, unknown> = {
      acp_name: input.name,
      acp_status: 1, // Draft
    };
    if (input.targetSolutionName) body.acp_targetsolutionname = input.targetSolutionName;
    if (input.targetPublisherPrefix) body.acp_targetpublisherprefix = input.targetPublisherPrefix;

    const resp = await this.fetch(`${ACCESS_TOPOWER_JOB_SET}`, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body),
    });
    const row = (await resp.json()) as { acp_migrationjobid: string };
    return { migrationJobId: row.acp_migrationjobid };
  }

  async getJob(migrationJobId: string): Promise<MigrationJobSnapshot> {
    const resp = await this.fetch(
      `${ACCESS_TOPOWER_JOB_SET}(${migrationJobId})?$select=acp_migrationjobid,acp_name,acp_status,acp_targetsolutionname,acp_targetpublisherprefix`,
    );
    const row = (await resp.json()) as {
      acp_migrationjobid: string;
      acp_name: string;
      acp_status: number;
      acp_targetsolutionname?: string;
      acp_targetpublisherprefix?: string;
    };
    const manifestPresent = await this.hasManifestAnnotation(migrationJobId);
    return {
      migrationJobId: row.acp_migrationjobid,
      name: row.acp_name,
      status: row.acp_status ?? 1,
      manifestPresent,
      targetSolutionName: row.acp_targetsolutionname,
      targetPublisherPrefix: row.acp_targetpublisherprefix,
    };
  }

  async setJobStatus(migrationJobId: string, status: number): Promise<void> {
    await this.fetch(`${ACCESS_TOPOWER_JOB_SET}(${migrationJobId})`, {
      method: "PATCH",
      headers: { "If-Match": "*" },
      body: JSON.stringify({ acp_status: status }),
    });
  }

  async tryGetManifest(migrationJobId: string): Promise<AccessSchemaManifest | null> {
    const annotation = await this.findAnnotation(migrationJobId, "manifest.json");
    if (!annotation) return null;
    const resp = await this.fetch(
      `annotations(${annotation.annotationid})?$select=documentbody`,
    );
    const row = (await resp.json()) as { documentbody?: string };
    if (!row.documentbody) return null;
    const json = decodeBase64Utf8(row.documentbody);
    return JSON.parse(json) as AccessSchemaManifest;
  }

  async tryGetSchemaSnapshot(migrationJobId: string): Promise<SchemaSnapshot | null> {
    const annotation = await this.findAnnotation(migrationJobId, "schema-snapshot.json");
    if (!annotation) return null;
    const resp = await this.fetch(
      `annotations(${annotation.annotationid})?$select=documentbody`,
    );
    const row = (await resp.json()) as { documentbody?: string };
    if (!row.documentbody) return null;
    try {
      return JSON.parse(decodeBase64Utf8(row.documentbody)) as SchemaSnapshot;
    } catch {
      return null;
    }
  }

  async savePlan(migrationJobId: string, plan: MigrationPlan): Promise<void> {
    const existing = await this.findAnnotation(migrationJobId, "migration-plan.json");
    if (existing) {
      await this.fetch(`annotations(${existing.annotationid})`, { method: "DELETE" });
    }
    const body = encodeBase64Utf8(JSON.stringify(plan));
    await this.fetch("annotations", {
      method: "POST",
      body: JSON.stringify({
        subject: "migration-plan.json",
        filename: "migration-plan.json",
        mimetype: "application/json",
        documentbody: body,
        "objectid_acp_migrationjob@odata.bind": `/acp_migrationjobs(${migrationJobId})`,
      }),
    });
  }

  async tryGetPlan(migrationJobId: string): Promise<MigrationPlan | null> {
    const annotation = await this.findAnnotation(migrationJobId, "migration-plan.json");
    if (!annotation) return null;
    const resp = await this.fetch(
      `annotations(${annotation.annotationid})?$select=documentbody`,
    );
    const row = (await resp.json()) as { documentbody?: string };
    if (!row.documentbody) return null;
    try {
      return JSON.parse(decodeBase64Utf8(row.documentbody)) as MigrationPlan;
    } catch {
      return null;
    }
  }

  async tryGetMigrationLog(migrationJobId: string): Promise<string | null> {
    const annotation = await this.findAnnotation(migrationJobId, "migration-log.ndjson");
    if (!annotation) return null;
    const resp = await this.fetch(
      `annotations(${annotation.annotationid})?$select=documentbody`,
    );
    const row = (await resp.json()) as { documentbody?: string };
    if (!row.documentbody) return null;
    try {
      return decodeBase64Utf8(row.documentbody);
    } catch {
      return null;
    }
  }

  private async hasManifestAnnotation(migrationJobId: string): Promise<boolean> {
    const annotation = await this.findAnnotation(migrationJobId, "manifest.json");
    return annotation !== null;
  }

  private async findAnnotation(
    migrationJobId: string,
    fileName: string,
  ): Promise<{ annotationid: string } | null> {
    const filter = `_objectid_value eq ${migrationJobId} and filename eq '${escapeOData(fileName)}'`;
    const resp = await this.fetch(
      `annotations?$select=annotationid&$filter=${encodeURIComponent(filter)}&$top=1`,
    );
    const body = (await resp.json()) as { value: Array<{ annotationid: string }> };
    return body.value[0] ?? null;
  }

  async listSolutions(): Promise<SolutionOption[]> {
    const cacheKey = solutionCacheKey(this.envUrl);
    const cached = readCachedSolutions(cacheKey);
    if (cached) return cached;

    const resp = await this.fetch(
      "solutions?$select=solutionid,uniquename,friendlyname,ismanaged,isvisible" +
        "&$expand=publisherid($select=customizationprefix,friendlyname)" +
        "&$filter=ismanaged eq false and isvisible eq true&$orderby=friendlyname asc",
    );
    const body = (await resp.json()) as {
      value: Array<SolutionRow & { publisherid?: PublisherRow }>;
    };
    const solutions = body.value
      .map((solution) => ({
        solutionId: solution.solutionid,
        uniqueName: solution.uniquename,
        friendlyName: solution.friendlyname || solution.uniquename,
        publisherPrefix: solution.publisherid?.customizationprefix ?? "",
        publisherName: solution.publisherid?.friendlyname,
      }))
      .filter((solution) => solution.uniqueName && solution.publisherPrefix)
      .sort(compareSolutions);
    writeCachedSolutions(cacheKey, solutions);
    return solutions;
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${apiBase(this.envUrl)}/${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      ...((init.headers as Record<string, string>) ?? {}),
    };
    const resp = await fetch(url, { ...init, headers, credentials: "include" });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Dataverse ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`);
    }
    return resp;
  }
}

interface CachedSolutions {
  createdAt: number;
  solutions: SolutionOption[];
}

function solutionCacheKey(envUrl: string): string {
  return `${SOLUTIONS_CACHE_PREFIX}:${envUrl.toLowerCase()}`;
}

function readCachedSolutions(key: string): SolutionOption[] | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedSolutions;
    if (Date.now() - cached.createdAt > SOLUTIONS_CACHE_MS) return null;
    if (!Array.isArray(cached.solutions)) return null;
    return cached.solutions;
  } catch {
    return null;
  }
}

function writeCachedSolutions(key: string, solutions: SolutionOption[]): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ createdAt: Date.now(), solutions } satisfies CachedSolutions));
  } catch {
    /* ignore cache write failures */
  }
}

function escapeOData(s: string): string {
  return s.replace(/'/g, "''");
}

function assertOperation<T>(result: IOperationResult<T>, action: string): T {
  if (!result.success) {
    const message = result.error instanceof Error
      ? result.error.message
      : result.error?.message ?? `Power Apps SDK could not ${action}.`;
    throw new Error(message);
  }
  return result.data;
}

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/* ----------------------------------------------------------------------- */
/* Mock implementation (local dev / no Dataverse)                          */
/* ----------------------------------------------------------------------- */

const MOCK_KEY = "acp_mock_jobs_v1";

interface MockState {
  jobs: Record<string, {
    name: string;
    status: number;
    manifestUrl?: string;
    targetSolutionName?: string;
    targetPublisherPrefix?: string;
  }>;
}

export class MockDataverseClient implements DataverseClient {
  private readonly fixtureUrl: string;

  constructor(fixtureUrl = "/fixtures/northwind.manifest.json") {
    this.fixtureUrl = fixtureUrl;
  }

  async getContext() {
    return {
      environmentUrl: "https://mock.example.invalid",
      tenantId: "00000000-0000-0000-0000-000000000000",
    };
  }

  async createMigrationJob(input: CreateJobInput) {
    const id = crypto.randomUUID();
    const state = this.read();
    state.jobs[id] = {
      name: input.name,
      status: 1,
      manifestUrl: this.fixtureUrl,
      targetSolutionName: input.targetSolutionName,
      targetPublisherPrefix: input.targetPublisherPrefix,
    };
    this.write(state);
    return { migrationJobId: id };
  }

  async getJob(migrationJobId: string): Promise<MigrationJobSnapshot> {
    const state = this.read();
    const job = state.jobs[migrationJobId];
    if (!job) throw new Error(`Mock job ${migrationJobId} not found.`);
    return {
      migrationJobId,
      name: job.name,
      status: job.status,
      manifestPresent: Boolean(job.manifestUrl),
      targetSolutionName: job.targetSolutionName,
      targetPublisherPrefix: job.targetPublisherPrefix,
    };
  }

  async setJobStatus(migrationJobId: string, status: number): Promise<void> {
    const state = this.read();
    const job = state.jobs[migrationJobId];
    if (!job) throw new Error(`Mock job ${migrationJobId} not found.`);
    job.status = status;
    this.write(state);
  }

  async tryGetManifest(migrationJobId: string): Promise<AccessSchemaManifest | null> {
    const state = this.read();
    const job = state.jobs[migrationJobId];
    if (!job?.manifestUrl) return null;
    const resp = await fetch(job.manifestUrl);
    if (!resp.ok) throw new Error(`Mock manifest fetch failed: ${resp.status}`);
    return (await resp.json()) as AccessSchemaManifest;
  }

  async tryGetSchemaSnapshot(_migrationJobId: string): Promise<SchemaSnapshot | null> {
    return null;
  }

  async savePlan(_migrationJobId: string, _plan: MigrationPlan): Promise<void> {
    /* Mock: no-op. */
  }

  async tryGetPlan(_migrationJobId: string): Promise<MigrationPlan | null> {
    return null;
  }

  async tryGetMigrationLog(_migrationJobId: string): Promise<string | null> {
    return null;
  }

  async listSolutions(): Promise<SolutionOption[]> {
    return [
      {
        solutionId: "00000000-0000-0000-0000-000000000001",
        uniqueName: "AccessToPower",
        friendlyName: "Access to Power",
        publisherPrefix: "acp",
        publisherName: "Access to Power",
      },
      {
        solutionId: "00000000-0000-0000-0000-000000000002",
        uniqueName: "NorthwindMigration",
        friendlyName: "Northwind Migration",
        publisherPrefix: "nw",
        publisherName: "Northwind",
      },
    ];
  }

  private read(): MockState {
    try {
      const raw = sessionStorage.getItem(MOCK_KEY);
      if (raw) return JSON.parse(raw) as MockState;
    } catch {
      /* ignore */
    }
    return { jobs: {} };
  }

  private write(s: MockState): void {
    sessionStorage.setItem(MOCK_KEY, JSON.stringify(s));
  }
}

function toSolutionOptions(
  solutions: SolutionRow[],
  publishers: Map<string, PublisherRow>,
): SolutionOption[] {
  return solutions
    .map((solution) => {
      const publisherId = solution._publisherid_value?.toLowerCase() ?? "";
      const publisher = publishers.get(publisherId);
      return {
        solutionId: solution.solutionid,
        uniqueName: solution.uniquename,
        friendlyName: solution.friendlyname || solution.uniquename,
        publisherPrefix: publisher?.customizationprefix ?? "",
        publisherName: publisher?.friendlyname,
      };
    })
    .filter((solution) => solution.uniqueName && solution.publisherPrefix)
    .sort(compareSolutions);
}

function compareSolutions(a: SolutionOption, b: SolutionOption): number {
  return a.friendlyName.localeCompare(b.friendlyName) || a.uniqueName.localeCompare(b.uniqueName);
}

/* ----------------------------------------------------------------------- */
/* Resolver                                                                */
/* ----------------------------------------------------------------------- */

/**
 * Decides which client to use based on power.config.json values that the
 * Vite build inlines into the bundle. When running in `npm run dev` without
 * a real env wired up, the mock client kicks in.
 */
export function getDataverseClient(): DataverseClient {
  const envUrl = import.meta.env.VITE_DATAVERSE_URL as string | undefined;
  const tenantId = import.meta.env.VITE_TENANT_ID as string | undefined;

  if (!import.meta.env.DEV) {
    return new PowerAppsSdkDataverseClient(envUrl ?? "", tenantId);
  }

  if (envUrl && tenantId) {
    return new WebApiDataverseClient(envUrl, tenantId);
  }
  return new MockDataverseClient();
}
