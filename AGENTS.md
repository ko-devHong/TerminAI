## Project Overview

**TerminAI** — 여러 AI CLI 도구(claude-code, codex-cli, gemini-cli 등)를 하나의 앱에서 통합 관리하는 크로스플랫폼(Mac/Windows) 데스크톱 애플리케이션.

**핵심 철학**: "Arc Browser의 사이드바 UX + Claude HUD의 실시간 가시성"

---

## Architecture

### Tech Stack
- **Framework**: Tauri v2 (Rust backend + Web frontend)
- **Frontend**: React 19 + TypeScript + Vite
- **UI Components**: shadcn/ui (Radix UI headless primitives + Tailwind CSS)
- **Styling**: Tailwind CSS v4
- **Animation**: Motion (framer-motion) — 단, 성능 저하 시 CSS transitions/animations으로 대체
- **Icons**: Lucide React (shadcn/ui 기본 아이콘)
- **State**: Jotai + jotai/utils (atomFamily, atomWithStorage, selectAtom, splitAtom, loadable)
- **Terminal**: xterm.js + @xterm/addon-fit + @xterm/addon-webgl
- **Drag & Drop**: @dnd-kit/core + @dnd-kit/sortable
- **Package Manager**: bun
- **PTY (Rust)**: portable-pty (크로스플랫폼: Unix PTY + Windows ConPTY)
- **Async Runtime (Rust)**: tokio

### Directory Structure
```
TerminAI/
├── src/                          # React Frontend
│   ├── main.tsx                  # Entry point
│   ├── App.tsx                   # Root layout (Sidebar + Main + HUD)
│   ├── components/
│   │   ├── sidebar/
│   │   │   ├── Sidebar.tsx       # 사이드바 컨테이너
│   │   │   ├── SpaceGroup.tsx    # Space 접기/펼치기 그룹
│   │   │   ├── TabItem.tsx       # 개별 탭 (상태 아이콘 포함)
│   │   │   ├── Favorites.tsx     # 고정된 AI 목록
│   │   │   └── NewTabButton.tsx  # AI 선택 드롭다운
│   │   ├── terminal/
│   │   │   ├── TerminalView.tsx  # xterm.js 래퍼
│   │   │   └── TerminalTabs.tsx  # 탭 바 (선택적)
│   │   ├── hud/
│   │   │   ├── HUDPanel.tsx      # 하단 고정 패널
│   │   │   ├── MetricBar.tsx     # 프로그레스 바 컴포넌트
│   │   │   └── ToolActivity.tsx  # 현재 실행중인 도구 표시
│   │   └── ui/                   # shadcn/ui 컴포넌트 (npx shadcn@latest add)
│   │       ├── button.tsx
│   │       ├── context-menu.tsx   # Radix ContextMenu
│   │       ├── dropdown-menu.tsx  # Radix DropdownMenu
│   │       ├── tooltip.tsx        # Radix Tooltip
│   │       ├── scroll-area.tsx    # Radix ScrollArea
│   │       ├── separator.tsx
│   │       ├── dialog.tsx         # Radix Dialog (Command Palette용)
│   │       ├── command.tsx        # cmdk (Command Palette)
│   │       └── progress.tsx       # HUD 프로그레스 바
│   ├── atoms/                     # Jotai atoms
│   │   ├── spaces.ts             # Space/Tab 구조 atoms
│   │   ├── sessions.ts           # AI 세션 프로세스 상태 atoms
│   │   └── hud.ts                # HUD 메트릭 atoms
│   ├── hooks/
│   │   ├── useTauriEvent.ts      # Tauri 이벤트 리스너 훅
│   │   ├── useTerminal.ts        # xterm.js 생명주기 관리
│   │   └── useHotkeys.ts         # 키보드 단축키
│   ├── lib/
│   │   ├── tauri.ts              # Tauri invoke/listen 래퍼
│   │   ├── providers.ts          # AI Provider 설정 맵
│   │   ├── constants.ts          # 상수
│   │   └── utils.ts              # cn() 헬퍼 (shadcn/ui용 clsx + twMerge)
│   └── types/
│       └── index.ts              # 모든 TypeScript 타입
│
├── src-tauri/                    # Rust Backend
│   ├── src/
│   │   ├── main.rs               # Entry point
│   │   ├── lib.rs                # Tauri plugin/command 등록
│   │   ├── commands.rs           # Tauri command 핸들러 (spawn/write/resize/kill/detect)
│   │   ├── provider.rs           # Provider 커맨드 빌더 + PATH 감지
│   │   └── state.rs              # AppState + PtySession
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── biome.json                    # Biome lint/format/check 설정 (strict)
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── components.json              # shadcn/ui 설정 (경로, 스타일, 별칭)
├── docs/plans/                  # 설계 문서
├── tsconfig.json
└── AGENTS.md
```

---

## Data Model

### TypeScript Types (`src/types/index.ts`)

