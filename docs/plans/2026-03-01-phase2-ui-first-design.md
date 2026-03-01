# TerminAI Phase 2-First UI Design

## Scope
- Implement Phase 2-first frontend shell before PTY integration.
- Include xterm.js rendering with mock output only.
- Exclude Rust session spawn/kill, Tauri events, and real HUD metric parsing.

## Goals
- Replace template UI with TerminAI layout: Sidebar, Main terminal area, HUD panel.
- Build scalable state model with Jotai for spaces/tabs/focus/settings.
- Keep architecture aligned with AGENTS.md so Phase 1 backend integration can be attached with minimal refactor.

## Architecture
- Use feature-oriented component split:
  - `components/sidebar`: `Sidebar`, `Favorites`, `SpaceGroup`, `TabItem`, `NewTabButton`
  - `components/terminal`: `TerminalView`
  - `components/hud`: `HUDPanel`
- Keep data contracts in `src/types/index.ts`.
- Keep provider mapping in `src/lib/providers.ts`.
- Keep state modules in `src/atoms/`.

## State Design
- `spacesAtom` (`atomWithStorage`): persisted spaces with ordered `tabIds`.
- `tabAtom` (`atomFamily`): per-tab isolated state.
- `focusedTabIdAtom`: active tab id.
- `favoriteTabIdsAtom`: favorite tab ids.
- `focusedTabAtom`: derived active tab data.
- `hudExpandModeAtom`: `compact | expanded | hidden`.
- `sidebarWidthAtom`, `sidebarCollapsedAtom`: sidebar settings.
- Write atoms:
  - `initializeWorkspaceAtom`: seeds default spaces/tabs when storage is empty.
  - `focusTabAtom`: updates focused tab and `isFocused` flags.
  - `createTabAtom`: appends new tab to selected space.
  - `toggleSpaceCollapsedAtom`: toggles space expansion state.

## UI Behavior
- Sidebar
  - Search placeholder row.
  - Favorites section with pinned tabs.
  - Space sections with collapse toggle.
  - New tab dropdown (Claude/Codex/Gemini) using shadcn dropdown menu.
  - Resizable width handle (180px-360px).
- Main
  - `TerminalView` mounts one xterm instance.
  - WebGL addon attempted; fallback to default renderer if unavailable.
  - Active tab change clears and prints mock session header.
- HUD
  - Cycles on click: `compact -> expanded -> hidden -> compact`.
  - Displays active tab provider and mock metrics.

## Error Handling
- Guard missing tab/space references in render paths.
- Wrap WebGL initialization in `try/catch` fallback.

## Verification
- Build gate: `bun run build`.
- Manual check:
  - tab focus switching
  - new tab creation
  - space collapse toggle
  - HUD mode cycle
  - sidebar resizing

## Commit Plan
- Single commit for this phase:
  - `feat: build phase-2-first UI shell with jotai state and xterm mock`
