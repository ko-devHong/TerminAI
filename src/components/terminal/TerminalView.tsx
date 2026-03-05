import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import { hudMetricsAtom } from "@/atoms/hud";
import { terminalFontSizeAtom } from "@/atoms/settings";
import { tabAtom } from "@/atoms/spaces";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { mergeIntoHudMetrics } from "@/lib/hud-merge";
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

import { TerminalSearchBar } from "./TerminalSearchBar";

interface TerminalViewProps {
  tabId: string | null;
  searchOpen?: boolean;
  onSearchClose?: () => void;
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

const spawningTabs = new Set<string>();

export function TerminalView({ tabId, searchOpen = false, onSearchClose }: TerminalViewProps) {
  const tab = useAtomValue(tabAtom(tabId ?? "__none__"));
  const store = useStore();
  const fontSize = useAtomValue(terminalFontSizeAtom);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeTabIdRef = useRef<string | null>(null);
  const lastActivityUpdateRef = useRef<number>(0);
  const [internalSearchOpen, setInternalSearchOpen] = useState(false);

  const isSearchOpen = searchOpen || internalSearchOpen;
  const handleSearchClose = onSearchClose ?? (() => setInternalSearchOpen(false));

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
      if (cached.terminal.element.parentElement !== container) {
        container.appendChild(cached.terminal.element);
      }
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

  // Extract only the tab properties ensureSession depends on, so that
  // unrelated tab updates (lastActivityAt, isFocused, etc.) don't re-trigger
  // session spawning.
  const tabSessionId = tab?.sessionId ?? null;
  const tabProcessStatus = tab?.processStatus ?? null;
  const tabProvider = tab?.provider ?? null;
  const tabCwd = tab?.cwd ?? null;

  // Session management: spawn or attach session for current tab
  useEffect(() => {
    if (!tabId || !tabProvider) {
      return;
    }

    const currentTabId = tabId;
    const cached = terminalCacheMap.get(currentTabId);
    if (!cached) {
      return;
    }

    async function ensureSession(): Promise<void> {
      if (!cached) return;

      if (!isTauriRuntimeAvailable()) {
        if (!cached.sessionId) {
          cached.terminal.writeln(`[${tabProvider}] Tauri runtime unavailable in web mode.`);
          cached.terminal.writeln("Run `bun run tauri dev` to spawn real PTY sessions.");
        }
        return;
      }

      if (tabSessionId) {
        if (cached.sessionId !== tabSessionId) {
          cached.sessionId = tabSessionId;
        }
        // Always fit and focus when attaching/matching
        cached.fitAddon.fit();
        window.requestAnimationFrame(() => {
          cached.terminal.focus();
        });
        return;
      }

      if (cached.sessionId) {
        // We have a local session but the atom doesn't know about it.
        // Sync atom with local state.
        setTabSessionAndStatus(currentTabId, cached.sessionId, "running");
        return;
      }

      // Only auto-spawn for fresh tabs; don't retry after disconnect/error
      if (tabProcessStatus !== "idle") {
        return;
      }

      // Prevent concurrent spawn attempts (global check)
      if (spawningTabs.has(currentTabId)) {
        return;
      }
      spawningTabs.add(currentTabId);

      cached.terminal.writeln(`[${tabProvider}] spawning session...`);

      try {
        const spawnedSessionId = await invokeTauri<string>("spawn_session", {
          provider: tabProvider,
          cwd: tabCwd ?? ".",
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
        if (tabProvider === "claude-code") {
          invokeTauri("setup_claude_statusline").catch(() => {});
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cached.terminal.writeln(`Failed to spawn session: ${message}`);
        cached.sessionId = null;
        setTabSessionAndStatus(currentTabId, null, "error");
      } finally {
        spawningTabs.delete(currentTabId);
      }
    }

    void ensureSession();
  }, [setTabSessionAndStatus, tabId, tabSessionId, tabProcessStatus, tabProvider, tabCwd]);

  const sessionId = tab?.sessionId ?? null;

  useEffect(() => {
    if (
      !tabId ||
      !sessionId ||
      !tab ||
      (tab.provider !== "codex-cli" && tab.provider !== "gemini-cli") ||
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
          const fiveResetLabel = five?.[2]?.trim() ?? null;
          const sevenResetLabel = seven?.[2]?.trim() ?? null;

          const partial: Partial<HUDMetrics> = {
            provider: currentTab.provider,
            sessionDuration: Math.max(0, Math.floor((Date.now() - currentTab.createdAt) / 1000)),
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
            rateLimitFiveHourResetLabel: fiveResetLabel ?? undefined,
            rateLimitSevenDayResetLabel: sevenResetLabel ?? undefined,
          };

          const base: HUDMetrics = existing ?? {
            provider: currentTab.provider,
            model: null,
            contextWindow: null,
            tokens: null,
            cost: null,
            rateLimit: null,
            billing: null,
            plan: null,
            hasCredentials: false,
            activeTools: [],
            sessionDuration: 0,
            detailedStatus: currentTab.processStatus,
            connectionStatus: "connected",
            rateLimitCountdown: null,
            rateLimitDetectedAt: null,
            rateLimitFiveHourResetLabel: null,
            rateLimitSevenDayResetLabel: null,
          };

          store.set(
            hudMetricsAtom(currentTab.sessionId),
            mergeIntoHudMetrics(
              base,
              partial,
              "handleOutput",
              existing?._lastSource as import("@/lib/hud-merge").MetricSource | null | undefined,
            ),
          );
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

          const partial: Partial<HUDMetrics> = {
            provider: currentTab.provider,
            sessionDuration: Math.max(0, Math.floor((Date.now() - currentTab.createdAt) / 1000)),
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
            rateLimitFiveHourResetLabel: shortResetLabel ?? undefined,
            rateLimitSevenDayResetLabel: longResetLabel ?? undefined,
          };

          const base: HUDMetrics = existing ?? {
            provider: currentTab.provider,
            model: null,
            contextWindow: null,
            tokens: null,
            cost: null,
            rateLimit: null,
            billing: null,
            plan: null,
            hasCredentials: false,
            activeTools: [],
            sessionDuration: 0,
            detailedStatus: currentTab.processStatus,
            connectionStatus: "connected",
            rateLimitCountdown: null,
            rateLimitDetectedAt: null,
            rateLimitFiveHourResetLabel: null,
            rateLimitSevenDayResetLabel: null,
          };

          store.set(
            hudMetricsAtom(currentTab.sessionId),
            mergeIntoHudMetrics(
              base,
              partial,
              "handleOutput",
              existing?._lastSource as import("@/lib/hud-merge").MetricSource | null | undefined,
            ),
          );
        }
      }

      // Only update tab activity/status if we still have a live session.
      // We throttle these updates to avoid excessive re-renders during high-volume output.
      const now = Date.now();
      const shouldUpdateStatus = currentTab.processStatus !== "running";
      const shouldUpdateActivity = now - lastActivityUpdateRef.current > 2000;

      if (currentTab.sessionId && (shouldUpdateStatus || shouldUpdateActivity)) {
        lastActivityUpdateRef.current = now;
        store.set(tabAtom(tabId), {
          ...currentTab,
          processStatus: "running",
          lastActivityAt: now,
        });
      }
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
      const source =
        (update.source as import("@/lib/hud-merge").MetricSource | null | undefined) ??
        "statusline";

      // If statusline sends data without explicit status, the CLI is actively
      // outputting → treat as "running". This prevents "thinking" from sticking
      // after the AI finishes its response.
      const resolvedStatus =
        (update.status as ProcessStatus | null) ??
        (source === "statusline" ? "running" : null) ??
        existing?.detailedStatus ??
        currentTab.processStatus ??
        "idle";

      const partial: Partial<HUDMetrics> = {
        provider: currentTab.provider,
        model: update.model ?? undefined,
        contextWindow:
          update.contextUsed != null && update.contextTotal != null
            ? { used: update.contextUsed, total: update.contextTotal }
            : undefined,
        tokens:
          update.tokensIn != null || update.tokensOut != null
            ? {
                input: update.tokensIn ?? existing?.tokens?.input ?? 0,
                output: update.tokensOut ?? existing?.tokens?.output ?? 0,
              }
            : undefined,
        cost: update.cost ?? undefined,
        rateLimit: existing?.rateLimit ?? undefined,
        activeTools: update.activeTools.length ? update.activeTools : undefined,
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
            : (existing?.rateLimitCountdown ?? undefined),
        rateLimitDetectedAt:
          update.rateLimitSeconds != null
            ? Date.now()
            : (existing?.rateLimitDetectedAt ?? undefined),
      };

      const base: HUDMetrics = existing ?? {
        provider: currentTab.provider,
        model: null,
        contextWindow: null,
        tokens: null,
        cost: null,
        rateLimit: null,
        billing: null,
        plan: null,
        hasCredentials: false,
        activeTools: [],
        sessionDuration: 0,
        detailedStatus: currentTab.processStatus,
        connectionStatus: "connected",
        rateLimitCountdown: null,
        rateLimitDetectedAt: null,
        rateLimitFiveHourResetLabel: null,
        rateLimitSevenDayResetLabel: null,
      };

      const merged = mergeIntoHudMetrics(
        base,
        partial,
        source,
        existing?._lastSource as import("@/lib/hud-merge").MetricSource | null | undefined,
      );
      store.set(hudMetricsAtom(sessionId), merged);
    },
    [store, tabId, sessionId],
  );

  useTauriEvent<string>(sessionId ? `pty-output-${sessionId}` : null, handleOutput);
  useTauriEvent<ProcessStatus>(sessionId ? `session-status-${sessionId}` : null, handleStatus);
  useTauriEvent<MetricUpdate>(sessionId ? `metrics-${sessionId}` : null, handleMetrics);

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ background: "var(--color-background)" }}
      />
      <TerminalSearchBar tabId={tabId} open={isSearchOpen} onClose={handleSearchClose} />
    </div>
  );
}