```typescript
// === AI Provider ===
type AIProvider = 'claude-code' | 'codex-cli' | 'gemini-cli' | 'custom';

interface ProviderConfig {
  id: AIProvider;
  label: string;                    // "Claude Code"
  command: string;                  // "claude"
  icon: string;                     // Lucide icon name
  color: string;                    // 브랜드 색상
  detectable: boolean;              // PATH 자동 감지 여부
}

// === Tab (UI 상태와 프로세스 상태 분리) ===
interface Tab {
  id: string;
  name: string;
  provider: AIProvider;
  spaceId: string;                  // 소속 Space ID
  isFavorite: boolean;              // Favorites 고정 여부
  createdAt: number;                // timestamp
  lastActivityAt: number;           // timestamp

  // UI 상태 (하나만 focused 가능)
  isFocused: boolean;

  // 프로세스 상태 (focused 여부와 독립)
  processStatus: 'idle' | 'running' | 'processing' | 'error' | 'disconnected';
  sessionId: string | null;         // Rust PTY 세션 ID
}

// === Space ===
interface Space {
  id: string;
  name: string;
  color: string;                    // Arc 스타일 accent
  tabIds: string[];                 // 정렬된 탭 ID
  isCollapsed: boolean;
}

// === HUD Metrics ===
interface HUDMetrics {
  provider: AIProvider;
  model: string | null;              // "opus-4", "gpt-4o", "gemini-2.0-pro"
  contextWindow: { used: number; total: number } | null;
  tokens: { input: number; output: number } | null;
  cost: number | null;               // 누적 비용 (USD)
  rateLimit: { remaining: number; total: number } | null;
  activeTools: string[];             // ["Read", "Edit", "Grep"]
  sessionDuration: number;           // seconds
  connectionStatus: 'connected' | 'disconnected' | 'error';
}
```

### Jotai Atoms (`src/atoms/`)

**사용 유틸리티** (`jotai/utils`):
| 유틸리티 | 용도 | 적용 위치 |
|----------|------|----------|
| `atomFamily` | ID 기반 독립 atom 생성 | 탭, 세션, 메트릭 (핵심) |
| `atomWithStorage` | localStorage 자동 동기화 | 사이드바 너비, HUD 모드, 테마 등 사용자 설정 |
| `selectAtom` | atom 일부만 구독 (===비교) | Tab에서 processStatus만 구독 |
| `splitAtom` | 배열 atom → 개별 atom 분리 | Space의 tabIds 리스트 렌더링 |
| `loadable` | async atom의 loading/error 래핑 | AI CLI 감지 (detect_providers) |

```typescript
// === atoms/spaces.ts ===
import { atom } from 'jotai';
import { atomFamily, atomWithStorage, splitAtom } from 'jotai/utils';

// 전체 Space 목록 — atomWithStorage로 앱 재시작 시 복원
export const spacesAtom = atomWithStorage<Space[]>('terminai:spaces', []);

// splitAtom: 배열 내 개별 Space가 바뀌어도 다른 Space 컴포넌트는 리렌더 없음
export const spacesAtomsAtom = splitAtom(spacesAtom);

// Tab별 독립 atom — atomFamily로 ID 기반 구독
export const tabAtom = atomFamily((id: string) =>
  atom<Tab | null>(null)
);

// 현재 포커스된 탭 ID
export const focusedTabIdAtom = atom<string | null>(null);

// Favorites (고정된 탭 ID 목록) — 영속화
export const favoriteTabIdsAtom = atomWithStorage<string[]>('terminai:favorites', []);

// derived: 현재 포커스된 탭
export const focusedTabAtom = atom((get) => {
  const id = get(focusedTabIdAtom);
  return id ? get(tabAtom(id)) : null;
});

// === atoms/sessions.ts ===
import { atom } from 'jotai';
import { atomFamily, selectAtom } from 'jotai/utils';

// 세션별 프로세스 상태
export const sessionStatusAtom = atomFamily((_sessionId: string) =>
  atom<'idle' | 'running' | 'error' | 'disconnected'>('idle')
);

// selectAtom: Tab의 processStatus만 구독 (이름 변경 등에 리렌더 안됨)
export const tabProcessStatusAtom = (tabId: string) =>
  selectAtom(tabAtom(tabId), (tab) => tab?.processStatus ?? 'idle');

// === atoms/hud.ts ===
import { atom } from 'jotai';
import { atomFamily, atomWithStorage } from 'jotai/utils';

// HUD 확장 모드 — 사용자 설정 영속화
export const hudExpandModeAtom = atomWithStorage<'compact' | 'expanded' | 'hidden'>(
  'terminai:hud-mode', 'compact'
);

// 세션별 메트릭 (고빈도 업데이트 — 독립 atom 필수)
export const hudMetricsAtom = atomFamily((_sessionId: string) =>
  atom<HUDMetrics | null>(null)
);

// derived: 활성 탭의 메트릭
export const activeHudMetricsAtom = atom((get) => {
  const tab = get(focusedTabAtom);
  if (!tab?.sessionId) return null;
  return get(hudMetricsAtom(tab.sessionId));
});

// === atoms/settings.ts ===
import { atomWithStorage } from 'jotai/utils';

export const sidebarWidthAtom = atomWithStorage('terminai:sidebar-width', 240);
export const sidebarCollapsedAtom = atomWithStorage('terminai:sidebar-collapsed', false);
export const terminalFontSizeAtom = atomWithStorage('terminai:terminal-font-size', 14);
export const themeAtom = atomWithStorage<'dark' | 'light'>('terminai:theme', 'dark');

// === atoms/providers.ts ===
import { atom } from 'jotai';
import { loadable } from 'jotai/utils';

// async atom: Rust에서 AI CLI 감지 결과
const detectProvidersBaseAtom = atom(async () => {
  const result = await invoke<DetectedProvider[]>('detect_providers');
  return result;
});

// loadable: 로딩/에러 상태를 컴포넌트에서 분기 처리
export const detectedProvidersAtom = loadable(detectProvidersBaseAtom);
// 사용: const providers = useAtomValue(detectedProvidersAtom);
// providers.state === 'loading' | 'hasData' | 'hasError'
```

