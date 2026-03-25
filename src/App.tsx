import { useAtomValue, useSetAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import {
  defaultCwdAtom,
  sidebarCollapsedAtom,
  sidebarWidthAtom,
  themeAtom,
} from "@/atoms/settings";
import {
  allTabsAtom,
  closeCwdEditorAtom,
  closeTabAtom,
  createTabAtom,
  cwdEditorAtom,
  cwdEditorTabAtom,
  favoriteTabIdsAtom,
  focusedTabAtom,
  focusedTabIdAtom,
  focusTabAtom,
  initializeWorkspaceAtom,
  setTabCwdAtom,
  spacesAtom,
} from "@/atoms/spaces";
import { HUDPanel } from "@/components/hud/HUDPanel";
import {
  ProviderSetup,
  resetOnboarding,
  useOnboardingRequired,
} from "@/components/onboarding/ProviderSetup";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useStaleDetection } from "@/hooks/useStaleDetection";
import { invokeTauri, isTauriRuntimeAvailable } from "@/lib/tauri";

const LazyTerminalView = lazy(async () => ({
  default: (await import("@/components/terminal/TerminalView")).TerminalView,
}));
const LazyCommandPalette = lazy(async () => ({
  default: (await import("@/components/command/CommandPalette")).CommandPalette,
}));

