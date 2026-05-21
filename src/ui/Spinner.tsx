import { cx } from "./cx";

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cx(
        "inline-block rounded-full border-2 border-current border-t-transparent animate-spin",
        className,
      )}
      style={{ width: size, height: size }}
    />
  );
}
