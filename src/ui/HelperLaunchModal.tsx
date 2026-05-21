import { Modal } from "./Modal";
import { Button } from "./Button";

export type HelperMode = "scan" | "snapshot" | "migrate-full" | "migrate-schema" | "migrate-data";

interface ModeCopy {
  title: string;
  description: string;
  detail: string;
}

const COPY: Record<HelperMode, ModeCopy> = {
  scan: {
    title: "Open the desktop helper",
    description: "We'll open the Access-To-Power Helper on your machine to scan your .accdb file.",
    detail:
      "The helper reads your Access database locally using the 64-bit Access Database Engine, builds a schema manifest, and uploads it back to this app. Your data never leaves your machine until you approve the migration.",
  },
  snapshot: {
    title: "Capture a Dataverse schema snapshot",
    description: "We'll open the helper to enumerate the tables and columns already in your Dataverse environment.",
    detail:
      "The helper queries Dataverse for every table you can see, packages the metadata as a snapshot, and uploads it so you can pick which existing tables and columns to reuse.",
  },
  "migrate-full": {
    title: "Start the full migration",
    description: "We'll open the helper to provision the Dataverse schema and load your data in one pass.",
    detail:
      "The helper will create tables, columns, lookups, and alternate keys, then insert rows from Access in two passes (data first, then lookup resolution). Progress will stream back to this view.",
  },
  "migrate-schema": {
    title: "Provision the schema",
    description: "We'll open the helper to create the Dataverse tables and columns only.",
    detail:
      "No rows will be loaded yet. After the schema is ready, you can review it in the maker portal and then come back to load data.",
  },
  "migrate-data": {
    title: "Load the data",
    description: "We'll open the helper to insert your rows into the existing Dataverse tables.",
    detail:
      "The helper will run the two-pass data load against the schema we provisioned earlier and report progress here.",
  },
};

interface Props {
  open: boolean;
  mode: HelperMode;
  helperUrl: string;
  onClose: () => void;
  onLaunched?: () => void;
  /**
   * @deprecated Modal now closes itself after launching. Kept for prop
   * compatibility with existing callers but unused.
   */
  autoCloseSignal?: boolean;
}

export function HelperLaunchModal({ open, mode, helperUrl, onClose, onLaunched }: Props) {
  const copy = COPY[mode];

  function launch() {
    // Modern Chromium-based browsers (especially in iframe-hosted Power Apps
    // surfaces) silently drop iframe-initiated custom-protocol navigations,
    // which leaves the user stuck because the helper never actually starts.
    // A hidden anchor click in the top-level document reliably surfaces the OS
    // "Open AccessToPowerHelper?" confirmation and does NOT navigate the page
    // (the click is on an <a>, not a window.location assignment).
    let launched = false;
    try {
      const a = document.createElement("a");
      a.href = helperUrl;
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      launched = true;
    } catch {
      /* fall through to window.location */
    }
    if (!launched) {
      try {
        window.location.href = helperUrl;
      } catch {
        /* noop — user can copy the URL from the inline waiting panel */
      }
    }
    // Close immediately — the browser's own "Open AccessToPowerHelper?"
    // permission dialog is the user's "it's launching" cue. The inline
    // HelperWaitingPanel on the step page takes it from here.
    onLaunched?.();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} size="md">
      <div className="flex items-start gap-4">
        <div className="h-10 w-10 rounded-xl bg-brand-100 text-brand-700 flex items-center justify-center shrink-0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8" />
            <path d="M12 17v4" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="text-lg font-semibold text-ink-900">{copy.title}</div>
          <p className="text-sm text-ink-600 mt-1">{copy.description}</p>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-ink-200 bg-ink-50 p-4 text-sm text-ink-700">
        {copy.detail}
      </div>

      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="flex items-start gap-2">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" className="text-amber-600 mt-0.5 shrink-0" aria-hidden>
            <path d="M10 2a1 1 0 01.87.5l8 14A1 1 0 0118 18H2a1 1 0 01-.87-1.5l8-14A1 1 0 0110 2zm0 5a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1zm0 8a1 1 0 100 2 1 1 0 000-2z" />
          </svg>
          <div className="text-xs text-amber-900">
            <div className="font-semibold">Your browser will ask permission.</div>
            <div className="mt-0.5">
              After you click <strong>Open helper</strong>, your browser will show a
              &ldquo;This site is trying to open AccessToPowerHelper&rdquo; prompt — click{" "}
              <strong>Open</strong> to continue. Tick &ldquo;Always allow&rdquo; to skip it
              next time.
            </div>
          </div>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={launch}>
          Open helper
        </Button>
      </div>
    </Modal>
  );
}
