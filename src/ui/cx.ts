// Tiny classname helper, no extra deps.
export function cx(
  ...args: Array<unknown>
): string {
  const out: string[] = [];
  for (const a of args) {
    if (!a) continue;
    if (typeof a === "string") out.push(a);
    else if (typeof a === "object") {
      for (const k in a as Record<string, unknown>) {
        if ((a as Record<string, unknown>)[k]) out.push(k);
      }
    }
  }
  return out.join(" ");
}
