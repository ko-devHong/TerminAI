import { atom } from "jotai";
import { atomFamily, atomWithStorage } from "jotai/utils";
import { gitBranchAtom, hudMetricsAtom, omcStateAtom } from "@/atoms/hud";
import {
  INITIAL_FAVORITE_TAB_IDS,
  INITIAL_FOCUSED_TAB_ID,
  INITIAL_SPACES,
  INITIAL_TABS,
} from "@/lib/constants";
import { invokeTauri, isTauriRuntimeAvailable } from "@/lib/tauri";
import { disposeTerminalCache } from "@/lib/terminal-cache";
import type { AIProvider, Space, Tab } from "@/types";

export const spacesAtom = atomWithStorage<Space[]>("terminai:spaces", []);
export const tabCwdsAtom = atomWithStorage<Record<string, string>>("terminai:tab-cwds", {});

export const tabAtom = atomFamily((_id: string) => atom<Tab | null>(null));

interface TabMetadata {
  name: string;
  provider: AIProvider;
}
export const tabMetadataAtom = atomWithStorage<Record<string, TabMetadata>>(
  "terminai:tab-metadata",
  {},
);

export const focusedTabIdAtom = atomWithStorage<string | null>("terminai:focused-tab-id", null);

export const favoriteTabIdsAtom = atomWithStorage<string[]>("terminai:favorite-tab-ids", []);

export const focusedTabAtom = atom((get) => {
  const focusedTabId = get(focusedTabIdAtom);
  return focusedTabId ? get(tabAtom(focusedTabId)) : null;
});

interface CwdEditorState {
  open: boolean;
  tabId: string | null;
}

export const cwdEditorAtom = atom<CwdEditorState>({ open: false, tabId: null });

export const allTabsAtom = atom((get) => {
  const spaces = get(spacesAtom);
  const tabs: Tab[] = [];

  for (const space of spaces) {
    for (const id of space.tabIds) {
      const tab = get(tabAtom(id));
      if (tab) {
        tabs.push(tab);
      }
    }
  }

  return tabs;
});

export const initializeWorkspaceAtom = atom(null, (get, set) => {
  const spaces = get(spacesAtom);
  const tabCwds = get(tabCwdsAtom);
  if (spaces.length > 0) {
    const nextTabCwds = { ...tabCwds };
    let shouldPersistCwds = false;
    let hasFocused = false;
    const focusedTabId = get(focusedTabIdAtom);
    const tabMetadata = get(tabMetadataAtom);
    const now = Date.now();

    for (const space of spaces) {
      for (const id of space.tabIds) {
        const existing = get(tabAtom(id));
        if (existing) {
          const persistedCwd = tabCwds[id];
          if (!existing.cwd || (persistedCwd && existing.cwd !== persistedCwd)) {
            set(tabAtom(id), { ...existing, cwd: persistedCwd ?? existing.cwd ?? "." });
          }
          if (!persistedCwd && existing.cwd) {
            nextTabCwds[id] = existing.cwd;
            shouldPersistCwds = true;
          }
          if (focusedTabId === id) {
            hasFocused = true;
          }
          continue;
        }

        const meta = tabMetadata[id];
        const provider: AIProvider = meta
          ? meta.provider
          : id.includes("gemini")
            ? "gemini-cli"
            : id.includes("codex")
              ? "codex-cli"
              : "claude-code";
        const name = meta ? meta.name : id.replace(/^tab-/, "");

        const fallback: Tab = {
          id,
          name,
          provider,
          cwd: tabCwds[id] ?? ".",
          spaceId: space.id,
          isFavorite: get(favoriteTabIdsAtom).includes(id),
          createdAt: now,
          lastActivityAt: now,
          isFocused: focusedTabId === id,
          processStatus: "idle",
          sessionId: null,
        };
        if (fallback.isFocused) {
          hasFocused = true;
        }
        set(tabAtom(id), fallback);
        nextTabCwds[id] = fallback.cwd;
        shouldPersistCwds = true;
      }
    }

    if (shouldPersistCwds) {
      set(tabCwdsAtom, nextTabCwds);
    }

    if (!hasFocused) {
      const fallbackTabId = spaces.find((space) => space.tabIds.length > 0)?.tabIds[0] ?? null;
      set(focusedTabIdAtom, fallbackTabId);
      if (fallbackTabId) {
        const tab = get(tabAtom(fallbackTabId));
        if (tab) {
          set(tabAtom(fallbackTabId), { ...tab, isFocused: true });
        }
      }
    }

    return;
  }

  set(spacesAtom, INITIAL_SPACES);
  set(favoriteTabIdsAtom, INITIAL_FAVORITE_TAB_IDS);
  set(focusedTabIdAtom, INITIAL_FOCUSED_TAB_ID);
  set(tabCwdsAtom, Object.fromEntries(INITIAL_TABS.map((tab) => [tab.id, tab.cwd || "."])));
  set(
    tabMetadataAtom,
    Object.fromEntries(
      INITIAL_TABS.map((tab) => [tab.id, { name: tab.name, provider: tab.provider }]),
    ),
  );

  for (const tab of INITIAL_TABS) {
    set(tabAtom(tab.id), tab);
  }
});

