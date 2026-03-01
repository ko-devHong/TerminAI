import { atom } from "jotai";
import { atomFamily, atomWithStorage } from "jotai/utils";

import { focusedTabAtom } from "@/atoms/spaces";
import type { HUDMetrics } from "@/types";

export const hudExpandModeAtom = atomWithStorage<"compact" | "expanded" | "hidden">(
  "terminai:hud-mode",
  "compact",
);

export const hudMetricsAtom = atomFamily((_sessionId: string) => atom<HUDMetrics | null>(null));

export const activeHudMetricsAtom = atom((get): HUDMetrics | null => {
  const focusedTab = get(focusedTabAtom);
  if (!focusedTab) {
    return null;
  }

  // If we have real metrics from the backend, use them
  if (focusedTab.sessionId) {
    const realMetrics = get(hudMetricsAtom(focusedTab.sessionId));
    if (realMetrics) {
      return realMetrics;
    }
  }

  // Fallback: basic info derived from tab state (no dummy data)
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
    rateLimit: null,
    activeTools: [],
    sessionDuration: 0,
    connectionStatus:
      focusedTab.processStatus === "disconnected" || focusedTab.processStatus === "error"
        ? "disconnected"
        : focusedTab.processStatus === "running" || focusedTab.processStatus === "processing"
          ? "connected"
          : "disconnected",
  };
});
