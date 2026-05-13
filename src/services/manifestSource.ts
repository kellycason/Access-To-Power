import type { AccessSchemaManifest } from "../types/manifest";

/**
 * Loads a manifest. In production, the helper drops a manifest on a
 * Dataverse File column on `acp_migrationjob`. For local development, the
 * mock source reads a fixture from /fixtures so the wizard UI is fully
 * usable before the helper exists.
 */
export interface ManifestSource {
  load(): Promise<AccessSchemaManifest>;
}

export class MockManifestSource implements ManifestSource {
  private readonly url: string;

  constructor(url: string = "/fixtures/northwind.manifest.json") {
    this.url = url;
  }

  async load(): Promise<AccessSchemaManifest> {
    const resp = await fetch(this.url);
    if (!resp.ok) {
      throw new Error(`Mock manifest fetch failed: ${resp.status}`);
    }
    return (await resp.json()) as AccessSchemaManifest;
  }
}

export class DataverseManifestSource implements ManifestSource {
  private readonly migrationJobId: string;

  constructor(migrationJobId: string) {
    this.migrationJobId = migrationJobId;
  }

  load(): Promise<AccessSchemaManifest> {
    // TODO: implement with @microsoft/power-apps SDK once env is configured.
    void this.migrationJobId;
    return Promise.reject(
      new Error("DataverseManifestSource not yet implemented."),
    );
  }
}
