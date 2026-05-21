import type { WizardStep } from "../App";
import { cx } from "../ui/cx";

const STEP_LABELS: Record<WizardStep, string> = {
  connect: "Connect",
  scan: "Scan",
  map: "Map",
  migrate: "Migrate",
  validate: "Validate",
};

interface Props {
  steps: WizardStep[];
  current: WizardStep;
  onSelect: (step: WizardStep) => void;
  visited?: WizardStep[];
  /**
   * When true, past steps become non-clickable. Used once a migration job has
   * been kicked off so the user can't accidentally rewind through Connect/Scan/Map
   * (which would invalidate the in-flight job's state).
   */
  lockPast?: boolean;
}

export function StepProgress({ steps, current, onSelect, visited = [], lockPast = false }: Props) {
  const currentIndex = steps.indexOf(current);
  return (
    <div className="flex items-center gap-2 overflow-x-auto py-1">
      {steps.map((s, i) => {
        const isActive = s === current;
        const isPast = i < currentIndex || visited.includes(s);
        const clickable = isActive || (isPast && !lockPast);
        const lockedHere = isPast && lockPast;
        return (
          <div key={s} className="flex items-center gap-2">
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onSelect(s)}
              title={
                lockedHere
                  ? "Locked once migration starts. Use 'Start new migration' to change earlier steps."
                  : undefined
              }
              className={cx(
                "group flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition focus-ring",
                isActive
                  ? "bg-white border border-brand-200 shadow-soft text-brand-700 font-semibold"
                  : isPast
                    ? "text-ink-700 hover:bg-white border border-transparent hover:border-ink-200"
                    : "text-ink-400 cursor-not-allowed border border-transparent",
              )}
            >
              <span
                className={cx(
                  "h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold border",
                  isActive
                    ? "bg-brand-600 text-white border-brand-600"
                    : isPast
                      ? "bg-emerald-500 text-white border-emerald-500"
                      : "bg-ink-100 text-ink-500 border-ink-200",
                )}
              >
                {isPast && !isActive ? (
                  <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                    <path d="M16.7 5.3a1 1 0 010 1.4l-7 7a1 1 0 01-1.4 0l-3.5-3.5a1 1 0 011.4-1.4L9 11.6l6.3-6.3a1 1 0 011.4 0z" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <span className="whitespace-nowrap">{STEP_LABELS[s]}</span>
            </button>
            {i < steps.length - 1 && (
              <div
                className={cx(
                  "h-px w-6",
                  i < currentIndex ? "bg-emerald-300" : "bg-ink-200",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
