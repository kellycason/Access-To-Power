import type { ReactNode } from "react";
import { cx } from "./cx";

type Intent = "info" | "success" | "warning" | "error";

interface Props {
  intent?: Intent;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  onDismiss?: () => void;
}

const INTENTS: Record<Intent, { wrap: string; icon: ReactNode }> = {
  info: {
    wrap: "bg-sky-50 border-sky-200 text-sky-900",
    icon: (
      <svg className="h-5 w-5 text-sky-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
        <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 110 2 1 1 0 010-2zm1 9H9v-5h2v5z" />
      </svg>
    ),
  },
  success: {
    wrap: "bg-emerald-50 border-emerald-200 text-emerald-900",
    icon: (
      <svg className="h-5 w-5 text-emerald-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
        <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm-1-5l5-5-1.4-1.4L9 10.2 7.4 8.6 6 10l3 3z" />
      </svg>
    ),
  },
  warning: {
    wrap: "bg-amber-50 border-amber-200 text-amber-900",
    icon: (
      <svg className="h-5 w-5 text-amber-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
        <path d="M10 2L1 18h18L10 2zm0 5l5 9H5l5-9zm-1 3v3h2v-3H9zm0 4v2h2v-2H9z" />
      </svg>
    ),
  },
  error: {
    wrap: "bg-rose-50 border-rose-200 text-rose-900",
    icon: (
      <svg className="h-5 w-5 text-rose-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
        <path d="M10 2a8 8 0 100 16 8 8 0 000-16zM7.05 6.05L10 9l2.95-2.95 1.4 1.4L11.4 10.4l2.95 2.95-1.4 1.4L10 11.8l-2.95 2.95-1.4-1.4L8.6 10.4 5.65 7.45z" />
      </svg>
    ),
  },
};

export function Alert({ intent = "info", title, children, actions, className, onDismiss }: Props) {
  const cfg = INTENTS[intent];
  return (
    <div className={cx("flex items-start gap-3 rounded-xl border px-4 py-3", cfg.wrap, className)}>
      <div className="shrink-0 mt-0.5">{cfg.icon}</div>
      <div className="flex-1 min-w-0 text-sm">
        {title && <div className="font-semibold mb-0.5">{title}</div>}
        {children && <div className="opacity-90">{children}</div>}
      </div>
      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="shrink-0 -mr-1 -mt-1 p-1 rounded-md hover:bg-black/5 transition"
          aria-label="Dismiss"
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
            <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
