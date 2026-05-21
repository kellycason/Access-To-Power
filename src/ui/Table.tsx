import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export function Table({ className, children, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-auto rounded-xl border border-ink-200">
      <table {...(rest as object)} className={cx("w-full text-sm", className)}>
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="bg-ink-50 text-xs uppercase tracking-wide text-ink-500">{children}</thead>;
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-ink-100">{children}</tbody>;
}

export function TR({
  children,
  className,
  onClick,
  hoverable,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  hoverable?: boolean;
}) {
  return (
    <tr
      onClick={onClick}
      className={cx(
        hoverable && "cursor-pointer hover:bg-ink-50",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function TH({ children, className, align }: { children: ReactNode; className?: string; align?: "left" | "right" | "center" }) {
  return (
    <th
      className={cx(
        "px-4 py-3 font-semibold",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TD({ children, className, align, colSpan }: { children: ReactNode; className?: string; align?: "left" | "right" | "center"; colSpan?: number }) {
  return (
    <td
      colSpan={colSpan}
      className={cx(
        "px-4 py-3 text-ink-700",
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}
