import { atomWithStorage } from "jotai/utils";

export const sidebarWidthAtom = atomWithStorage<number>("terminai:sidebar-width", 240);
export const sidebarCollapsedAtom = atomWithStorage<boolean>("terminai:sidebar-collapsed", false);
export const terminalFontSizeAtom = atomWithStorage<number>("terminai:terminal-font-size", 14);
export const themeAtom = atomWithStorage<"dark" | "light">("terminai:theme", "dark");
export const defaultCwdAtom = atomWithStorage<string>("terminai:default-cwd", ".");
