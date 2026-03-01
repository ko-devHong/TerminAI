import { useAtomValue, useSetAtom } from "jotai";
import { Command } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { sidebarCollapsedAtom, sidebarWidthAtom } from "@/atoms/settings";
import {
  allTabsAtom,
  closeTabAtom,
  createTabAtom,
  favoriteTabIdsAtom,
  focusedTabAtom,
  focusedTabIdAtom,
  focusTabAtom,
  initializeWorkspaceAtom,
  spacesAtom,
} from "@/atoms/spaces";
import { HUDPanel } from "@/components/hud/HUDPanel";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { TerminalView } from "@/components/terminal/TerminalView";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";

function App() {
  const initializeWorkspace = useSetAtom(initializeWorkspaceAtom);
  const focusedTabId = useAtomValue(focusedTabIdAtom);
  const focusedTab = useAtomValue(focusedTabAtom);
  const sidebarWidth = useAtomValue(sidebarWidthAtom);
  const spaces = useAtomValue(spacesAtom);
  const allTabs = useAtomValue(allTabsAtom);
  const favoriteTabIds = useAtomValue(favoriteTabIdsAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const createTab = useSetAtom(createTabAtom);
  const closeTab = useSetAtom(closeTabAtom);
  const focusTab = useSetAtom(focusTabAtom);
  const [isCommandOpen, setIsCommandOpen] = useState(false);

  useEffect(() => {
    initializeWorkspace();
  }, [initializeWorkspace]);

  useEffect(() => {
    const width = Math.min(360, Math.max(180, sidebarWidth));
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  }, [sidebarWidth]);

  const orderedTabs = useMemo(() => {
    const byId = new Map(allTabs.map((tab) => [tab.id, tab]));
    const tabs: typeof allTabs = [];

    for (const space of spaces) {
      for (const tabId of space.tabIds) {
        const tab = byId.get(tabId);
        if (tab) {
          tabs.push(tab);
        }
      }
    }

    return tabs;
  }, [allTabs, spaces]);

  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) {
        return false;
      }

      const tag = target.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || target.isContentEditable) {
        return true;
      }

      return false;
    }

    function onKeyDown(event: KeyboardEvent) {
      const isMod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const editable = isEditableTarget(event.target);

      if (isMod && key === "k") {
        event.preventDefault();
        setIsCommandOpen((prev) => !prev);
        return;
      }

      if (editable) {
        return;
      }

      if (isMod && key === "t") {
        event.preventDefault();
        const nextSpaceId = focusedTab?.spaceId ?? spaces[0]?.id;
        if (!nextSpaceId) {
          return;
        }
        createTab({ spaceId: nextSpaceId, provider: "claude-code" });
        return;
      }

      if (isMod && key === "w") {
        event.preventDefault();
        if (focusedTabId) {
          closeTab(focusedTabId);
        }
        return;
      }

      if (isMod && key === "\\") {
        event.preventDefault();
        setSidebarCollapsed((prev) => !prev);
        return;
      }

      if (isMod && event.shiftKey && (key === "[" || key === "]")) {
        event.preventDefault();
        if (spaces.length === 0) {
          return;
        }

        const activeSpaceId = focusedTab?.spaceId ?? spaces[0].id;
        const currentSpaceIndex = Math.max(
          0,
          spaces.findIndex((space) => space.id === activeSpaceId),
        );
        const delta = key === "[" ? -1 : 1;
        const nextIndex = (currentSpaceIndex + delta + spaces.length) % spaces.length;
        const nextSpace = spaces[nextIndex];
        const nextTabId = nextSpace.tabIds[0];
        if (nextTabId) {
          focusTab(nextTabId);
        }
        return;
      }

      if (isMod && /^[1-9]$/.test(key)) {
        event.preventDefault();
        const index = Number(key) - 1;
        const targetTabId = favoriteTabIds[index];
        if (targetTabId) {
          focusTab(targetTabId);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    closeTab,
    createTab,
    favoriteTabIds,
    focusTab,
    focusedTab,
    focusedTabId,
    setSidebarCollapsed,
    spaces,
  ]);

  return (
    <main className="flex h-screen w-screen bg-zinc-950 text-zinc-50">
      <Sidebar onOpenCommandPalette={() => setIsCommandOpen(true)} />

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 border-b border-zinc-800">
          <TerminalView tabId={focusedTabId} />
        </div>
        <HUDPanel />
      </section>

      <CommandDialog open={isCommandOpen} onOpenChange={setIsCommandOpen}>
        <CommandInput placeholder="Search commands, tabs, spaces..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>

          <CommandGroup heading="Quick Actions">
            <CommandItem
              onSelect={() => {
                const nextSpaceId = focusedTab?.spaceId ?? spaces[0]?.id;
                if (!nextSpaceId) return;
                createTab({ spaceId: nextSpaceId, provider: "claude-code" });
                setIsCommandOpen(false);
              }}
            >
              <Command className="size-4" />
              New Claude Tab
              <CommandShortcut>⌘T</CommandShortcut>
            </CommandItem>
            <CommandItem
              onSelect={() => {
                const nextSpaceId = focusedTab?.spaceId ?? spaces[0]?.id;
                if (!nextSpaceId) return;
                createTab({ spaceId: nextSpaceId, provider: "codex-cli" });
                setIsCommandOpen(false);
              }}
            >
              <Command className="size-4" />
              New Codex Tab
            </CommandItem>
            <CommandItem
              onSelect={() => {
                const nextSpaceId = focusedTab?.spaceId ?? spaces[0]?.id;
                if (!nextSpaceId) return;
                createTab({ spaceId: nextSpaceId, provider: "gemini-cli" });
                setIsCommandOpen(false);
              }}
            >
              <Command className="size-4" />
              New Gemini Tab
            </CommandItem>
          </CommandGroup>

          <CommandGroup heading="Tabs">
            {orderedTabs.map((tab) => (
              <CommandItem
                key={tab.id}
                onSelect={() => {
                  focusTab(tab.id);
                  setIsCommandOpen(false);
                }}
              >
                <span className="truncate">{tab.name}</span>
                <CommandShortcut>{tab.provider}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </main>
  );
}

export default App;