function App() {
  const initializeWorkspace = useSetAtom(initializeWorkspaceAtom);
  const focusedTabId = useAtomValue(focusedTabIdAtom);
  const focusedTab = useAtomValue(focusedTabAtom);
  const sidebarWidth = useAtomValue(sidebarWidthAtom);
  const spaces = useAtomValue(spacesAtom);
  const allTabs = useAtomValue(allTabsAtom);
  const favoriteTabIds = useAtomValue(favoriteTabIdsAtom);
  const cwdEditor = useAtomValue(cwdEditorAtom);
  const editingTab = useAtomValue(cwdEditorTabAtom);
  const defaultCwd = useAtomValue(defaultCwdAtom);
  const theme = useAtomValue(themeAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const setDefaultCwd = useSetAtom(defaultCwdAtom);
  const createTab = useSetAtom(createTabAtom);
  const closeTab = useSetAtom(closeTabAtom);
  const closeCwdEditor = useSetAtom(closeCwdEditorAtom);
  const setTabCwd = useSetAtom(setTabCwdAtom);
  const focusTab = useSetAtom(focusTabAtom);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isDefaultPathOpen, setIsDefaultPathOpen] = useState(false);
  const [defaultPathDraft, setDefaultPathDraft] = useState(defaultCwd);
  const [tabPathDraft, setTabPathDraft] = useState("");
  const [isSavingCwd, setIsSavingCwd] = useState(false);
  const [isSavingDefaultPath, setIsSavingDefaultPath] = useState(false);
  const onboardingRequired = useOnboardingRequired();
  const [showOnboarding, setShowOnboarding] = useState(false);

  useStaleDetection();

  useEffect(() => {
    initializeWorkspace();
  }, [initializeWorkspace]);

  useEffect(() => {
    const width = Math.min(360, Math.max(180, sidebarWidth));
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  }, [sidebarWidth]);

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
  }, [theme]);

  useEffect(() => {
    setDefaultPathDraft(defaultCwd);
  }, [defaultCwd]);

  useEffect(() => {
    if (editingTab) {
      setTabPathDraft(editingTab.cwd || ".");
    }
  }, [editingTab]);

  useEffect(() => {
    if (onboardingRequired) {
      setShowOnboarding(true);
      setIsDefaultPathOpen(false);
    } else {
      const hasStoredDefaultPath = window.localStorage.getItem("terminai:default-cwd") !== null;
      if (!hasStoredDefaultPath) {
        setIsDefaultPathOpen(true);
      }
    }
  }, [onboardingRequired]);

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

      if (isMod && key === "f") {
        event.preventDefault();
        setIsSearchOpen((prev) => !prev);
        return;
      }

      if (isMod && key === "t") {
        event.preventDefault();
        const nextSpaceId = focusedTab?.spaceId ?? spaces[0]?.id;
        if (!nextSpaceId) {
          return;
        }
        createTab({
          spaceId: nextSpaceId,
          provider: "claude-code",
          cwd: focusedTab?.cwd ?? defaultCwd,
        });
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
        return;
      }

      if (editable) {
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    closeTab,
    createTab,
    defaultCwd,
    favoriteTabIds,
    focusTab,
    focusedTab,
    focusedTabId,
    setSidebarCollapsed,
    spaces,
  ]);

  return (
    <main
      className="flex h-screen w-screen"
      style={{ background: "var(--color-background)", color: "var(--color-text-primary)" }}
    >
      <Sidebar
        onOpenCommandPalette={() => setIsCommandOpen(true)}
        onOpenDefaultPathDialog={() => setIsDefaultPathOpen(true)}
        onResetApp={() => {
          resetOnboarding();
          setShowOnboarding(true);
        }}
        defaultCwd={defaultCwd}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1 border-b border-zinc-800">
          <AnimatePresence mode="popLayout">
            <motion.div
              key={focusedTabId ?? "empty"}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.05 }}
              className="absolute inset-0"
            >
              <Suspense fallback={<div className="h-full w-full bg-zinc-950" />}>
                <LazyTerminalView
                  tabId={focusedTabId}
                  searchOpen={isSearchOpen}
                  onSearchClose={() => setIsSearchOpen(false)}
                />
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </div>
        <HUDPanel />
      </section>

      {isCommandOpen ? (
        <Suspense fallback={null}>
          <LazyCommandPalette
            open={isCommandOpen}
            onOpenChange={setIsCommandOpen}
            spaces={spaces}
            orderedTabs={orderedTabs}
            focusedTab={focusedTab}
            defaultCwd={defaultCwd}
            onCreateTab={createTab}
            onFocusTab={focusTab}
          />
        </Suspense>
      ) : null}

      <Dialog open={cwdEditor.open} onOpenChange={(open) => !open && closeCwdEditor()}>
        <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Set Working Directory</DialogTitle>
            <DialogDescription>
              This path is used when the selected tab spawns its next session.
            </DialogDescription>
          </DialogHeader>

          <input
            value={tabPathDraft}
            onChange={(event) => setTabPathDraft(event.target.value)}
            className="h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm outline-none focus:border-zinc-500"
            placeholder="e.g. /Users/taehonglee/TerminAI"
          />

          <DialogFooter>
            <Button variant="outline" onClick={() => closeCwdEditor()}>
              Cancel
            </Button>
            <Button
              disabled={isSavingCwd}
              onClick={async () => {
                if (!editingTab) {
                  closeCwdEditor();
                  return;
                }

                setIsSavingCwd(true);
                try {
                  if (editingTab.sessionId && isTauriRuntimeAvailable()) {
                    try {
                      await invokeTauri<void>("kill_session", { sessionId: editingTab.sessionId });
                    } catch {
                      // Session can be already ended.
                    }
                  }

                  setTabCwd({ tabId: editingTab.id, cwd: tabPathDraft });
                  closeCwdEditor();
                } finally {
                  setIsSavingCwd(false);
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {showOnboarding && (
        <ProviderSetup
          onComplete={() => {
            setShowOnboarding(false);
            setDefaultPathDraft(defaultCwd);
          }}
        />
      )}

      <Dialog open={isDefaultPathOpen} onOpenChange={setIsDefaultPathOpen}>
        <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Default Run Path</DialogTitle>
            <DialogDescription>
              Set the path used by new tabs. You can change each tab path later from right-click.
            </DialogDescription>
          </DialogHeader>

          <input
            value={defaultPathDraft}
            onChange={(event) => setDefaultPathDraft(event.target.value)}
            className="h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm outline-none focus:border-zinc-500"
            placeholder="e.g. /Users/taehonglee/TerminAI"
          />

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDefaultPathOpen(false)}>
              Later
            </Button>
            <Button
              disabled={isSavingDefaultPath}
              onClick={async () => {
                setIsSavingDefaultPath(true);
                try {
                  const nextCwd = defaultPathDraft.trim() || ".";
                  setDefaultCwd(nextCwd);

                  if (focusedTab) {
                    if (focusedTab.sessionId && isTauriRuntimeAvailable()) {
                      try {
                        await invokeTauri<void>("kill_session", {
                          sessionId: focusedTab.sessionId,
                        });
                      } catch {
                        // Session can be already ended.
                      }
                    }
                    setTabCwd({ tabId: focusedTab.id, cwd: nextCwd });
                  }

                  setIsDefaultPathOpen(false);
                } finally {
                  setIsSavingDefaultPath(false);
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

export default App;
