import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import { tabAtom } from "@/atoms/spaces";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { invokeTauri } from "@/lib/tauri";
import type { ProcessStatus } from "@/types";

import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  tabId: string | null;
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

    try {
      const webglAddon = new WebglAddon();
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL may fail on unsupported environments.
    }

    terminal.open(containerRef.current);
    fitAddon.fit();

    const dataDisposable = terminal.onData((data) => {
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) {
        return;
      }

      void invokeTauri<void>("write_to_session", { sessionId, data });
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
      term.clear();

      if (existingSessionId) {
        currentSessionIdRef.current = existingSessionId;
        term.writeln(`[${activeTab.provider}] attached to session ${existingSessionId}`);
        return;
      }

      term.writeln(`[${activeTab.provider}] spawning session...`);

      try {
        const spawnedSessionId = await invokeTauri<string>("spawn_session", {
          provider: activeTab.provider,
          cwd: ".",
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
      if (terminalRef.current) {
        terminalRef.current.write(payload);
      }

      if (!tabId) {
        return;
      }

      const currentTab = store.get(tabAtom(tabId));
      if (!currentTab) {
        return;
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
