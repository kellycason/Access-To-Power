import type { ReactNode } from "react";
import { cx } from "../ui/cx";

export type AppRoute =
  | { name: "wizard" }
  | { name: "history" }
  | { name: "history-detail"; jobId: string };

interface NavItem {
  key: string;
  label: string;
  icon: ReactNode;
  isActive: (r: AppRoute) => boolean;
  onClick: () => void;
  badge?: string | number;
}

interface Props {
  route: AppRoute;
  onNavigate: (r: AppRoute) => void;
}

const ICON_MIGRATE = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M4 7h11l-3-3m3 3l-3 3M20 17H9l3 3m-3-3l3-3"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ICON_HISTORY = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function Sidebar({ route, onNavigate }: Props) {
  const items: NavItem[] = [
    {
      key: "migrate",
      label: "New migration",
      icon: ICON_MIGRATE,
      isActive: (r) => r.name === "wizard",
      onClick: () => onNavigate({ name: "wizard" }),
    },
    {
      key: "history",
      label: "History",
      icon: ICON_HISTORY,
      isActive: (r) => r.name === "history" || r.name === "history-detail",
      onClick: () => onNavigate({ name: "history" }),
    },
  ];

  return (
    <aside className="w-64 shrink-0 bg-white border-r border-ink-200 flex flex-col">
      <div className="px-5 pt-6 pb-4">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center text-white shadow-soft">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M4 7l8-4 8 4-8 4-8-4z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <path
                d="M4 12l8 4 8-4M4 17l8 4 8-4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-ink-900">Access to Power</div>
            <div className="text-xs text-ink-500">Migration studio</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-2 space-y-1">
        {items.map((item) => {
          const active = item.isActive(route);
          return (
            <button
              key={item.key}
              onClick={item.onClick}
              className={cx(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition focus-ring",
                active
                  ? "bg-brand-50 text-brand-700"
                  : "text-ink-600 hover:bg-ink-50 hover:text-ink-900",
              )}
            >
              <span
                className={cx(
                  "transition-colors",
                  active ? "text-brand-600" : "text-ink-400",
                )}
              >
                {item.icon}
              </span>
              <span className="flex-1 text-left">{item.label}</span>
              {item.badge && (
                <span className="text-xs bg-ink-100 text-ink-600 rounded-full px-2 py-0.5">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="px-5 py-4 border-t border-ink-100">
        <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-1">Tenant</div>
        <div className="text-xs text-ink-600 break-all">Power Platform</div>
      </div>
    </aside>
  );
}
