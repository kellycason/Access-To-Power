import type { SelectHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

interface Props extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  containerClassName?: string;
}

export function Select({
  label,
  hint,
  error,
  className,
  containerClassName,
  children,
  id,
  ...rest
}: Props) {
  const inputId = id || (label ? `sel-${Math.random().toString(36).slice(2, 8)}` : undefined);
  return (
    <div className={cx("flex flex-col gap-1", containerClassName)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-ink-700">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          id={inputId}
          {...rest}
          className={cx(
            "w-full h-10 appearance-none rounded-xl border border-ink-200 bg-white pl-3 pr-9 text-sm text-ink-900 transition",
            "hover:border-ink-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-200 focus:outline-none",
            "disabled:bg-ink-50 disabled:text-ink-400 disabled:cursor-not-allowed",
            error && "border-rose-400 focus:border-rose-500 focus:ring-rose-200",
            className,
          )}
        >
          {children}
        </select>
        <span className="absolute inset-y-0 right-3 flex items-center text-ink-400 pointer-events-none">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
            <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
      {hint && !error && <div className="text-xs text-ink-500">{hint}</div>}
      {error && <div className="text-xs text-rose-600">{error}</div>}
    </div>
  );
}
