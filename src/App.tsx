import { useEffect } from "react";

import { useAtomValue, useSetAtom } from "jotai";

import { sidebarWidthAtom } from "@/atoms/settings";
import { focusedTabIdAtom, initializeWorkspaceAtom } from "@/atoms/spaces";
import { HUDPanel } from "@/components/hud/HUDPanel";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { TerminalView } from "@/components/terminal/TerminalView";

function App() {
  const initializeWorkspace = useSetAtom(initializeWorkspaceAtom);
  const focusedTabId = useAtomValue(focusedTabIdAtom);
  const sidebarWidth = useAtomValue(sidebarWidthAtom);

  useEffect(() => {
    initializeWorkspace();
  }, [initializeWorkspace]);

  useEffect(() => {
    const width = Math.min(360, Math.max(180, sidebarWidth));
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  }, [sidebarWidth]);

  return (
    <main className="flex h-screen w-screen bg-zinc-950 text-zinc-50">
      <Sidebar />

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 border-b border-zinc-800">
          <TerminalView tabId={focusedTabId} />
        </div>
        <HUDPanel />
      </section>
    </main>
  );
}

export default App;
