import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}

/**
 * Hover/focus tooltip rendered into a top-level portal so it can escape
 * overflow:hidden / overflow:auto containers like Card and Table wrappers.
 * Positioned with fixed coordinates anchored to the trigger element bounds.
 */
export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const tip = tooltipRef.current?.getBoundingClientRect();
    const tipW = tip?.width ?? 256;
    const tipH = tip?.height ?? 0;
    const gap = 8;
    let top = 0;
    let left = 0;
    switch (side) {
      case "top":
        top = trigger.top - tipH - gap;
        left = trigger.left + trigger.width / 2 - tipW / 2;
        break;
      case "bottom":
        top = trigger.bottom + gap;
        left = trigger.left + trigger.width / 2 - tipW / 2;
        break;
      case "left":
        top = trigger.top + trigger.height / 2 - tipH / 2;
        left = trigger.left - tipW - gap;
        break;
      case "right":
        top = trigger.top + trigger.height / 2 - tipH / 2;
        left = trigger.right + gap;
        break;
    }
    const margin = 8;
    left = Math.max(margin, Math.min(left, window.innerWidth - tipW - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - tipH - margin));
    setCoords({ top, left });
  }, [open, side, content]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => setOpen(false);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  return (
    <span
      ref={triggerRef}
      className={cx("relative inline-flex items-center", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span
        aria-describedby={open ? id : undefined}
        tabIndex={0}
        className="inline-flex outline-none focus-visible:ring-2 focus-visible:ring-brand-400 rounded"
      >
        {children}
      </span>
      {open &&
        createPortal(
          <span
            ref={tooltipRef}
            id={id}
            role="tooltip"
            style={{
              position: "fixed",
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              visibility: coords ? "visible" : "hidden",
            }}
            className={cx(
              "z-[1000] w-64 max-w-[18rem] rounded-md bg-ink-900 px-3 py-2 text-xs text-white shadow-lg pointer-events-none",
              "leading-snug whitespace-normal",
            )}
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}

export function InfoIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={cx("w-4 h-4 text-ink-400 hover:text-brand-600", className)}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-12.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM9 9a.75.75 0 0 0 0 1.5h.25a.25.25 0 0 1 .25.25v3a.75.75 0 0 0 1.5 0v-3A1.75 1.75 0 0 0 9.25 9H9Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
