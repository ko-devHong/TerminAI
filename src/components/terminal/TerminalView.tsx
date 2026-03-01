import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import { hudMetricsAtom } from "@/atoms/hud";
import { terminalFontSizeAtom } from "@/atoms/settings";
import { tabAtom } from "@/atoms/spaces";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { extractScreenMetrics } from "@/lib/screen-metrics";
import { invokeTauri, isTauriRuntimeAvailable } from "@/lib/tauri";
import {
  getOrCreateTerminal,
  setTerminalCacheSessionId,
  terminalCacheMap,
  upgradeToIMEInput,
  writeToTerminalCache,
} from "@/lib/terminal-cache";
import type { AIProvider, HUDMetrics, MetricUpdate, ProcessStatus } from "@/types";

import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  tabId: string | null;
}

const GEMINI_SPINNER_LINE_PATTERN = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+.*\(esc to cancel,\s*\d+s\).*$/u;
const GEMINI_SHORTCUT_HINT_PATTERN = /^\s*\?\s*for shortcuts\s*$/iu;

function sanitizeTerminalOutput(payload: string, provider: AIProvider): string {
  if (provider !== "gemini-cli") {
    return payload;
  }

  const lines = payload.split("\n");
  const keptLines: string[] = [];

  for (const line of lines) {
    const normalized = line.trim();
    if (GEMINI_SPINNER_LINE_PATTERN.test(normalized)) {
      continue;
    }
    if (GEMINI_SHORTCUT_HINT_PATTERN.test(normalized)) {
      continue;
    }
    keptLines.push(line);
  }

  return keptLines.join("\n");
}

