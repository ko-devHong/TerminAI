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

export const initializeWorkspaceAtom = atom(null, (get, set) => {
  if (get(spacesAtom).length > 0) {
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