**Jotai 성능 원칙**:
- `atomFamily`: 탭/세션별 독립 구독. 탭 20개 중 1개 상태 변경 → 나머지 19개 리렌더 없음.
- `selectAtom`: 큰 atom에서 필요한 필드만 구독. TabItem이 상태 아이콘만 그릴 때 `selectAtom(tabAtom(id), t => t?.processStatus)`.
- `splitAtom`: Space 배열에서 개별 Space를 독립 atom으로 분리. 리스트 렌더 최적화.
- `atomWithStorage`: 사용자 설정을 localStorage에 자동 영속화. 별도 save/load 로직 불필요.
- `loadable`: async 작업(CLI 감지 등)의 loading/error 상태를 선언적으로 처리.
- `useAtomValue` (읽기 전용) / `useSetAtom` (쓰기 전용) 분리. `useAtom()`은 읽기+쓰기 모두 필요할 때만.

### Rust Types (`src-tauri/src/state.rs`)

```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct AppState {
    pub sessions: Arc<Mutex<HashMap<String, Arc<PtySession>>>>,
}

pub struct PtySession {
    pub id: String,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    pub status: Arc<Mutex<SessionStatus>>,
}

pub enum SessionStatus {
    Running,
    Disconnected,
    Error,
}
```

---

## Core UI/UX

### 1. Arc-Style Sidebar (왼쪽 패널)

```
┌──────────────────────────────────┐
│  🔍 Search / Cmd+K               │  ← Command Palette
├──────────────────────────────────┤
│  ★ Favorites                     │  ← 드래그로 고정, 전체 공유
│   Claude Code              ● ON  │
│   Gemini CLI               ○     │
├──────────────────────────────────┤
│  ▼ Work                          │  ← Space (접기/펼치기)
│   ● auth-refactor (Claude)       │     ● running (초록 펄스)
│   ◐ api-test (Codex)             │     ◐ processing (노랑 스피너)
│   ○ playground (Gemini)          │     ○ idle (회색)
├──────────────────────────────────┤
│  ▶ Personal                      │  ← 접힌 Space
├──────────────────────────────────┤
│  + New Space                     │
└──────────────────────────────────┘
```

**상태 아이콘** (Lucide 아이콘 + CSS):
| 상태 | 아이콘 | 색상 | 애니메이션 |
|------|--------|------|-----------|
| Running (활성) | `Circle` (filled) | `#10B981` emerald | 2s pulse |
| Processing | `Loader2` | `#F59E0B` amber | CSS spin |
| Idle | `Circle` (outline) | `#71717A` zinc | 없음 |
| Error | `AlertCircle` | `#EF4444` red | 없음 |

