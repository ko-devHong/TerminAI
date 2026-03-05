import type { HUDMetrics } from "@/types";

export type MetricSource = "statusline" | "pty-regex" | "transcript" | "handleOutput" | "api";

const SOURCE_PRIORITY: Record<MetricSource, number> = {
  statusline: 100,
  transcript: 80,
  api: 60,
  "pty-regex": 40,
  handleOutput: 20,
};

/**
 * Merge incoming partial metrics into existing HUD state, respecting source priority.
 * Higher-priority sources win over lower-priority ones for overlapping fields.
 * Exception: rateLimitCountdown, detailedStatus, activeTools are always accepted
 * (statusline doesn't carry them; they come from dedicated event streams).
 */
export function mergeIntoHudMetrics(
  existing: HUDMetrics,
  partial: Partial<HUDMetrics>,
  source: MetricSource,
  existingSource?: MetricSource | null,
): HUDMetrics {
  const incomingPriority = SOURCE_PRIORITY[source] ?? 0;
  const existingPriority = existingSource ? (SOURCE_PRIORITY[existingSource] ?? 0) : 0;

  const merged = { ...existing } as unknown as Record<string, unknown>;
  const existingRecord = existing as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(partial)) {
    if (value === null || value === undefined) continue;

    const existingValue = existingRecord[key];

    // Always accept these regardless of priority
    if (key === "rateLimitCountdown" || key === "detailedStatus" || key === "activeTools") {
      merged[key] = value;
      continue;
    }

    // Apply if higher priority or existing field is empty
    if (
      incomingPriority >= existingPriority ||
      existingValue === null ||
      existingValue === undefined ||
      existingValue === ""
    ) {
      // Special case for rateLimit: preserve fields if partial is incomplete
      if (key === "rateLimit" && value && typeof value === "object") {
        const existingRate = existingValue as Record<string, unknown> | null;
        merged[key] = {
          ...(existingRate || {}),
          ...(value as Record<string, unknown>),
        };
      } else {
        merged[key] = value;
      }
    }
  }

  merged._lastSource = source;

  return merged as unknown as HUDMetrics;
}