export const toggleSpaceCollapsedAtom = atom(null, (get, set, spaceId: string) => {
  const spaces = get(spacesAtom);
  set(
    spacesAtom,
    spaces.map((space) =>
      space.id === spaceId ? { ...space, isCollapsed: !space.isCollapsed } : space,
    ),
  );
});

export const focusTabAtom = atom(null, (get, set, tabId: string) => {
  const spaces = get(spacesAtom);
  const prevFocusedTabId = get(focusedTabIdAtom);

  if (prevFocusedTabId) {
    const prevTab = get(tabAtom(prevFocusedTabId));
    if (prevTab) {
      set(tabAtom(prevFocusedTabId), { ...prevTab, isFocused: false });
    }
  }

  const nextTab = get(tabAtom(tabId));
  if (!nextTab) {
    return;
  }

  set(tabAtom(tabId), {
    ...nextTab,
    isFocused: true,
    lastActivityAt: Date.now(),
  });
  set(focusedTabIdAtom, tabId);

  for (const space of spaces) {
    for (const id of space.tabIds) {
      if (id !== tabId && id !== prevFocusedTabId) {
        const tab = get(tabAtom(id));
        if (tab?.isFocused) {
          set(tabAtom(id), { ...tab, isFocused: false });
        }
      }
    }
  }
});

interface CreateTabPayload {
  spaceId: string;
  provider: AIProvider;
  cwd?: string;
}

function providerToDefaultName(provider: AIProvider): string {
  if (provider === "claude-code") return "new-claude-tab";
  if (provider === "codex-cli") return "new-codex-tab";
  if (provider === "gemini-cli") return "new-gemini-tab";
  return "new-custom-tab";
}

export const createTabAtom = atom(null, (get, set, payload: CreateTabPayload) => {
  const newTabId = `tab-${crypto.randomUUID()}`;
  const now = Date.now();

  const nextTab: Tab = {
    id: newTabId,
    name: providerToDefaultName(payload.provider),
    provider: payload.provider,
    cwd: payload.cwd?.trim() || ".",
    spaceId: payload.spaceId,
    isFavorite: false,
    createdAt: now,
    lastActivityAt: now,
    isFocused: false,
    processStatus: "idle",
    sessionId: null,
  };

  set(tabAtom(newTabId), nextTab);
  set(tabCwdsAtom, { ...get(tabCwdsAtom), [newTabId]: nextTab.cwd });
  set(tabMetadataAtom, {
    ...get(tabMetadataAtom),
    [newTabId]: { name: nextTab.name, provider: nextTab.provider },
  });

  const spaces = get(spacesAtom);
  set(
    spacesAtom,
    spaces.map((space) =>
      space.id === payload.spaceId
        ? { ...space, tabIds: [...space.tabIds, newTabId], isCollapsed: false }
        : space,
    ),
  );

  set(focusTabAtom, newTabId);
});

interface MoveTabPayload {
  tabId: string;
  toSpaceId: string;
  toIndex: number;
}

export const moveTabAtom = atom(null, (get, set, payload: MoveTabPayload) => {
  const targetTab = get(tabAtom(payload.tabId));
  if (!targetTab) {
    return;
  }

  const spaces = get(spacesAtom);
  const nextSpaces = spaces.map((space) => ({
    ...space,
    tabIds: space.tabIds.filter((id) => id !== payload.tabId),
  }));

  const targetSpace = nextSpaces.find((space) => space.id === payload.toSpaceId);
  if (!targetSpace) {
    return;
  }

  const safeIndex = Math.max(0, Math.min(payload.toIndex, targetSpace.tabIds.length));
  targetSpace.tabIds.splice(safeIndex, 0, payload.tabId);
  targetSpace.isCollapsed = false;

  set(spacesAtom, nextSpaces);
  set(tabAtom(payload.tabId), { ...targetTab, spaceId: payload.toSpaceId });
});

export const renameTabAtom = atom(null, (get, set, payload: { tabId: string; name: string }) => {
  const tab = get(tabAtom(payload.tabId));
  if (!tab) {
    return;
  }

  const nextName = payload.name.trim();
  if (!nextName) {
    return;
  }

  set(tabAtom(payload.tabId), { ...tab, name: nextName });
  const meta = get(tabMetadataAtom);
  set(tabMetadataAtom, { ...meta, [payload.tabId]: { name: nextName, provider: tab.provider } });
});