export function TerminalView({ tabId }: TerminalViewProps) {
  const tab = useAtomValue(tabAtom(tabId ?? "__none__"));
  const store = useStore();
  const fontSize = useAtomValue(terminalFontSizeAtom);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeTabIdRef = useRef<string | null>(null);

  const setTabSessionAndStatus = useCallback(
    (targetTabId: string, nextSessionId: string | null, nextStatus: ProcessStatus) => {
      const currentTab = store.get(tabAtom(targetTabId));
      if (!currentTab) {
        return;
      }

      store.set(tabAtom(targetTabId), {
        ...currentTab,
        sessionId: nextSessionId,
        processStatus: nextStatus,
        lastActivityAt: Date.now(),
      });
    },
    [store],
  );

  const handleInput = useCallback((data: string, inputTabId: string) => {
    const cached = terminalCacheMap.get(inputTabId);
    if (!cached?.sessionId) {
      return;
    }

    void invokeTauri<void>("write_to_session", {
      sessionId: cached.sessionId,
      data: data.normalize("NFC"),
    });
  }, []);

  // Attach/detach terminal to DOM on tab switch
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const prevTabId = activeTabIdRef.current;
    activeTabIdRef.current = tabId;

    // Detach previous terminal from DOM (keep instance alive)
    if (prevTabId && prevTabId !== tabId) {
      const prevCached = terminalCacheMap.get(prevTabId);
      if (prevCached) {
        const termElement = prevCached.terminal.element;
        if (termElement?.parentElement === container) {
          container.removeChild(termElement);
        }
      }
    }

    if (!tabId) {
      return;
    }

    const cached = getOrCreateTerminal(tabId, fontSize, handleInput);

    // Attach to DOM
    if (cached.terminal.element) {
      container.appendChild(cached.terminal.element);
      cached.fitAddon.fit();
    } else {
      cached.terminal.open(container);
      cached.fitAddon.fit();
      // Now that the terminal is open, upgrade to IME-aware input handling
      upgradeToIMEInput(tabId, handleInput);
    }

    function onResize() {
      cached.fitAddon.fit();
      if (cached.sessionId) {
        void invokeTauri<void>("resize_session", {
          sessionId: cached.sessionId,
          cols: cached.terminal.cols,
          rows: cached.terminal.rows,
        });
      }
    }

    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [tabId, fontSize, handleInput]);

  // Session management: spawn or attach session for current tab
  useEffect(() => {
    if (!tabId || !tab) {
      return;
    }

    const currentTabId = tabId;
    const cached = terminalCacheMap.get(currentTabId);
    if (!cached) {
      return;
    }

    const activeTab = tab;
    const existingSessionId = activeTab.sessionId;

    async function ensureSession(): Promise<void> {
      if (!cached) return;

      if (!isTauriRuntimeAvailable()) {
        if (!cached.sessionId) {
          cached.terminal.writeln(`[${activeTab.provider}] Tauri runtime unavailable in web mode.`);
          cached.terminal.writeln("Run `bun run tauri dev` to spawn real PTY sessions.");
        }
        return;
      }

      if (existingSessionId) {
        if (cached.sessionId === existingSessionId) {
          return;
        }
        cached.sessionId = existingSessionId;
        return;
      }

      if (cached.sessionId) {
        return;
      }

      // Only auto-spawn for fresh tabs; don't retry after disconnect/error
      if (activeTab.processStatus !== "idle") {
        return;
      }

      cached.terminal.writeln(`[${activeTab.provider}] spawning session...`);

      try {
        const spawnedSessionId = await invokeTauri<string>("spawn_session", {
          provider: activeTab.provider,
          cwd: activeTab.cwd,
        });

        cached.sessionId = spawnedSessionId;
        setTabSessionAndStatus(currentTabId, spawnedSessionId, "running");

        cached.fitAddon.fit();
        await invokeTauri<void>("resize_session", {
          sessionId: spawnedSessionId,
          cols: cached.terminal.cols,
          rows: cached.terminal.rows,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cached.terminal.writeln(`Failed to spawn session: ${message}`);
        cached.sessionId = null;
        setTabSessionAndStatus(currentTabId, null, "error");
      }
    }

    void ensureSession();
  }, [setTabSessionAndStatus, tab, tabId]);

  const sessionId = tab?.sessionId ?? null;

  const handleOutput = useCallback(
    (payload: string) => {
      if (!tabId) {
        return;
      }

      const currentTab = store.get(tabAtom(tabId));
      if (!currentTab) {
        return;
      }

      const sanitizedPayload = sanitizeTerminalOutput(payload, currentTab.provider);
      if (sanitizedPayload.length > 0) {
        writeToTerminalCache(tabId, sanitizedPayload);
      }

      store.set(tabAtom(tabId), {
        ...currentTab,
        processStatus: "running",
        lastActivityAt: Date.now(),
      });
    },
    [store, tabId],
  );

  const handleStatus = useCallback(
    (status: ProcessStatus) => {
      if (!sessionId || !tabId) {
        return;
      }

      if (status === "disconnected" || status === "error") {
        setTerminalCacheSessionId(tabId, null);
      }

      setTabSessionAndStatus(tabId, status === "disconnected" ? null : sessionId, status);
    },
    [sessionId, setTabSessionAndStatus, tabId],
  );

  const handleMetrics = useCallback(
    (update: MetricUpdate) => {
      if (!tabId || !sessionId) return;
      const currentTab = store.get(tabAtom(tabId));
      if (!currentTab) return;

      const existing = store.get(hudMetricsAtom(sessionId));
      const merged: HUDMetrics = {
        provider: currentTab.provider,
        model: update.model ?? existing?.model ?? null,
        contextWindow:
          update.contextUsed != null && update.contextTotal != null
            ? { used: update.contextUsed, total: update.contextTotal }
            : (existing?.contextWindow ?? null),
        tokens:
          update.tokensIn != null || update.tokensOut != null
            ? {
                input: update.tokensIn ?? existing?.tokens?.input ?? 0,
                output: update.tokensOut ?? existing?.tokens?.output ?? 0,
              }
            : (existing?.tokens ?? null),
        cost: update.cost ?? existing?.cost ?? null,
        rateLimit: existing?.rateLimit ?? null,
        billing: existing?.billing ?? null,
        plan: existing?.plan ?? null,
        hasCredentials: existing?.hasCredentials ?? false,
        activeTools: update.activeTools.length ? update.activeTools : (existing?.activeTools ?? []),
        sessionDuration: existing?.sessionDuration ?? 0,
        detailedStatus: (update.status as ProcessStatus) ?? existing?.detailedStatus ?? "idle",
        connectionStatus: "connected",
      };
      store.set(hudMetricsAtom(sessionId), merged);
    },
    [store, tabId, sessionId],
  );

  // Periodically scan xterm.js rendered buffer for metrics
  useEffect(() => {
    if (!tabId || !sessionId) {
      return;
    }

    function scanScreen() {
      if (!tabId || !sessionId) return;

      const cached = terminalCacheMap.get(tabId);
      const currentTab = store.get(tabAtom(tabId));
      if (!cached || !currentTab) return;

      const screenData = extractScreenMetrics(cached.terminal, currentTab.provider);

      const existing = store.get(hudMetricsAtom(sessionId));
      const merged: HUDMetrics = {
        provider: currentTab.provider,
        model: screenData.model ?? existing?.model ?? null,
        contextWindow:
          screenData.contextUsed != null && screenData.contextTotal != null
            ? { used: screenData.contextUsed, total: screenData.contextTotal }
            : (existing?.contextWindow ?? null),
        tokens:
          screenData.tokensIn != null || screenData.tokensOut != null
            ? {
                input: screenData.tokensIn ?? existing?.tokens?.input ?? 0,
                output: screenData.tokensOut ?? existing?.tokens?.output ?? 0,
              }
            : (existing?.tokens ?? null),
        cost: screenData.cost ?? existing?.cost ?? null,
        rateLimit: existing?.rateLimit ?? null,
        billing: existing?.billing ?? null,
        plan: existing?.plan ?? null,
        hasCredentials: existing?.hasCredentials ?? false,
        activeTools: screenData.activeTools.length
          ? screenData.activeTools
          : (existing?.activeTools ?? []),
        sessionDuration: existing?.sessionDuration ?? 0,
        detailedStatus: screenData.detectedStatus ?? existing?.detailedStatus ?? "idle",
        connectionStatus: "connected",
      };

      store.set(hudMetricsAtom(sessionId), merged);
    }

    // Scan immediately, then every 3 seconds
    scanScreen();
    const interval = window.setInterval(scanScreen, 3_000);
    return () => window.clearInterval(interval);
  }, [tabId, sessionId, store]);

  useTauriEvent<string>(sessionId ? `pty-output-${sessionId}` : null, handleOutput);
  useTauriEvent<ProcessStatus>(sessionId ? `session-status-${sessionId}` : null, handleStatus);
  useTauriEvent<MetricUpdate>(sessionId ? `metrics-${sessionId}` : null, handleMetrics);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ background: "var(--color-background)" }}
    />
  );
}
