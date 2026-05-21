import type { InputHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  containerClassName?: string;
}

export function Input({
  label,
  hint,
  error,
  iconLeft,
  iconRight,
  className,
  containerClassName,
  id,
  ...rest
}: Props) {
  const inputId = id || (label ? `inp-${Math.random().toString(36).slice(2, 8)}` : undefined);
  return (
    <div className={cx("flex flex-col gap-1", containerClassName)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-ink-700">
          {label}
        </label>
      )}
      <div className="relative">
        {iconLeft && (
          <span className="absolute inset-y-0 left-3 flex items-center text-ink-400 pointer-events-none">
            {iconLeft}
          </span>
        )}
        <input
          id={inputId}
          {...rest}
          className={cx(
            "w-full h-10 rounded-xl border border-ink-200 bg-white px-3 text-sm text-ink-900 placeholder:text-ink-400 transition",
            "hover:border-ink-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-200 focus:outline-none",
            "disabled:bg-ink-50 disabled:text-ink-400 disabled:cursor-not-allowed",
            iconLeft && "pl-10",
            iconRight && "pr-10",
            error && "border-rose-400 focus:border-rose-500 focus:ring-rose-200",
            className,
          )}
        />
        {iconRight && (
          <span className="absolute inset-y-0 right-3 flex items-center text-ink-400 pointer-events-none">
            {iconRight}
          </span>
        )}
      </div>
      {hint && !error && <div className="text-xs text-ink-500">{hint}</div>}
      {error && <div className="text-xs text-rose-600">{error}</div>}
    </div>
  );
}