**인터랙션** (shadcn/ui + Radix UI):
- 드래그 앤 드롭: `@dnd-kit` — 탭을 Space 간 이동, Favorites로 고정
- 우클릭: `<ContextMenu>` (shadcn/ui) — Rename, Duplicate, Close, Clear History
- 더블클릭: 탭 이름 인라인 편집
- 새 탭 생성: `<DropdownMenu>` (shadcn/ui) — AI Provider 선택
- Command Palette: `<CommandDialog>` (shadcn/ui, cmdk 기반) — `Cmd+K`
- 사이드바 스크롤: `<ScrollArea>` (shadcn/ui) — 커스텀 스크롤바
- 사이드바 리사이즈: 드래그 핸들 (최소 180px, 최대 360px)
- 사이드바 토글: `Cmd+\` 또는 `Ctrl+\`
- 툴팁: `<Tooltip>` (shadcn/ui) — 탭 hover 시 상세 정보

**단축키**:
| 단축키 | 동작 |
|--------|------|
| `Cmd+K` | Command Palette |
| `Cmd+T` | 현재 Space에 새 탭 |
| `Cmd+W` | 현재 탭 닫기 |
| `Cmd+1~9` | Favorite AI 빠른 접근 |
| `Cmd+Shift+[` / `]` | Space 전환 |
| `Cmd+Tab` | 최근 탭 전환 |
| `Cmd+\` | 사이드바 토글 |

### 2. Terminal Area (중앙)

- 각 탭 = 독립 xterm.js 인스턴스
- 탭 전환 시 터미널 인스턴스 **캐싱** (DOM detach, 버퍼 유지)
- WebGL 렌더러 사용 (`@xterm/addon-webgl`) — GPU 가속
- 자동 리사이즈 (`@xterm/addon-fit`)
- 검색: `Cmd+F`

### 3. HUD Panel (하단 고정)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Claude Code (opus-4)  │ Context ████████░░ 78%  │ $1.23  │ 1h 23m │  ← 기본 (1줄)
├─────────────────────────────────────────────────────────────────────┤  ← 확장 시 (클릭/Cmd+J)
│ ◐ Edit: auth.ts  │  ✓ Read ×3  │  ✓ Grep ×2  │  Agent: running   │
│ Rate: 45/60 remaining  │  Tokens: 12.3K in / 8.1K out              │
└─────────────────────────────────────────────────────────────────────┘
```

**AI별 표시 메트릭**:

| 항목 | Claude Code | Codex CLI | Gemini CLI |
|------|-------------|-----------|------------|
| Model | opus/sonnet/haiku | gpt-4o 등 | gemini-2.0-pro 등 |
| Context | ✅ (바) | - | ✅ (바) |
| Tokens | ✅ | ✅ | ✅ |
| Cost | ✅ | ✅ | ✅ |
| Rate Limit | ✅ | ✅ | ✅ |
| Active Tools | ✅ | ✅ (파일 작업) | - |
| Sub-agents | ✅ | - | - |

**HUD 동작**:
- 기본 1줄 compact → 클릭 또는 `Cmd+J`로 확장 → 다시 누르면 완전히 숨김
- 3단계: compact → expanded → hidden
- 비활성 탭 선택 시 해당 탭의 메트릭으로 자동 전환

---

## Rust Backend

### Tauri Commands (`src-tauri/src/commands.rs`)

```rust
#[tauri::command]
async fn spawn_session(
    state: tauri::State<'_, AppState>,
    provider: String,
    cwd: String,
) -> Result<String, String>;  // Returns session_id

#[tauri::command]
async fn write_to_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String>;

#[tauri::command]
async fn resize_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String>;

#[tauri::command]
async fn kill_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String>;

#[tauri::command]
async fn detect_providers() -> Result<Vec<DetectedProvider>, String>;
```

### Tauri Events (Backend → Frontend 스트리밍)

```rust
// PTY 출력을 프론트엔드로 스트리밍
app_handle.emit(&format!("pty-output-{}", session_id), &batch_data)?;

// 세션 상태 변경 알림
app_handle.emit(&format!("session-status-{}", session_id), &status)?;

// 메트릭 업데이트 (변경분만)
app_handle.emit(&format!("metrics-{}", session_id), &metrics_diff)?;
```

Frontend listen 패턴:
```typescript
// hooks/useTauriEvent.ts
listen<string>(`pty-output-${sessionId}`, (event) => {
  terminal.write(event.payload);
});
```

### Provider Trait (`src-tauri/src/provider/mod.rs`)

```rust
pub trait MetricParser: Send + Sync {
    /// PTY 출력에서 메트릭 추출 시도
    fn parse_output(&mut self, data: &[u8]) -> Option<MetricUpdate>;

    /// AI CLI 실행 커맨드 생성
    fn build_command(&self, cwd: &str) -> Command;

    /// PATH에서 CLI 존재 여부 확인
    fn detect() -> Option<DetectedProvider>;
}
```

---

## Performance Strategy

### 1. 터미널 출력 배치 처리 (가장 중요)

AI CLI는 대량의 stdout을 고속으로 뱉음. 프론트엔드에 매 바이트 전송하면 병목 발생.

```rust
// src-tauri/src/pty/buffer.rs
pub struct OutputBuffer {
    data: Vec<u8>,
    last_flush: Instant,
}

impl OutputBuffer {
    const FLUSH_INTERVAL: Duration = Duration::from_millis(16); // ~60fps
    const MAX_BATCH_SIZE: usize = 64 * 1024; // 64KB

    pub fn push(&mut self, chunk: &[u8]) -> Option<Vec<u8>> {
        self.data.extend_from_slice(chunk);
        if self.data.len() >= Self::MAX_BATCH_SIZE
            || self.last_flush.elapsed() >= Self::FLUSH_INTERVAL
        {
            let batch = std::mem::take(&mut self.data);
            self.last_flush = Instant::now();
            Some(batch)
        } else {
            None
        }
    }
}
```

