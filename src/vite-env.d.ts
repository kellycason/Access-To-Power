/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Full Dataverse environment URL, e.g. https://yourorg.crm.dynamics.com */
  readonly VITE_DATAVERSE_URL?: string;
  /** Entra tenant GUID. */
  readonly VITE_TENANT_ID?: string;
  /** Download URL for the hosted Access-To-Power Helper installer zip. */
  readonly VITE_HELPER_INSTALLER_URL?: string;
  /** Display version for the hosted helper installer. */
  readonly VITE_HELPER_INSTALLER_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
