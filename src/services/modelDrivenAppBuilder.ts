/**
 * Generates a Dataverse model-driven app for the migrated tables by launching
 * the desktop helper.
 *
 * Why the helper, not the SPA: the Power Apps SDK's data-source registry is
 * deploy-time static (sourced from `power.config.json` `databaseReferences`),
 * so freshly-migrated user tables aren't resolvable. Raw `fetch` against
 * Dataverse from the hosted SPA origin (apps.gov.powerapps.us) is CORS-blocked
 * because cookies don't span domains. The helper runs locally, MSAL-authed,
 * and reads the migration plan from the job annotation, then writes
 * `mda-result.json` back to the same job. The SPA polls for that annotation.
 */

import type { DataverseClient } from "./dataverseClient";

export interface MdaProgressEvent {
  kind: "phase" | "log" | "done" | "error";
  message: string;
}

export interface GenerateMdaOptions {
  /** Dataverse env URL (e.g. https://orgxxx.crm9.dynamics.com). */
  environmentUrl: string;
  tenantId: string;
  migrationJobId: string;
  jobName: string;
  /** Friendly name used in the OS launch dialog (defaults to job name). */
  launchDisplayName?: string;
  /** Streamed progress (phase changes + last NDJSON log line). */
  onProgress?: (e: MdaProgressEvent) => void;
  signal?: AbortSignal;
  /** Dataverse client used to poll for the result annotation. */
  client: DataverseClient;
}

export interface GenerateMdaResult {
  appModuleId: string;
  appUniqueName: string;
  playUrl: string;
}

/** Pre-existing result kept around from a prior run. The caller should reset
 *  this annotation before launching, but we have no Web API to delete from
 *  the SPA, so the helper itself replaces the annotation when it completes. */
const POLL_INTERVAL_MS = 2_500;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000; // 10 min

export async function generateModelDrivenApp(
  opts: GenerateMdaOptions,
): Promise<GenerateMdaResult> {
  const { environmentUrl, tenantId, migrationJobId, jobName, client } = opts;
  const log = opts.onProgress ?? (() => {});

  // Snapshot any existing mda-result.json so we can detect a *new* one.
  const before = await client.tryGetMdaResult(migrationJobId);
  const beforeStamp = before?.generatedAt ?? null;

  log({ kind: "phase", message: "Launching desktop helper…" });
  const url = new URL("accesstopower://launch");
  url.searchParams.set("jobId", migrationJobId);
  url.searchParams.set("env", environmentUrl);
  url.searchParams.set("tenant", tenantId);
  url.searchParams.set("name", opts.launchDisplayName ?? jobName);
  url.searchParams.set("mode", "mda");

  // Top-level anchor click — same pattern as HelperLaunchModal.
  try {
    const a = document.createElement("a");
    a.href = url.toString();
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch {
    try {
      window.location.href = url.toString();
    } catch {
      throw new Error(
        "Couldn't launch the desktop helper. Copy this URL and open it in your browser:\n" +
          url.toString(),
      );
    }
  }

  log({ kind: "phase", message: "Waiting for the helper to generate the app…" });

  const start = Date.now();
  let lastLogLine = "";
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    opts.signal?.throwIfAborted();
    await delay(POLL_INTERVAL_MS, opts.signal);

    // Surface progress from the helper's NDJSON log.
    try {
      const ndjson = await client.tryGetMdaLog(migrationJobId);
      if (ndjson) {
        const lines = ndjson.split(/\r?\n/).filter(Boolean);
        const last = lines[lines.length - 1];
        if (last && last !== lastLogLine) {
          lastLogLine = last;
          try {
            const ev = JSON.parse(last) as { kind?: string; message?: string };
            if (ev.message) {
              const kind = ev.kind === "error" ? "error" : ev.kind === "done" ? "done" : "log";
              log({ kind: kind as MdaProgressEvent["kind"], message: ev.message });
            }
          } catch {
            /* ignore malformed log line */
          }
        }
      }
    } catch {
      /* polling errors are non-fatal */
    }

    // Check for the final result.
    try {
      const result = await client.tryGetMdaResult(migrationJobId);
      if (result && result.generatedAt && result.generatedAt !== beforeStamp) {
        log({ kind: "done", message: "App ready." });
        return {
          appModuleId: result.appModuleId,
          appUniqueName: result.appUniqueName,
          playUrl: result.playUrl,
        };
      }
    } catch {
      /* ignore and keep polling */
    }
  }

  throw new Error(
    "Timed out waiting for the helper to finish generating the app. " +
      "Check the helper window for errors and try again.",
  );
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const t = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      window.clearTimeout(t);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