### 2. 터미널 인스턴스 관리

```
활성 탭:   xterm.js 인스턴스 + DOM 연결 + WebGL 렌더러
비활성 탭: xterm.js 인스턴스 유지 (버퍼 쓰기) + DOM 분리
15분 이상 비활성: 스크롤백 버퍼 축소 (10,000줄 → 2,000줄)
```

- 동시 WebGL 렌더러는 활성 탭 1개만
- 비활성 탭은 `terminal.write()`는 계속 호출 (버퍼 누적), DOM은 분리
- 탭 전환 시 DOM 재연결 + WebGL 재초기화 (150ms 이내)

### 3. HUD 메트릭 폴링 전략

```
활성 탭:     2초 간격 폴링 (Rust에서 캐싱된 값 반환)
비활성 탭:   변경 시에만 이벤트 (status 변경 등)
숨김 상태:   폴링 중지
```

Rust 쪽에서 메트릭 파싱 후 캐싱, 이전 값과 **diff만 emit**.

### 4. Animation (Motion + CSS)

**원칙**: 의미 있는 상태 전환은 Motion, 반복/장식 애니메이션은 CSS. `transform`/`opacity`만 애니메이트.

#### 컴포넌트별 Motion 사용 맵

**사이드바 탭 리스트** — `layout` + `AnimatePresence`:
```tsx
// 탭 추가/제거/재정렬 시 자연스러운 위치 이동
<AnimatePresence mode="popLayout">
  {tabIds.map((id) => (
    <motion.div
      key={id}
      layout                          // 리스트 재정렬 시 위치 애니메이션
      initial={{ opacity: 0, x: -20 }}  // 새 탭 등장
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20, transition: { duration: 0.15 } }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
    >
      <TabItem tabId={id} />
    </motion.div>
  ))}
</AnimatePresence>
```

**Space 접기/펼치기** — `animate` height:
```tsx
// Space 내 탭 목록 아코디언
<motion.div
  initial={false}
  animate={{
    height: isCollapsed ? 0 : "auto",
    opacity: isCollapsed ? 0 : 1,
  }}
  transition={{ type: "spring", stiffness: 400, damping: 25 }}
  style={{ overflow: "hidden" }}
/>
```

**HUD 패널 확장/축소** — `animate` + `layout`:
```tsx
// compact(36px) → expanded(84px) → hidden(0px)
<motion.div
  layout
  animate={{
    height: mode === 'hidden' ? 0 : mode === 'compact' ? 36 : 84,
    opacity: mode === 'hidden' ? 0 : 1,
  }}
  transition={{ type: "spring", stiffness: 500, damping: 30 }}
/>
```

**탭 전환 — 터미널 영역** — `AnimatePresence` crossfade:
```tsx
<AnimatePresence mode="wait">
  <motion.div
    key={focusedTabId}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.1 }}       // 빠르게 — 터미널 전환은 지연 느낌 안되게
  />
</AnimatePresence>
```

**Command Palette** — 등장/퇴장:
```tsx
// shadcn/ui <CommandDialog> 내부에 Motion 적용
<motion.div
  initial={{ opacity: 0, scale: 0.95 }}
  animate={{ opacity: 1, scale: 1 }}
  exit={{ opacity: 0, scale: 0.95 }}
  transition={{ duration: 0.15 }}
/>
```

**드래그 앤 드롭 오버레이** — `@dnd-kit` + Motion:
```tsx
// DragOverlay 안에서 Motion으로 드롭 시 snap 애니메이션
<DragOverlay>
  <motion.div
    initial={{ scale: 1.05, boxShadow: "0 8px 24px rgba(0,0,0,0.3)" }}
    animate={{ scale: 1.05 }}
    exit={{ scale: 1 }}
  />
</DragOverlay>
```

#### CSS 전용 (Motion 사용하지 않음)

```css
/* 상태 아이콘 — 고빈도, 항상 실행. CSS가 GPU 레이어에서 처리 */
.status-running {
  animation: pulse 2s ease-in-out infinite;
}
.status-processing {
  animation: spin 1s linear infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* hover 효과 — 즉각 반응 필요, CSS transition이 오버헤드 최소 */
.tab-item { transition: background-color 100ms ease; }
.tab-item:hover { background-color: var(--zinc-800); }

/* HUD 프로그레스 바 — 값만 바뀜, 구조 변경 없음 */
.metric-bar-fill { transition: width 300ms ease-out; }
```

#### 성능 레드라인

