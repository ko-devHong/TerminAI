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
import type {
  AIProvider,
  CliQuotaSnapshot,
  HUDMetrics,
  MetricUpdate,
  ProcessStatus,
} from "@/types";

import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  tabId: string | null;
}

const GEMINI_SPINNER_LINE_PATTERN = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+.*\(esc to cancel,\s*\d+s\).*$/u;
const GEMINI_SHORTCUT_HINT_PATTERN = /^\s*\?\s*for shortcuts\s*$/iu;
const CODEX_FIVE_HOUR_LEFT_RE =
  /5h\s+limit:\s*\[[^\]]*\]\s*(\d+)%\s*left(?:\s*\(resets\s+([^)]+)\))?/i;
const CODEX_WEEKLY_LEFT_RE =
  /Weekly\s+limit:\s*\[[^\]]*\]\s*(\d+)%\s*left(?:\s*\(resets\s+([^)]+)\))?/i;
const GEMINI_USAGE_ROW_RE =
  /^\s*(gemini-[\w.-]+)\s+\S+\s+(\d+(?:\.\d+)?)%\s+resets\s+in\s+([0-9hms ]+)\s*$/gim;

function parseCodexResetLabelToSeconds(label: string): number | null {
  const match = /(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]{3})/i.exec(label.trim());
  if (!match) return null;

  const monthMap: Record<string, number> = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const month = monthMap[match[4].toLowerCase()];
  if (Number.isNaN(hour) || Number.isNaN(minute) || Number.isNaN(day) || month == null) {
    return null;
  }

  const now = new Date();
  const target = new Date(now.getFullYear(), month, day, hour, minute, 0, 0);
  if (target.getTime() < now.getTime()) {
    target.setFullYear(target.getFullYear() + 1);
  }
  return Math.max(0, Math.floor((target.getTime() - now.getTime()) / 1000));
}

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

    // Keep keyboard focus in terminal so Enter/typing goes to PTY, not sidebar controls.
    window.requestAnimationFrame(() => {
      cached.terminal.focus();
    });

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

        window.requestAnimationFrame(() => {
          cached.terminal.focus();
        });

        // Setup Claude Code statusline JSON file if applicable
        if (activeTab.provider === "claude-code") {
          invokeTauri("setup_claude_statusline").catch(() => {});
        }
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

  useEffect(() => {
    if (
      !tabId ||
      !sessionId ||
      !tab ||
      tab.provider !== "codex-cli" ||
      !isTauriRuntimeAvailable()
    ) {
      return;
    }

    let mounted = true;
    let intervalId: number | undefined;
    let running = false;

    const pollCliQuota = async () => {
      if (!mounted || running) {
        return;
      }
      running = true;
      try {
        const snapshot = await invokeTauri<CliQuotaSnapshot | null>("fetch_cli_quota", {
          provider: tab.provider,
          cwd: tab.cwd,
        });

        if (!mounted || !snapshot) {
          return;
        }

        const currentTab = store.get(tabAtom(tabId));
        if (!currentTab?.sessionId || currentTab.sessionId !== sessionId) {
          return;
        }

        const existing = store.get(hudMetricsAtom(sessionId));
        store.set(hudMetricsAtom(sessionId), {
          provider: currentTab.provider,
          model: snapshot.model ?? existing?.model ?? null,
          contextWindow: existing?.contextWindow ?? null,
          tokens: existing?.tokens ?? null,
          cost: snapshot.costUsd ?? existing?.cost ?? null,
          rateLimit:
            snapshot.fiveHourLeftPercent != null || snapshot.sevenDayLeftPercent != null
              ? {
                  fiveHourPercent:
                    snapshot.fiveHourLeftPercent != null
                      ? 100 - Math.max(0, Math.min(100, snapshot.fiveHourLeftPercent))
                      : (existing?.rateLimit?.fiveHourPercent ?? 0),
                  sevenDayPercent:
                    snapshot.sevenDayLeftPercent != null
                      ? 100 - Math.max(0, Math.min(100, snapshot.sevenDayLeftPercent))
                      : (existing?.rateLimit?.sevenDayPercent ?? 0),
                  fiveHourResetSeconds: existing?.rateLimit?.fiveHourResetSeconds ?? 0,
                  sevenDayResetSeconds: existing?.rateLimit?.sevenDayResetSeconds ?? 0,
                }
              : (existing?.rateLimit ?? null),
          billing: existing?.billing ?? null,
          plan: existing?.plan ?? null,
          hasCredentials: existing?.hasCredentials ?? false,
          activeTools: existing?.activeTools ?? [],
          sessionDuration: Math.max(0, Math.floor((Date.now() - currentTab.createdAt) / 1000)),
          detailedStatus: existing?.detailedStatus ?? currentTab.processStatus,
          connectionStatus: existing?.connectionStatus ?? "connected",
          rateLimitCountdown: existing?.rateLimitCountdown ?? null,
          rateLimitDetectedAt: existing?.rateLimitDetectedAt ?? null,
          rateLimitFiveHourResetLabel:
            snapshot.fiveHourResetLabel ?? existing?.rateLimitFiveHourResetLabel ?? null,
          rateLimitSevenDayResetLabel:
            snapshot.sevenDayResetLabel ?? existing?.rateLimitSevenDayResetLabel ?? null,
        });
      } catch {
        // Best-effort hidden poll; keep existing HUD data on failure.
      } finally {
        running = false;
      }
    };

    void pollCliQuota();
    intervalId = window.setInterval(() => {
      void pollCliQuota();
    }, 120_000);

    return () => {
      mounted = false;
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    };
  }, [tabId, sessionId, tab, store]);

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

      if (currentTab.provider === "codex-cli" && currentTab.sessionId) {
        const five = CODEX_FIVE_HOUR_LEFT_RE.exec(sanitizedPayload);
        const seven = CODEX_WEEKLY_LEFT_RE.exec(sanitizedPayload);
        if (five || seven) {
          const existing = store.get(hudMetricsAtom(currentTab.sessionId));
          const fiveLeft = five ? Number.parseInt(five[1], 10) : Number.NaN;
          const sevenLeft = seven ? Number.parseInt(seven[1], 10) : Number.NaN;
          const fiveResetLabel = five?.[2]?.trim() ?? existing?.rateLimitFiveHourResetLabel ?? null;
          const sevenResetLabel =
            seven?.[2]?.trim() ?? existing?.rateLimitSevenDayResetLabel ?? null;

          store.set(hudMetricsAtom(currentTab.sessionId), {
            provider: currentTab.provider,
            model: existing?.model ?? null,
            contextWindow: existing?.contextWindow ?? null,
            tokens: existing?.tokens ?? null,
            cost: existing?.cost ?? null,
            rateLimit: {
              fiveHourPercent: Number.isNaN(fiveLeft)
                ? (existing?.rateLimit?.fiveHourPercent ?? 0)
                : 100 - Math.max(0, Math.min(100, fiveLeft)),
              sevenDayPercent: Number.isNaN(sevenLeft)
                ? (existing?.rateLimit?.sevenDayPercent ?? 0)
                : 100 - Math.max(0, Math.min(100, sevenLeft)),
              fiveHourResetSeconds:
                fiveResetLabel != null
                  ? (parseCodexResetLabelToSeconds(fiveResetLabel) ??
                    existing?.rateLimit?.fiveHourResetSeconds ??
                    0)
                  : (existing?.rateLimit?.fiveHourResetSeconds ?? 0),
              sevenDayResetSeconds:
                sevenResetLabel != null
                  ? (parseCodexResetLabelToSeconds(sevenResetLabel) ??
                    existing?.rateLimit?.sevenDayResetSeconds ??
                    0)
                  : (existing?.rateLimit?.sevenDayResetSeconds ?? 0),
            },
            billing: existing?.billing ?? null,
            plan: existing?.plan ?? null,
            hasCredentials: existing?.hasCredentials ?? false,
            activeTools: existing?.activeTools ?? [],
            sessionDuration: Math.max(0, Math.floor((Date.now() - currentTab.createdAt) / 1000)),
            detailedStatus: existing?.detailedStatus ?? currentTab.processStatus,
            connectionStatus: existing?.connectionStatus ?? "connected",
            rateLimitCountdown: existing?.rateLimitCountdown ?? null,
            rateLimitDetectedAt: existing?.rateLimitDetectedAt ?? null,
            rateLimitFiveHourResetLabel: fiveResetLabel,
            rateLimitSevenDayResetLabel: sevenResetLabel,
          });
        }
      }

      if (currentTab.provider === "gemini-cli" && currentTab.sessionId) {
        const rows = Array.from(sanitizedPayload.matchAll(GEMINI_USAGE_ROW_RE));
        if (rows.length > 0) {
          const existing = store.get(hudMetricsAtom(currentTab.sessionId));
          let shortLeft: number | null = null;
          let shortResetLabel: string | null = null;
          let longLeft: number | null = null;
          let longResetLabel: string | null = null;

          for (const row of rows) {
            const remaining = Number.parseFloat(row[2]);
            const resetLabel = row[3].trim();
            if (Number.isNaN(remaining)) {
              continue;
            }

            const duration = /(?:(\d+)h)?\s*(?:(\d+)m)?/i.exec(resetLabel);
            const hours = Number.parseInt(duration?.[1] ?? "0", 10);
            const minutes = Number.parseInt(duration?.[2] ?? "0", 10);
            const totalHours = hours + minutes / 60;
            const isShortWindow = totalHours > 0 && totalHours <= 8;

            if (isShortWindow) {
              if (shortLeft == null || remaining < shortLeft) {
                shortLeft = remaining;
                shortResetLabel = `in ${resetLabel}`;
              }
            } else if (longLeft == null || remaining < longLeft) {
              longLeft = remaining;
              longResetLabel = `in ${resetLabel}`;
            }
          }

          store.set(hudMetricsAtom(currentTab.sessionId), {
            provider: currentTab.provider,
            model: existing?.model ?? null,
            contextWindow: existing?.contextWindow ?? null,
            tokens: existing?.tokens ?? null,
            cost: existing?.cost ?? null,
            rateLimit: {
              fiveHourPercent:
                shortLeft == null
                  ? (existing?.rateLimit?.fiveHourPercent ?? 0)
                  : 100 - Math.max(0, Math.min(100, shortLeft)),
              sevenDayPercent:
                longLeft == null
                  ? (existing?.rateLimit?.sevenDayPercent ?? 0)
                  : 100 - Math.max(0, Math.min(100, longLeft)),
              fiveHourResetSeconds: existing?.rateLimit?.fiveHourResetSeconds ?? 0,
              sevenDayResetSeconds: existing?.rateLimit?.sevenDayResetSeconds ?? 0,
            },
            billing: existing?.billing ?? null,
            plan: existing?.plan ?? null,
            hasCredentials: existing?.hasCredentials ?? false,
            activeTools: existing?.activeTools ?? [],
            sessionDuration: Math.max(0, Math.floor((Date.now() - currentTab.createdAt) / 1000)),
            detailedStatus: existing?.detailedStatus ?? currentTab.processStatus,
            connectionStatus: existing?.connectionStatus ?? "connected",
            rateLimitCountdown: existing?.rateLimitCountdown ?? null,
            rateLimitDetectedAt: existing?.rateLimitDetectedAt ?? null,
            rateLimitFiveHourResetLabel:
              shortResetLabel ?? existing?.rateLimitFiveHourResetLabel ?? null,
            rateLimitSevenDayResetLabel:
              longResetLabel ?? existing?.rateLimitSevenDayResetLabel ?? null,
          });
        }
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
      const resolvedStatus =
        (update.status as ProcessStatus | null) ??
        existing?.detailedStatus ??
        currentTab.processStatus ??
        "idle";
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
        sessionDuration: Math.max(0, Math.floor((Date.now() - currentTab.createdAt) / 1000)),
        detailedStatus: resolvedStatus,
        connectionStatus:
          resolvedStatus === "error" || resolvedStatus === "disconnected"
            ? "error"
            : resolvedStatus === "idle"
              ? "disconnected"
              : "connected",
        rateLimitCountdown:
          update.rateLimitSeconds != null
            ? update.rateLimitSeconds
            : (existing?.rateLimitCountdown ?? null),
        rateLimitDetectedAt:
          update.rateLimitSeconds != null ? Date.now() : (existing?.rateLimitDetectedAt ?? null),
        rateLimitFiveHourResetLabel: existing?.rateLimitFiveHourResetLabel ?? null,
        rateLimitSevenDayResetLabel: existing?.rateLimitSevenDayResetLabel ?? null,
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
      const statusFromScreen = screenData.detectedStatus;
      const preserveLiveStatus =
        statusFromScreen === "idle" &&
        (currentTab.processStatus === "running" ||
          currentTab.processStatus === "thinking" ||
          currentTab.processStatus === "waiting" ||
          currentTab.processStatus === "stale");
      const resolvedStatus = preserveLiveStatus
        ? currentTab.processStatus
        : (statusFromScreen ?? existing?.detailedStatus ?? currentTab.processStatus ?? "idle");
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
        rateLimit:
          screenData.rateFiveHourLeft != null || screenData.rateSevenDayLeft != null
            ? {
                fiveHourPercent:
                  screenData.rateFiveHourLeft != null
                    ? 100 - screenData.rateFiveHourLeft
                    : (existing?.rateLimit?.fiveHourPercent ?? 0),
                sevenDayPercent:
                  screenData.rateSevenDayLeft != null
                    ? 100 - screenData.rateSevenDayLeft
                    : (existing?.rateLimit?.sevenDayPercent ?? 0),
                fiveHourResetSeconds:
                  screenData.rateFiveHourResetSeconds ??
                  existing?.rateLimit?.fiveHourResetSeconds ??
                  0,
                sevenDayResetSeconds:
                  screenData.rateSevenDayResetSeconds ??
                  existing?.rateLimit?.sevenDayResetSeconds ??
                  0,
              }
            : (existing?.rateLimit ?? null),
        billing: existing?.billing ?? null,
        plan: existing?.plan ?? null,
        hasCredentials: existing?.hasCredentials ?? false,
        activeTools: screenData.activeTools.length
          ? screenData.activeTools
          : (existing?.activeTools ?? []),
        sessionDuration: Math.max(0, Math.floor((Date.now() - currentTab.createdAt) / 1000)),
        detailedStatus: resolvedStatus,
        connectionStatus:
          resolvedStatus === "error" || resolvedStatus === "disconnected"
            ? "error"
            : resolvedStatus === "idle"
              ? "disconnected"
              : "connected",
        rateLimitCountdown: existing?.rateLimitCountdown ?? null,
        rateLimitDetectedAt: existing?.rateLimitDetectedAt ?? null,
        rateLimitFiveHourResetLabel:
          screenData.rateFiveHourResetLabel ?? existing?.rateLimitFiveHourResetLabel ?? null,
        rateLimitSevenDayResetLabel:
          screenData.rateSevenDayResetLabel ?? existing?.rateLimitSevenDayResetLabel ?? null,
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
