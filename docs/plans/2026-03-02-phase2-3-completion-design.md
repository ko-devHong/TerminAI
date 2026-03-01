# Phase 2-3 Completion Design

## Scope
AGENTS.md의 미구현 항목 전부 구현 + UI/UX 보완.

## Implementation Order

### 1. Terminal Instance Caching
- Global `Map<tabId, TerminalCache>` outside React lifecycle
- Tab switch: DOM detach/reattach, keep xterm instance alive
- Inactive tabs continue receiving `terminal.write()` via Tauri events
- Only dispose on tab close

### 2. Motion Animations
- Sidebar tab list: `motion.div` + `layout` + `AnimatePresence`
- Space collapse/expand: `motion.div` spring height/opacity
- HUD expand/collapse: `motion.div` spring transition
- Terminal tab switch: `AnimatePresence mode="wait"` crossfade
- Command Palette: `motion.div` scale + opacity entrance

### 3. HUD Metric Visualization
- Remove hardcoded dummy values
- Wire `hudMetricsAtom` to real Tauri events
- Context window → `<Progress>` bar component
- Real-time session duration counter

### 4. Theme System
- Toggle `dark`/`light` class on `<html>`
- Define light theme CSS variables in index.css
- All components reference CSS variables

### 5. Rust Provider Trait + Metric Parsing
- Define `MetricParser` trait
- Implement Claude/Codex/Gemini parsers
- Emit `metrics-{sessionId}` events from PTY reader
- Frontend listens and updates `hudMetricsAtom`

### 6. Cleanup
- Remove unused App.css
- Apply `terminalFontSizeAtom` to terminal
- Improve Tooltip usage