- Motion의 `layout` prop은 **사이드바 탭 리스트**에만 사용. 터미널 영역이나 HUD에서는 금지 (layout recalc 비용).
- `AnimatePresence`의 `mode="wait"`는 터미널 탭 전환에만 사용. 사이드바는 `mode="popLayout"` (동시 진입/퇴장).
- spring 애니메이션의 `stiffness`는 400~500, `damping`은 25~30 범위. 너무 낮으면 바운스가 느려서 버벅여 보임.
- **60fps 미달 시 즉시 해당 Motion을 CSS transition으로 대체**.

### 5. 메모리 관리

- 스크롤백 버퍼 기본 상한: 10,000줄 (설정 가능)
- 프로세스 종료된 세션: 최근 출력 1,000줄만 유지
- `FinalizationRegistry` 또는 cleanup 훅으로 xterm.js 인스턴스 정리
- Rust 쪽 세션 맵에서 종료된 세션 60초 후 자동 제거

---

## AI CLI Detection & Configuration

### 자동 감지 (앱 시작 시)

```rust
// Rust: which 커맨드로 PATH 탐색
fn detect() -> Option<DetectedProvider> {
    let output = Command::new("which").arg("claude").output().ok()?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let version = Command::new("claude").arg("--version").output().ok()?;
        Some(DetectedProvider { path, version: parse_version(&version.stdout) })
    } else {
        None
    }
}
```

Windows: `where` 커맨드 사용.

### Provider 설정 맵 (`src/lib/providers.ts`)

```typescript
export const PROVIDERS: Record<AIProvider, ProviderConfig> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    icon: 'Bot',           // Lucide
    color: '#D97706',      // amber
    detectable: true,
  },
  'codex-cli': {
    id: 'codex-cli',
    label: 'Codex CLI',
    command: 'codex',
    icon: 'Sparkles',
    color: '#10B981',      // emerald
    detectable: true,
  },
  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    command: 'gemini',
    icon: 'Gem',
    color: '#3B82F6',      // blue
    detectable: true,
  },
  'custom': {
    id: 'custom',
    label: 'Custom CLI',
    command: '',            // 사용자 지정
    icon: 'Terminal',
    color: '#A855F7',      // purple
    detectable: false,
  },
};
```

---

## HUD Metric Parsing

### Claude Code

Claude Code는 structured output을 제공하지 않음. 파싱 전략:

1. **ANSI 파싱**: 출력에서 status line의 ANSI escape 시퀀스 추출
2. **패턴 매칭**: 도구 호출(`Read`, `Edit`, `Grep`, `Agent` 등) 출력 패턴 감지
3. **비용 추정**: 모델별 토큰 단가 × 추정 토큰 수

```rust
// 예: Claude Code 출력에서 도구 활동 감지
const TOOL_PATTERNS: &[(&str, &str)] = &[
    (r"⏺ Read\s+(.+)", "Read"),
    (r"⏺ Edit\s+(.+)", "Edit"),
    (r"⏺ Grep\s+(.+)", "Grep"),
    (r"⏺ Agent\s+(.+)", "Agent"),
];
```

### Codex CLI / Gemini CLI

별도 파서 구현. 출력 형식이 변경될 수 있으므로 **Provider trait 구현체 교체**로 대응.

---

## Data Persistence

### 저장 위치
- **Mac**: `~/Library/Application Support/com.taehonglee.terminai/`
- **Windows**: `%APPDATA%/com.taehonglee.terminai/`

### 저장 파일
```
config/
├── settings.json         # 앱 설정 (테마, 사이드바 너비, HUD 모드)
├── spaces.json           # Space/Tab 레이아웃
├── providers.json        # AI CLI 경로, 커스텀 Provider 설정
└── keybindings.json      # 사용자 단축키 오버라이드
```

포맷: JSON (serde_json). SQLite는 이 규모에서 과도함.

### 세션 복원
- 앱 종료 시: 모든 Space/Tab 레이아웃 저장 (프로세스는 종료)
- 앱 재시작 시: 레이아웃 복원, 프로세스는 사용자가 수동으로 재시작
- 세션 히스토리는 저장하지 않음 (각 AI CLI가 자체 관리)

---

## Error Recovery

### 프로세스 크래시
1. PTY read에서 EOF 감지 → `processStatus: 'disconnected'`
2. 탭에 `AlertCircle` 아이콘 + "Session ended" 메시지
3. 탭 클릭 시 "Restart" 버튼 표시
4. 자동 재시작 하지 않음 (사용자 의도 존중)

### 좀비 프로세스 방지
```rust
// 앱 종료 시
fn cleanup_all_sessions(state: &AppState) {
    for session in state.sessions.lock().values() {
        // SIGTERM 먼저, 3초 대기 후 SIGKILL
        session.child.kill(); // portable-pty가 graceful shutdown 처리
    }
}

// 개별 세션 종료
fn kill_session(session: &mut PtySession) {
    let _ = session.child.kill();
    // Rust Drop trait으로 리소스 자동 정리
}
```

