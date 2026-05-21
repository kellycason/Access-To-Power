import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { cx } from "./cx";

interface Props {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  footer?: ReactNode;
  hideCloseButton?: boolean;
  closeOnBackdrop?: boolean;
}

const SIZES = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = "md",
  footer,
  hideCloseButton,
  closeOnBackdrop = true,
}: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div
        className="absolute inset-0 bg-ink-900/40 backdrop-blur-sm"
        onClick={() => closeOnBackdrop && onClose()}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          "relative w-full bg-white rounded-2xl shadow-pop animate-scale-in flex flex-col max-h-[90vh] overflow-hidden",
          SIZES[size],
        )}
      >
        {(title || !hideCloseButton) && (
          <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-2">
            <div className="min-w-0">
              {title && <div className="text-lg font-semibold text-ink-900">{title}</div>}
              {description && <div className="text-sm text-ink-500 mt-1">{description}</div>}
            </div>
            {!hideCloseButton && (
              <button
                onClick={onClose}
                className="-mt-1 -mr-1 p-1.5 rounded-lg text-ink-500 hover:bg-ink-100 transition"
                aria-label="Close"
              >
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
                  <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-6 py-4 text-sm text-ink-700">{children}</div>
        {footer && (
          <div className="px-6 py-4 bg-ink-50 border-t border-ink-200 flex items-center justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  intent?: "default" | "danger";
  loading?: boolean;
  children?: ReactNode;
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Continue",
  cancelLabel = "Cancel",
  intent = "default",
  loading,
  children,
}: ConfirmProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={intent === "danger" ? "danger" : "primary"}
            onClick={() => void onConfirm()}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