export const setTabCwdAtom = atom(null, (get, set, payload: { tabId: string; cwd: string }) => {
  const tab = get(tabAtom(payload.tabId));
  if (!tab) {
    return;
  }

  const nextCwd = payload.cwd.trim() || ".";
  set(tabAtom(payload.tabId), {
    ...tab,
    cwd: nextCwd,
    sessionId: null,
    processStatus: "idle",
    lastActivityAt: Date.now(),
  });
  set(tabCwdsAtom, { ...get(tabCwdsAtom), [payload.tabId]: nextCwd });
});

export const openCwdEditorAtom = atom(null, (_get, set, tabId: string) => {
  set(cwdEditorAtom, { open: true, tabId });
});

export const closeCwdEditorAtom = atom(null, (_get, set) => {
  set(cwdEditorAtom, { open: false, tabId: null });
});

export const cwdEditorTabAtom = atom((get) => {
  const { tabId } = get(cwdEditorAtom);
  return tabId ? get(tabAtom(tabId)) : null;
});

export const duplicateTabAtom = atom(null, (get, set, tabId: string) => {
  const sourceTab = get(tabAtom(tabId));
  if (!sourceTab) {
    return;
  }

  const newTabId = `tab-${crypto.randomUUID()}`;
  const now = Date.now();
  const duplicated: Tab = {
    ...sourceTab,
    id: newTabId,
    name: `${sourceTab.name}-copy`,
    isFocused: false,
    sessionId: null,
    processStatus: "idle",
    createdAt: now,
    lastActivityAt: now,
  };

  set(tabAtom(newTabId), duplicated);
  set(tabCwdsAtom, { ...get(tabCwdsAtom), [newTabId]: duplicated.cwd });
  set(tabMetadataAtom, {
    ...get(tabMetadataAtom),
    [newTabId]: { name: duplicated.name, provider: duplicated.provider },
  });

  const spaces = get(spacesAtom);
  const nextSpaces = spaces.map((space) => {
    if (space.id !== sourceTab.spaceId) {
      return space;
    }

    const sourceIndex = space.tabIds.indexOf(tabId);
    if (sourceIndex < 0) {
      return space;
    }

    const nextTabIds = [...space.tabIds];
    nextTabIds.splice(sourceIndex + 1, 0, newTabId);
    return { ...space, tabIds: nextTabIds, isCollapsed: false };
  });

  set(spacesAtom, nextSpaces);
  set(focusTabAtom, newTabId);
});

export const closeTabAtom = atom(null, (get, set, tabId: string) => {
  const targetTab = get(tabAtom(tabId));
  if (!targetTab) {
    return;
  }

  const spaces = get(spacesAtom);
  const favoriteTabIds = get(favoriteTabIdsAtom);
  const focusedTabId = get(focusedTabIdAtom);

  const nextSpaces = spaces.map((space) => ({
    ...space,
    tabIds: space.tabIds.filter((id) => id !== tabId),
  }));

  set(spacesAtom, nextSpaces);
  set(
    favoriteTabIdsAtom,
    favoriteTabIds.filter((id) => id !== tabId),
  );
  set(tabAtom(tabId), null);
  tabAtom.remove(tabId);
  if (targetTab.sessionId) {
    // Kill the backend PTY session to prevent zombie processes
    if (isTauriRuntimeAvailable()) {
      void invokeTauri<void>("kill_session", { sessionId: targetTab.sessionId }).catch(() => {});
    }
    hudMetricsAtom.remove(targetTab.sessionId);
    omcStateAtom.remove(targetTab.sessionId);
    gitBranchAtom.remove(targetTab.sessionId);
  }
  disposeTerminalCache(tabId);
  const nextTabCwds = { ...get(tabCwdsAtom) };
  delete nextTabCwds[tabId];
  set(tabCwdsAtom, nextTabCwds);
  const nextTabMetadata = { ...get(tabMetadataAtom) };
  delete nextTabMetadata[tabId];
  set(tabMetadataAtom, nextTabMetadata);

  if (focusedTabId !== tabId) {
    return;
  }

  const sourceSpace = nextSpaces.find((space) => space.id === targetTab.spaceId);
  const fallbackInSpace = sourceSpace?.tabIds[sourceSpace.tabIds.length - 1] ?? null;
  const fallbackGlobal = nextSpaces.find((space) => space.tabIds.length > 0)?.tabIds[0] ?? null;
  const nextFocusedTabId = fallbackInSpace ?? fallbackGlobal;

  if (nextFocusedTabId) {
    set(focusTabAtom, nextFocusedTabId);
    return;
  }

  set(focusedTabIdAtom, null);
});
