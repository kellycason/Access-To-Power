import type { InputHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  label?: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, className, id, ...rest }: Props) {
  const inputId = id || `cb-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <label htmlFor={inputId} className={cx("flex items-start gap-2.5 cursor-pointer select-none", className)}>
      <input
        type="checkbox"
        id={inputId}
        {...rest}
        className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
      />
      <div className="flex flex-col gap-0.5 leading-tight">
        {label && <span className="text-sm text-ink-800">{label}</span>}
        {description && <span className="text-xs text-ink-500">{description}</span>}
      </div>
    </label>
  );
}
