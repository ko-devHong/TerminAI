import { useEffect, useRef } from "react";

import { useAtomValue } from "jotai";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

import { tabAtom } from "@/atoms/spaces";

import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  tabId: string | null;
}

export function TerminalView({ tabId }: TerminalViewProps) {
  const tab = useAtomValue(tabAtom(tabId ?? "__none__"));

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

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
      // WebGL can fail depending on driver/GPU; terminal still works with canvas renderer.
    }

    terminal.open(containerRef.current);
    fitAddon.fit();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    function onResize() {
      fitAddon.fit();
    }

    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.clear();

    if (!tabId || !tab) {
      terminal.writeln("No active tab");
      return;
    }

    terminal.writeln(`TerminAI mock session: ${tab.name}`);
    terminal.writeln(`Provider: ${tab.provider}`);
    terminal.writeln("-------------------------------------------");
    terminal.writeln("This terminal is ready for Phase 1 PTY wiring.");
    terminal.writeln("No backend session is attached yet.");
    terminal.write("$ ");

    fitAddonRef.current?.fit();
  }, [tab, tabId]);

  return <div ref={containerRef} className="h-full w-full" />;
}
