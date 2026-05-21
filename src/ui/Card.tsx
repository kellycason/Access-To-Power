import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

interface Props extends HTMLAttributes<HTMLDivElement> {
  padding?: "none" | "sm" | "md" | "lg";
  hoverable?: boolean;
  children?: ReactNode;
}

const PAD = {
  none: "",
  sm: "p-3",
  md: "p-5",
  lg: "p-6",
};

export function Card({ padding = "md", hoverable, className, children, ...rest }: Props) {
  return (
    <div
      {...rest}
      className={cx(
        "bg-white border border-ink-200 rounded-2xl shadow-soft",
        PAD[padding],
        hoverable && "transition hover:shadow-card hover:border-ink-300 cursor-pointer",
        className,
      )}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function CardHeader({ title, description, actions, className, ...rest }: CardHeaderProps) {
  return (
    <div
      {...rest}
      className={cx("flex items-start justify-between gap-4 mb-4", className)}
    >
      <div className="min-w-0">
        <div className="text-base font-semibold text-ink-900">{title}</div>
        {description && (
          <div className="text-sm text-ink-500 mt-0.5">{description}</div>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
