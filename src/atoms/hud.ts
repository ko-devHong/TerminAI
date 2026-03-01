import { atom } from "jotai";
import { atomFamily, atomWithStorage } from "jotai/utils";

import { focusedTabAtom } from "@/atoms/spaces";
import type { AIProvider, HUDMetrics, ProcessStatus, ProviderUsage } from "@/types";

export const hudExpandModeAtom = atomWithStorage<"compact" | "expanded" | "hidden">(
  "terminai:hud-mode",
  "compact",
);

export const hudMetricsAtom = atomFamily((_sessionId: string) => atom<HUDMetrics | null>(null));

// Per-provider API usage cache (populated by useUsagePolling hook)
export const providerUsageAtom = atomFamily((_provider: AIProvider) =>
  atom<ProviderUsage | null>(null),
);

export const activeHudMetricsAtom = atom((get): HUDMetrics | null => {
  const focusedTab = get(focusedTabAtom);
  if (!focusedTab) {
    return null;
  }

  const providerUsage = get(providerUsageAtom(focusedTab.provider));

  // If we have real metrics from the backend, merge with API usage data
  if (focusedTab.sessionId) {
    const realMetrics = get(hudMetricsAtom(focusedTab.sessionId));
    if (realMetrics) {
      return {
        ...realMetrics,
        rateLimit: realMetrics.rateLimit ?? providerUsage?.rateLimit ?? null,
        billing: realMetrics.billing ?? providerUsage?.billing ?? null,
        plan: realMetrics.plan ?? providerUsage?.plan ?? null,
        hasCredentials: realMetrics.hasCredentials || (providerUsage?.hasCredentials ?? false),
      };
    }
  }

  // Fallback: basic info derived from tab state
  const status: ProcessStatus = (focusedTab.processStatus as ProcessStatus) ?? "idle";

  return {
    provider: focusedTab.provider,
    model:
      focusedTab.provider === "claude-code"
        ? "opus-4"
        : focusedTab.provider === "codex-cli"
          ? "gpt-4o"
          : focusedTab.provider === "gemini-cli"
            ? "gemini-2.0-pro"
            : null,
    contextWindow: null,
    tokens: null,
    cost: null,
    rateLimit: providerUsage?.rateLimit ?? null,
    billing: providerUsage?.billing ?? null,
    plan: providerUsage?.plan ?? null,
    hasCredentials: providerUsage?.hasCredentials ?? false,
    activeTools: [],
    sessionDuration: 0,
    detailedStatus: status,
    connectionStatus:
      status === "disconnected" || status === "error"
        ? "disconnected"
        : status === "running" || status === "thinking"
          ? "connected"
          : "disconnected",
    rateLimitCountdown: null,
    rateLimitDetectedAt: null,
  };
});
