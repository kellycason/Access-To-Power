import type { ReactNode } from "react";
import { cx } from "./cx";

type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

interface Props {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
}

const TONES: Record<Tone, string> = {
  neutral: "bg-ink-100 text-ink-700",
  brand: "bg-brand-100 text-brand-700",
  success: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  danger: "bg-rose-100 text-rose-700",
  info: "bg-sky-100 text-sky-700",
};

export function Badge({ tone = "neutral", children, className, icon }: Props) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
