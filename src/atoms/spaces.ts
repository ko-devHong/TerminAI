import { atom } from "jotai";
import { atomFamily, atomWithStorage } from "jotai/utils";

import {
  INITIAL_FAVORITE_TAB_IDS,
  INITIAL_FOCUSED_TAB_ID,
  INITIAL_SPACES,
  INITIAL_TABS,
} from "@/lib/constants";
import type { AIProvider, Space, Tab } from "@/types";

export const spacesAtom = atomWithStorage<Space[]>("terminai:spaces", []);

export const tabAtom = atomFamily((_id: string) => atom<Tab | null>(null));

export const focusedTabIdAtom = atomWithStorage<string | null>("terminai:focused-tab-id", null);

export const favoriteTabIdsAtom = atomWithStorage<string[]>("terminai:favorite-tab-ids", []);

export const focusedTabAtom = atom((get) => {
  const focusedTabId = get(focusedTabIdAtom);
  return focusedTabId ? get(tabAtom(focusedTabId)) : null;
});

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
  if (spaces.length > 0) {
    let hasFocused = false;
    const focusedTabId = get(focusedTabIdAtom);
    const now = Date.now();

    for (const space of spaces) {
      for (const id of space.tabIds) {
        const existing = get(tabAtom(id));
        if (existing) {
          if (focusedTabId === id) {
            hasFocused = true;
          }
          continue;
        }

        const provider: AIProvider = id.includes("gemini")
          ? "gemini-cli"
          : id.includes("codex")
            ? "codex-cli"
            : "claude-code";

        const fallback: Tab = {
          id,
          name: id.replace(/^tab-/, ""),
          provider,
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
      }
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
    spaceId: payload.spaceId,
    isFavorite: false,
    createdAt: now,
    lastActivityAt: now,
    isFocused: false,
    processStatus: "idle",
    sessionId: null,
  };

  set(tabAtom(newTabId), nextTab);

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
