import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import { tabAtom } from "@/atoms/spaces";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { invokeTauri, isTauriRuntimeAvailable } from "@/lib/tauri";
import type { AIProvider, ProcessStatus } from "@/types";

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

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);

  const setTabSessionAndStatus = useCallback(
    (nextSessionId: string | null, nextStatus: ProcessStatus) => {
      if (!tabId) {
        return;
      }

      const currentTab = store.get(tabAtom(tabId));
      if (!currentTab) {
        return;
      }

      store.set(tabAtom(tabId), {
        ...currentTab,
        sessionId: nextSessionId,
        processStatus: nextStatus,
        lastActivityAt: Date.now(),
      });
    },
    [store, tabId],
  );

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 10000,
      theme: {
        background: "#09090B",
        foreground: "#FAFAFA",
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    // Keep default renderer for IME stability (Korean/Japanese/Chinese input).

    terminal.open(containerRef.current);
    fitAddon.fit();

    const dataDisposable = terminal.onData((data) => {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) {
        return;
      }

      void invokeTauri<void>("write_to_session", { sessionId, data: data.normalize("NFC") });
    });

    function onResize() {
      fitAddon.fit();

      const sessionId = currentSessionIdRef.current;
      if (!sessionId) {
        return;
      }

      void invokeTauri<void>("resize_session", {
        sessionId,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    }

    window.addEventListener("resize", onResize);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    return () => {
      window.removeEventListener("resize", onResize);
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    const maybeTerminal = terminalRef.current;
    if (!maybeTerminal) {
      return;
    }
    const term = maybeTerminal;

    if (!tabId || !tab) {
      term.clear();
      term.writeln("No active tab.");
      currentSessionIdRef.current = null;
      return;
    }

    const activeTab = tab;
    const existingSessionId = activeTab.sessionId;

    async function ensureSession(): Promise<void> {
      if (!isTauriRuntimeAvailable()) {
        term.clear();
        term.writeln(`[${activeTab.provider}] Tauri runtime unavailable in web mode.`);
        term.writeln("Run `bun run tauri dev` to spawn real PTY sessions.");
        currentSessionIdRef.current = null;
        return;
      }

      if (existingSessionId) {
        if (currentSessionIdRef.current === existingSessionId) {
          return;
        }

        term.clear();
        currentSessionIdRef.current = existingSessionId;
        term.writeln(`[${activeTab.provider}] attached to session ${existingSessionId}`);
        return;
      }

      term.clear();
      term.writeln(`[${activeTab.provider}] spawning session...`);

      try {
        const spawnedSessionId = await invokeTauri<string>("spawn_session", {
          provider: activeTab.provider,
          cwd: activeTab.cwd,
        });

        currentSessionIdRef.current = spawnedSessionId;
        setTabSessionAndStatus(spawnedSessionId, "running");

        fitAddonRef.current?.fit();
        await invokeTauri<void>("resize_session", {
          sessionId: spawnedSessionId,
          cols: term.cols,
          rows: term.rows,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        term.writeln(`Failed to spawn session: ${message}`);
        setTabSessionAndStatus(null, "error");
        currentSessionIdRef.current = null;
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
      if (terminalRef.current && sanitizedPayload.length > 0) {
        terminalRef.current.write(sanitizedPayload);
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
      if (!sessionId) {
        return;
      }

      if (status === "disconnected" || status === "error") {
        currentSessionIdRef.current = null;
      }

      setTabSessionAndStatus(status === "disconnected" ? null : sessionId, status);
    },
    [sessionId, setTabSessionAndStatus],
  );

  useTauriEvent<string>(sessionId ? `pty-output-${sessionId}` : null, handleOutput);
  useTauriEvent<ProcessStatus>(sessionId ? `session-status-${sessionId}` : null, handleStatus);

  return <div ref={containerRef} className="h-full w-full" />;
}
