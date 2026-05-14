/**
 * Dataverse client used by the Code App. Exposes only the operations the
 * wizard actually needs against the `acp_*` tables. Two implementations:
 *
 * - WebApiDataverseClient — calls `/api/data/v9.2/` directly using the
 *   browser's authenticated session (the way the Power Apps host serves
 *   the Code App). Works when the app is hosted inside Power Platform.
 *
 * - MockDataverseClient — keeps state in sessionStorage so the wizard is
 *   usable in `npm run dev` with no environment configured.
 *
 * The Connect / Scan / Validate steps depend only on this interface so
 * we can swap the impl based on whether the SDK context resolves.
 */

import type { AccessSchemaManifest } from "../types/manifest";
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

export interface DataverseClient {
  /** Resolve environment URL + tenant for the helper protocol launch. */
  getContext(): Promise<{ environmentUrl: string; tenantId: string }>;

  createMigrationJob(input: CreateJobInput): Promise<{ migrationJobId: string }>;

  getJob(migrationJobId: string): Promise<MigrationJobSnapshot>;

  /** Patches acp_status on the migration job. */
  setJobStatus(migrationJobId: string, status: number): Promise<void>;

  /** Returns the parsed manifest JSON if it's been uploaded, otherwise null. */
  tryGetManifest(migrationJobId: string): Promise<AccessSchemaManifest | null>;
}

/* ----------------------------------------------------------------------- */
/* Web API implementation                                                  */
/* ----------------------------------------------------------------------- */

const ACCESS_TOPOWER_JOB_SET = "acp_migrationjobs";

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
    const json = atob(row.documentbody);
    return JSON.parse(json) as AccessSchemaManifest;
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

function escapeOData(s: string): string {
  return s.replace(/'/g, "''");
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
  if (envUrl && tenantId) {
    return new WebApiDataverseClient(envUrl, tenantId);
  }
  return new MockDataverseClient();
}
