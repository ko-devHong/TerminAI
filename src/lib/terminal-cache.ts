import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

export interface TerminalCache {
  terminal: Terminal;
  fitAddon: FitAddon;
  sessionId: string | null;
  onDataDisposable: { dispose: () => void };
}

export const terminalCacheMap = new Map<string, TerminalCache>();

export function getOrCreateTerminal(
  tabId: string,
  fontSize: number,
  onInput: (data: string, tabId: string) => void,
): TerminalCache {
  const existing = terminalCacheMap.get(tabId);
  if (existing) {
    return existing;
  }

  const terminal = new Terminal({
    fontFamily: '"JetBrains Mono", "Fira Code", monospace',
    fontSize,
    cursorBlink: true,
    scrollback: 10000,
    theme: {
      background: "#09090B",
      foreground: "#FAFAFA",
      cursor: "#FAFAFA",
      selectionBackground: "#27272A",
    },
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const onDataDisposable = terminal.onData((data) => {
    onInput(data, tabId);
  });

  const cache: TerminalCache = {
    terminal,
    fitAddon,
    sessionId: null,
    onDataDisposable,
  };

  terminalCacheMap.set(tabId, cache);
  return cache;
}

export function disposeTerminalCache(tabId: string): void {
  const cached = terminalCacheMap.get(tabId);
  if (!cached) {
    return;
  }

  cached.onDataDisposable.dispose();
  cached.terminal.dispose();
  terminalCacheMap.delete(tabId);
}

export function writeToTerminalCache(tabId: string, data: string): void {
  const cached = terminalCacheMap.get(tabId);
  if (cached) {
    cached.terminal.write(data);
  }
}

export function setTerminalCacheSessionId(tabId: string, sessionId: string | null): void {
  const cached = terminalCacheMap.get(tabId);
  if (cached) {
    cached.sessionId = sessionId;
  }
}
