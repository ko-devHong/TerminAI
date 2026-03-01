# TerminAI

여러 AI CLI(`claude`, `codex`, `gemini`)를 탭 기반으로 관리하는 Tauri 데스크톱 앱입니다.

## 실행 방법

### 1) UI만 확인 (웹 모드)

```bash
bun run dev
```

- 브라우저에서 Vite `Local` 주소로 접속
- Tauri 백엔드가 없어서 실제 PTY 세션은 실행되지 않음

### 2) 실제 세션 포함 실행 (권장)

```bash
bun run tauri dev
```

- Rust backend + PTY 포함
- 실제 `claude/codex/gemini` 프로세스가 실행됨

## 핵심 UX

### 사이드바

- `Search / Cmd+K`: Command Palette 열기
- `Default Path: ...`: 새 탭 기본 실행 경로 설정
- `New Tab`: Provider 선택 후 탭 생성

### 탭 조작

- 클릭: 탭 포커스
- 우클릭 메뉴:
  - `Duplicate`
  - `Set Working Directory...` (탭별 실행 경로)
  - `Close`
- `X` 버튼: 즉시 탭 닫기
- 드래그 앤 드롭:
  - 같은 Space 내 순서 변경
  - 다른 Space로 이동

### 경로 설정 정책

- `Default Path`:
  - 새 탭 생성 시 기본값으로 사용
  - 저장 시 현재 활성 탭에도 즉시 적용
- `Set Working Directory...`:
  - 특정 탭 경로만 변경
  - 저장 시 해당 탭 세션 재시작 후 새 경로로 실행
- `~`, `~/...` 입력 가능 (홈 디렉터리로 확장)

## 단축키

- `Cmd/Ctrl + K`: Command Palette
- `Cmd/Ctrl + T`: 새 Claude 탭
- `Cmd/Ctrl + W`: 현재 탭 닫기
- `Cmd/Ctrl + 1~9`: Favorite 탭 이동
- `Cmd/Ctrl + Shift + [` / `]`: Space 전환
- `Cmd/Ctrl + \`: 사이드바 토글

## 데이터 저장 (localStorage)

- `terminai:default-cwd`: 기본 실행 경로
- `terminai:tab-cwds`: 탭별 실행 경로
- `terminai:spaces`: Space/탭 배치
- `terminai:focused-tab-id`: 현재 탭

## 트러블슈팅

### `Tauri runtime unavailable in web mode`

- 웹 모드(`bun run dev`)에서 정상 메시지
- 실제 세션 테스트는 `bun run tauri dev` 사용

### `Default Path`를 `~`로 줬는데 적용이 이상함

- 최신 코드에서는 `~`가 홈 경로로 확장됨
- 경로 변경 후 해당 탭 세션이 재시작되어야 반영됨

### AI 프롬프트 한글 입력 문제

- 터미널 IME 안정성을 위해 WebGL 렌더러를 기본 비활성화
- 그래도 입력 이슈가 있으면 앱 재실행 후 재시도

## 개발 체크

프런트(`src`)와 백엔드(`src-tauri`)를 둘 다 확인해야 합니다.

```bash
# Frontend + config (src 포함)
bun run check

# Frontend build 검증
bun run build

# Backend (Rust)
cd src-tauri && cargo check
```

## E2E 자동화 테스트

Playwright 기반으로 핵심 UI 시나리오를 자동 검증합니다.

포함 시나리오:
- 첫 실행 `Default Run Path` 다이얼로그
- `Default Path` 저장 반영
- 탭 우클릭 메뉴(`Set Working Directory...`, `Rename` 미노출)
- 탭 닫기 버튼 동작
- `Ctrl/Cmd + T` 새 탭
- 탭 드래그 앤 드롭

설치:

```bash
bun install
bunx playwright install chromium
```

실행:

```bash
bun run test:e2e
```

헤디드 실행:

```bash
bun run test:e2e:headed
```
