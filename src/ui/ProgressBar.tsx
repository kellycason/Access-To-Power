import { cx } from "./cx";

interface Props {
  value: number; // 0-100
  className?: string;
  intent?: "brand" | "success" | "warning" | "danger";
  size?: "sm" | "md";
}

const INTENTS = {
  brand: "bg-brand-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
};

export function ProgressBar({ value, className, intent = "brand", size = "md" }: Props) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      className={cx(
        "w-full overflow-hidden rounded-full bg-ink-100",
        size === "sm" ? "h-1.5" : "h-2",
        className,
      )}
    >
      <div
        className={cx("h-full transition-[width] duration-300", INTENTS[intent])}
        style={{ width: `${v}%` }}
      />
    </div>
  );
}
