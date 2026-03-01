import { type Space, type Tab } from "@/types";

export const INITIAL_SPACES: Space[] = [
  {
    id: "space-work",
    name: "Work",
    color: "#10B981",
    tabIds: ["tab-auth-refactor", "tab-api-test"],
    isCollapsed: false,
  },
  {
    id: "space-personal",
    name: "Personal",
    color: "#3B82F6",
    tabIds: ["tab-playground"],
    isCollapsed: false,
  },
];

const now = Date.now();

export const INITIAL_TABS: Tab[] = [
  {
    id: "tab-auth-refactor",
    name: "auth-refactor",
    provider: "claude-code",
    spaceId: "space-work",
    isFavorite: true,
    createdAt: now,
    lastActivityAt: now,
    isFocused: true,
    processStatus: "running",
    sessionId: null,
  },
  {
    id: "tab-api-test",
    name: "api-test",
    provider: "codex-cli",
    spaceId: "space-work",
    isFavorite: false,
    createdAt: now,
    lastActivityAt: now,
    isFocused: false,
    processStatus: "processing",
    sessionId: null,
  },
  {
    id: "tab-playground",
    name: "playground",
    provider: "gemini-cli",
    spaceId: "space-personal",
    isFavorite: false,
    createdAt: now,
    lastActivityAt: now,
    isFocused: false,
    processStatus: "idle",
    sessionId: null,
  },
];

export const INITIAL_FAVORITE_TAB_IDS: string[] = ["tab-auth-refactor"];
export const INITIAL_FOCUSED_TAB_ID = "tab-auth-refactor";
