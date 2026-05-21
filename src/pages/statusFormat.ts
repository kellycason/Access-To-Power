/** Job status code → label / tone, used across History pages. */
export const JOB_STATUS_LABELS: Record<number, string> = {
  1: "Draft",
  2: "Connected",
  3: "Scanned",
  4: "Mapped",
  5: "Creating schema",
  6: "Loading data",
  7: "Resolving lookups",
  8: "Validating",
  9: "Succeeded",
  10: "Partially succeeded",
  11: "Failed",
  12: "Schema ready",
};

export type JobStatusTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

export function statusTone(status: number): JobStatusTone {
  switch (status) {
    case 9:
      return "success";
    case 10:
      return "warning";
    case 11:
      return "danger";
    case 12:
      return "info";
    case 5:
    case 6:
    case 7:
    case 8:
      return "brand";
    default:
      return "neutral";
  }
}

export function statusLabel(status: number): string {
  return JOB_STATUS_LABELS[status] ?? `Status ${status}`;
}

export function formatDate(iso?: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function relativeTime(iso?: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso).getTime();
    const diffMs = Date.now() - d;
    const sec = Math.round(diffMs / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    const mo = Math.round(day / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.round(mo / 12)}y ago`;
  } catch {
    return formatDate(iso);
  }
}