### Tauri 비정상 종료
- `tauri::Builder::on_window_event` → `CloseRequested` 핸들링
- 모든 세션 정리 후 종료

---

## Tauri Permissions

`src-tauri/capabilities/default.json`에 필요한 권한:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default permissions",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "shell:allow-spawn",
    "shell:allow-stdin-write",
    "shell:allow-kill",
    "process:default",
    "event:default"
  ]
}
```

---

## Design System

### Colors (Arc-inspired Dark Theme)
```
Background:         #09090B   zinc-950
Sidebar:            #18181B   zinc-900
Sidebar hover:      #27272A   zinc-800
Active tab:         #27272A   zinc-800 + left 2px accent border
Surface (HUD):      #18181B   zinc-900
Border:             #27272A   zinc-800

Text primary:       #FAFAFA   zinc-50
Text secondary:     #A1A1AA   zinc-400
Text muted:         #71717A   zinc-500

Running:            #10B981   emerald-500
Processing:         #F59E0B   amber-500
Error:              #EF4444   red-500
Idle:               #71717A   zinc-500
```

### Typography
```
UI Font:        "Inter", system-ui, sans-serif
Terminal Font:  "JetBrains Mono", "Fira Code", monospace
Sidebar:        13px / 1.4 line-height
HUD:            12px / 1.3 mono
Terminal:        14px (사용자 설정 가능)
```

### Animation Timing
```
Tab switch:         150ms ease-out        (CSS transition)
Sidebar collapse:   200ms spring          (Motion — stiffness:500, damping:30)
HUD expand:         200ms spring          (Motion)
Status pulse:       2s ease-in-out        (CSS @keyframes)
Status spin:        1s linear             (CSS @keyframes)
Drag preview:       실시간                 (@dnd-kit overlay)
Hover highlight:    100ms ease            (CSS transition)
```

### Spacing
```
Sidebar width:      240px (기본), 180px~360px 리사이즈
Sidebar padding:    8px horizontal, 4px vertical per item
Tab item height:    32px
HUD height:         36px (compact), 84px (expanded), 0 (hidden)
Main content:       남은 전체 영역
```

---

## Implementation Phases

### Phase 1: Core Shell (MVP)
- [x] Tailwind CSS v4 + shadcn/ui 초기화 + Lucide React + Jotai 세팅
- [x] App 레이아웃 (Sidebar + Main + HUD 3영역)
- [x] Sidebar: Space/Tab 정적 UI
- [x] Rust: PTY 세션 spawn/kill (portable-pty + tokio)
- [x] Rust → Frontend 출력 스트리밍 (Tauri events)
- [x] xterm.js 단일 터미널 연결 (Claude/Codex/Gemini spawn)
- [x] 기본 HUD (모델명 + 연결 상태)
- [ ] 탭 전환 시 터미널 인스턴스 캐싱

### Phase 2: Multi-AI + Tab Management
- [ ] Provider trait 구현 (claude, codex, gemini)
- [x] AI CLI 자동 감지 (detect_providers)
- [x] 새 탭 생성: `<DropdownMenu>` (shadcn/ui) AI 선택
- [ ] 탭 드래그 앤 드롭 (@dnd-kit)
- [x] Favorites 시스템
- [x] Space 접기/펼치기
- [ ] 우클릭 `<ContextMenu>` (shadcn/ui)
- [ ] HUD: AI별 메트릭 파싱 + 표시 (현재 세션 상태/경과시간까지 반영)

### Phase 3: Polish & Cross-Platform
- [ ] Motion 애니메이션 (사이드바, HUD, 탭 전환)
- [ ] Command Palette: `<CommandDialog>` (shadcn/ui, cmdk 기반) — Cmd+K
- [ ] 키보드 단축키 전체 구현
- [ ] 사이드바 리사이즈
- [ ] HUD 3단계 토글 (compact/expanded/hidden)
- [ ] 데이터 영속화 (spaces.json, settings.json)
- [ ] 테마 시스템 (다크/라이트 또는 커스텀)
- [ ] Windows 빌드 + ConPTY 테스트
- [ ] 자동 업데이트 (tauri-plugin-updater)

---

## Development Guidelines

### Frontend
- **Components**: Functional + hooks only. Props interface 명시.
- **UI Primitives**: shadcn/ui 컴포넌트 사용. `<ContextMenu>`, `<DropdownMenu>`, `<Tooltip>`, `<ScrollArea>`, `<Dialog>`, `<Command>` 등. 직접 DOM 이벤트로 메뉴/팝오버 구현 금지.
- **Styling**: Tailwind utility classes only. `style={{}}` 금지. shadcn/ui의 `cn()` 유틸리티로 조건부 클래스 결합.
- **State (Jotai)**:
  - `atomFamily`로 탭/세션별 독립 atom. store 단위 통째 구독 금지.
  - 읽기: `useAtomValue()`, 쓰기: `useSetAtom()` 분리. `useAtom()`은 읽기+쓰기 모두 필요할 때만.
  - 고빈도 업데이트 atom(메트릭, 프로세스 상태)은 다른 atom에 중첩하지 않고 독립 유지.
  - derived atom(`atom((get) => ...)`)으로 계산 값 캐싱.
- **Animation**: `transform`/`opacity`만 애니메이트. layout shift 유발 속성(`width`, `height`, `top`, `left`) 직접 애니메이트 금지.
- **Icons**: `lucide-react`에서 import. SVG 직접 사용 금지.
- **Event**: Tauri IPC는 `hooks/useTauriEvent.ts` 통해서만 접근. 직접 `listen()` 호출 금지.

### Tooling (Biome + bun)
- 패키지 매니저는 `bun`만 사용 (`npm`, `pnpm`, `yarn` 금지).
- 코드 품질 검사는 Biome 기준으로 수행:
  - `bun run lint`
  - `bun run format`
  - `bun run check`
  - `bun run check:write`
- 커밋 전 최소 검증:
  - `bun run check` (frontend + config, `src` 포함)
  - `bun run build` (frontend build 검증)
  - `cd src-tauri && cargo check` (backend 검증)
  - E2E가 필요한 변경은 `bun run test:e2e`까지 수행 (사전 준비: `bunx playwright install chromium`)
- Biome 범위는 `src/**` + 주요 설정 파일(`package.json`, `tsconfig*.json`, `vite.config.ts`, `biome.json`)로 제한.

### Rust Backend
- `unwrap()` / `expect()` 금지 (테스트 제외). `?` 연산자 사용.
- 모든 `tauri::command`는 `Result<T, String>` 반환.
- PTY 출력은 반드시 `OutputBuffer`를 거쳐 배치 전송.
- `tokio::spawn`으로 세션별 독립 task. 세션 간 직접 참조 금지.
- `tracing` 크레이트로 로깅. `println!` 금지.

### Testing
- Phase 1~2: Rust 단위 테스트 (`#[tokio::test]`) 필수.
- Phase 3: Playwright로 E2E 테스트.

### Git
- 커밋 메시지: conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`)
- 브랜치: `feature/`, `fix/`, `refactor/` prefix

---

## Current Implementation Notes (Updated)

아래 항목은 현재 코드 상태를 기준으로 한 실제 동작이다.

### UI/Information Architecture
- `Favorites` 섹션은 제거됨 (중복 정보 방지).
- 사이드바는 `Space(Work/Personal) -> Tab` 구조만 표시.
- 탭 `X` 버튼은 항상 표시되며 즉시 닫힘.
- `Rename` 기능(우클릭/더블클릭)은 제거됨.

### Tab Interactions
- 드래그 앤 드롭 구현됨:
  - 같은 Space 내 순서 변경
  - Space 간 탭 이동
- 우클릭 컨텍스트 메뉴:
  - `Duplicate`
  - `Set Working Directory...`
  - `Close`

### Command/Shortcuts
- `Command Palette` 구현됨 (`Cmd/Ctrl + K`).
- 구현 단축키:
  - `Cmd/Ctrl + T`: 새 Claude 탭
  - `Cmd/Ctrl + W`: 현재 탭 닫기
  - `Cmd/Ctrl + 1~9`: favorite 탭 포커스
  - `Cmd/Ctrl + Shift + [` / `]`: Space 전환
  - `Cmd/Ctrl + \`: 사이드바 토글

### Working Directory (중요)
- `Default Path`:
  - 사이드바 버튼으로 설정/변경 가능
  - 첫 실행 시 자동 다이얼로그 표시
  - 저장 시 현재 활성 탭에도 즉시 적용
- `Set Working Directory...`:
  - 특정 탭 경로를 개별 변경
  - 저장 시 해당 탭 세션 재시작 후 새 경로로 spawn
- `~`, `~/...` 입력 가능 (Rust backend에서 home 경로로 확장).

### Terminal/IME Stability
- 웹 모드(`bun run dev`)는 Tauri 런타임이 없어 실제 PTY 세션 spawn 불가.
- 실제 세션은 `bun run tauri dev`에서만 동작.
- 한국어 IME 안정성을 위해 xterm WebGL 렌더러는 기본 비활성화.
- Gemini CLI 반복 노이즈 라인(`? for shortcuts`, spinner)은 프론트에서 필터링.

### Persistence
- `terminai:default-cwd` (기본 경로)
- `terminai:tab-cwds` (탭별 경로)
- `terminai:spaces`, `terminai:focused-tab-id` 등 기존 키 유지

### E2E Automation
- Playwright E2E 테스트 구성됨.
- 테스트 파일: `tests/e2e/ui-core.spec.ts`
- 설정 파일: `playwright.config.ts`
- 실행:
  - `bun run test:e2e`
  - `bun run test:e2e:headed`
