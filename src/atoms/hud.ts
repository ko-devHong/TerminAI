import { atom } from "jotai";
import { atomFamily, atomWithStorage } from "jotai/utils";

import { focusedTabAtom } from "@/atoms/spaces";
import { type HUDMetrics } from "@/types";

export const hudExpandModeAtom = atomWithStorage<"compact" | "expanded" | "hidden">(
  "terminai:hud-mode",
  "compact",
);

export const hudMetricsAtom = atomFamily((_sessionId: string) =>
  atom<HUDMetrics | null>(null),
);

export const activeHudMetricsAtom = atom((get): HUDMetrics | null => {
  const focusedTab = get(focusedTabAtom);
  if (!focusedTab) {
    return null;
  }

  return {
    provider: focusedTab.provider,
    model:
      focusedTab.provider === "claude-code"
        ? "opus-4"
        : focusedTab.provider === "codex-cli"
          ? "gpt-5"
          : focusedTab.provider === "gemini-cli"
            ? "gemini-2.0-pro"
            : "custom",
    contextWindow: { used: 78, total: 100 },
    tokens: { input: 12300, output: 8100 },
    cost: 1.23,
    rateLimit: { remaining: 45, total: 60 },
    activeTools: focusedTab.provider === "gemini-cli" ? ["Chat"] : ["Read", "Edit", "Grep"],
    sessionDuration: 83 * 60,
    connectionStatus:
      focusedTab.processStatus === "disconnected" || focusedTab.processStatus === "error"
        ? "disconnected"
        : "connected",
  };
});
