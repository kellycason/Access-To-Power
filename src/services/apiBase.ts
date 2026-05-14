/**
 * Resolves the base URL for Dataverse Web API calls.
 *
 * - In the Vite dev server, requests go through the `/dv-api` proxy defined
 *   in `vite.config.ts`, which forwards to the configured environment with
 *   an Authorization header sourced from the local `az` CLI.
 * - In the Power Apps Code Apps host (production), requests go directly to
 *   the environment URL — the host injects auth.
 *
 * Callers pass the real environment URL (from `client.getContext()`); this
 * helper returns the correct base for fetch URLs.
 */
export function apiBase(envUrl: string): string {
  if (import.meta.env.DEV) {
    return "/dv-api/api/data/v9.2";
  }
  return `${envUrl.replace(/\/+$/, "")}/api/data/v9.2`;
}
