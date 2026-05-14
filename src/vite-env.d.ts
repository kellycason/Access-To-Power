/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Full Dataverse environment URL, e.g. https://yourorg.crm.dynamics.com */
  readonly VITE_DATAVERSE_URL?: string;
  /** Entra tenant GUID. */
  readonly VITE_TENANT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
