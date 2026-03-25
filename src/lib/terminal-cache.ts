import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";

export interface TerminalCache {
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  sessionId: string | null;
  dispose: () => void;
  imeUpgraded: boolean;
}

export const terminalCacheMap = new Map<string, TerminalCache>();

/**
 * Attach IME-aware input handling to an xterm.js terminal.
 *
 * xterm.js's built-in `onData` fires per-keystroke even during IME
 * composition in some WebView environments (Tauri WKWebView on macOS).
 * This causes Korean/Japanese/Chinese input to break — only the initial
 * consonant (초성) is sent instead of the composed character.
 *
 * Fix: track composition state via DOM events on xterm's hidden textarea
 * and suppress `onData` while composing. On `compositionend`, the
 * composed text is sent as a single unit.
 */
function attachIMEAwareInput(
  terminal: Terminal,
  tabId: string,
  onInput: (data: string, tabId: string) => void,
): () => void {
  let isComposing = false;
  // Track the last composed text so we can deduplicate against xterm's onData.
  // After compositionend, xterm may fire onData with the same composed text —
  // we skip that exact match once and let subsequent keystrokes through immediately.
  let lastComposedText: string | null = null;

  const onDataDisposable = terminal.onData((data) => {
    if (isComposing) {
      return;
    }
    // After compositionend, xterm fires onData with the composed text.
    // Skip that duplicate but allow all other keystrokes (space, enter, etc.) through.
    if (lastComposedText !== null) {
      if (data === lastComposedText) {
        lastComposedText = null;
        return;
      }
      // Different data — the duplicate either already came or won't come.
      lastComposedText = null;
    }
    onInput(data, tabId);
  });

  function onCompositionStart() {
    isComposing = true;
    lastComposedText = null;
  }

  function onCompositionEnd(event: CompositionEvent) {
    const composed = event.data;
    isComposing = false;

    if (composed) {
      // Remember the composed text to skip the duplicate onData that xterm fires
      lastComposedText = composed;
      onInput(composed, tabId);

      // Safety: clear the dedup state after a short window in case onData never fires
      setTimeout(() => {
        lastComposedText = null;
      }, 50);
    }
  }

  // xterm.js creates a hidden <textarea> for capturing input.
  // We attach composition listeners to it once the terminal is opened.
  const textarea = terminal.element?.querySelector("textarea");
  if (textarea) {
    textarea.addEventListener("compositionstart", onCompositionStart);
    textarea.addEventListener("compositionend", onCompositionEnd);
  }

  return () => {
    onDataDisposable.dispose();
    if (textarea) {
      textarea.removeEventListener("compositionstart", onCompositionStart);
      textarea.removeEventListener("compositionend", onCompositionEnd);
    }
  };
}

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

  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);

  // IME listeners will be attached after terminal.open() in TerminalView.
  // For now, use basic onData — it'll be replaced by attachIMEAwareInput.
  const onDataDisposable = terminal.onData((data) => {
    onInput(data, tabId);
  });

  const cache: TerminalCache = {
    terminal,
    fitAddon,
    searchAddon,
    sessionId: null,
    dispose: () => onDataDisposable.dispose(),
    imeUpgraded: false,
  };

  terminalCacheMap.set(tabId, cache);
  return cache;
}

/**
 * Call this after `terminal.open(container)` so the hidden textarea exists.
 * Replaces the basic `onData` handler with an IME-aware one.
 * Safe to call multiple times — will only upgrade once per terminal.
 */
export function upgradeToIMEInput(
  tabId: string,
  onInput: (data: string, tabId: string) => void,
): void {
  const cached = terminalCacheMap.get(tabId);
  if (!cached) return;

  // Already upgraded — skip to avoid stacking duplicate listeners
  if (cached.imeUpgraded) return;

  // Dispose the basic onData listener
  cached.dispose();

  // Replace with IME-aware version
  cached.dispose = attachIMEAwareInput(cached.terminal, tabId, onInput);
  cached.imeUpgraded = true;
}

export function disposeTerminalCache(tabId: string): void {
  const cached = terminalCacheMap.get(tabId);
  if (!cached) {
    return;
  }

  cached.dispose();
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
