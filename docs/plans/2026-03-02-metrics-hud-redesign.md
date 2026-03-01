# Metrics & HUD Redesign — Real-time Model Info, Cost, Rate Limits

## Problem

Users cannot see which model is running, how much they've spent, or how much usage remains. The current HUD shows static fallback data in most cases. Status detection is limited to process-level (running/disconnected/error) with no semantic understanding of what the agent is doing.

## Goals

1. Display accurate real-time metrics: model, cost, tokens, context window
2. Show rate limit usage (5h/7d windows) with reset countdown
3. Detect agent status from terminal output content (thinking, waiting, idle, error)
4. Support all 3 providers: Claude, Codex CLI, Gemini CLI
5. Minimal dashboard UI with smooth animations

## Architecture

```
┌─ Terminal Parsing (existing) ─────┐   ┌─ API Polling (new) ────────────┐
│ model, cost, tokens, context,     │   │ rate limit (5h/7d),           │
│ active tools, content-based status│   │ billing/usage, plan info       │
└───────────────┬───────────────────┘   └───────────────┬───────────────┘
                └───────────────┬───────────────────────┘
                                ↓
                    HUDMetrics (merged via Jotai)
                                ↓
                    HUD Panel (minimal dashboard)
```

## Part 1: Data Layer — Rust Backend

### 1A. New Tauri Commands

Three new commands for provider-specific API polling:

**`fetch_claude_usage`**
- Auth: macOS Keychain OAuth token (priority) → ANTHROPIC_API_KEY fallback
- Endpoint: Anthropic usage API
- Returns: 5h/7d rate limit percentages, reset timestamps, plan name
- Cache: 60s TTL, 15s on failure, 120s after 3 consecutive failures

**`fetch_openai_usage`**
- Auth: OPENAI_API_KEY environment variable
- Endpoint: OpenAI /v1/usage or /dashboard/billing/usage
- Returns: daily cost, token usage, spending limit
- Cache: 60s TTL

**`fetch_gemini_usage`**
- Auth: GEMINI_API_KEY environment variable
- Endpoint: Google AI Studio API (limited)
- Returns: RPM/RPD limits, usage counts
- Cache: 60s TTL

### 1B. Zero-Config Auth (claude-hud approach)

No API key registration UI. All credentials are auto-discovered:

| Provider | Auto-Discovery (priority) | Fallback |
|----------|--------------------------|----------|
| Claude | macOS Keychain OAuth token (Claude Code stores this on login) | ANTHROPIC_API_KEY env var |
| Codex | `~/.codex/` config file → OPENAI_API_KEY env var | — |
| Gemini | `~/.config/gemini/` config → GEMINI_API_KEY env var | — |

If no credentials found → HUD shows terminal-parsed data only (model, cost, tokens from output).
No "key not set" error, no setup wizard. It just works with whatever data is available.

### 1C. New Tauri Types

```rust
#[derive(Clone, serde::Serialize)]
pub struct ProviderUsage {
    pub rate_limit: Option<RateLimit>,
    pub billing: Option<BillingInfo>,
    pub plan: Option<String>,
}

#[derive(Clone, serde::Serialize)]
pub struct RateLimit {
    pub five_hour_percent: f64,
    pub seven_day_percent: f64,
    pub five_hour_reset_seconds: u64,
    pub seven_day_reset_seconds: u64,
}

#[derive(Clone, serde::Serialize)]
pub struct BillingInfo {
    pub used_dollars: f64,
    pub limit_dollars: Option<f64>,
}
```

## Part 2: Status Detection (agent-view inspired)

### 2A. New Status Types

Extend ProcessStatus from 5 to 6 values:

```typescript
type ProcessStatus =
  | "idle"          // prompt visible, no output
  | "running"       // tool executing, active output
  | "thinking"      // model generating, spinner/no output
  | "waiting"       // needs user input (y/n, permission)
  | "error"         // error detected in output
  | "disconnected"  // PTY EOF or killed
```

### 2B. Detection Patterns (Rust parser)

| Status | Patterns |
|--------|----------|
| running | Spinner chars `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, `⏺` tool markers, active output |
| waiting | `Do you want to proceed`, `(y/n)`, `permission`, `approve`, `Allow` |
| thinking | `Thinking`, `ctrl+c to interrupt`, spinner + no tool output |
| idle | Prompt chars `❯ $ >` at end of buffer, no output for 3+ seconds |
| error | `error:`, `failed:`, `exception:`, `panic:`, `rate limit exceeded` |

### 2C. Implementation Location

Add `detect_status(&self, chunk: &str) -> Option<SessionStatus>` to each MetricParser in `metrics.rs`. Emit as part of existing `MetricUpdate` struct (new `status` field).

Frontend 3-second polling scan also detects status as backup (in `screen-metrics.ts`).

## Part 3: Frontend State Layer

### 3A. New Jotai Atoms

```typescript
// Per-provider API usage data
const providerUsageAtom = atomFamily(
  (_provider: AIProvider) => atom<ProviderUsage | null>(null)
);

// Polling state
const usagePollingAtom = atom(null, async (get, set, provider: AIProvider) => {
  const usage = await invokeTauri<ProviderUsage>("fetch_provider_usage", { provider });
  set(providerUsageAtom(provider), usage);
});
```

### 3B. Merged Metrics

Extend `activeHudMetricsAtom` to merge:
- Terminal parsing → model, cost, tokens, context, tools
- API polling → rateLimit, billing, plan
- Status detection → detailedStatus

### 3C. Extended HUDMetrics Type

```typescript
interface HUDMetrics {
  // existing
  provider: AIProvider;
  model: string | null;
  contextWindow: { used: number; total: number } | null;
  tokens: { input: number; output: number } | null;
  cost: number | null;
  activeTools: string[];
  sessionDuration: number;
  connectionStatus: "connected" | "disconnected" | "error";
  // new
  rateLimit: { fiveHourPercent: number; sevenDayPercent: number; fiveHourResetSeconds: number; sevenDayResetSeconds: number } | null;
  billing: { usedDollars: number; limitDollars: number | null } | null;
  plan: string | null;
  detailedStatus: ProcessStatus;
}
```

### 3D. Polling Logic

- 60s interval via useEffect + Tauri invoke
- Immediate refetch on tab switch
- Retry: 15s after failure, 120s backoff after 3 consecutive failures
- Results cached in atom, survive tab switches

## Part 4: UI — Minimal Dashboard HUD

### 4A. Compact Mode (1 line, 36px)

```
[icon] opus-4 | ━━━━━░ 78% | ● thinking | $1.23 | 5m
```

Elements left to right:
- Provider icon (existing)
- Model name (existing)
- Context progress bar (new: animated, color-coded)
- Status dot + label (enhanced: pulse animation for thinking/waiting)
- Cost (new: count-up animation)
- Duration (existing)

### 4B. Expanded Mode (~120px)

```
[icon] opus-4 (Pro)  ● thinking   $1.23    5m

Context  ━━━━━━━━━━░░░  78%
5h Rate  ━━━━━━░░░░░░░  42%           ↻ 2h 18m
7d Rate  ━━░░░░░░░░░░░  18%

↑ 5.2k in   ↓ 1.1k out   Tools: Read, Edit, Bash
```

New rows in expanded mode:
- Rate limit bars (5h and 7d) with reset countdown
- Plan name next to model

### 4C. Animations

| Element | Animation | Config |
|---------|-----------|--------|
| Progress bar width | motion spring | stiffness:300, damping:30 |
| Progress bar color | animate backgroundColor | auto-interpolated |
| Numeric values (%, $, tokens) | useSpring counter | stiffness:100, damping:20 |
| Status dot | scale + opacity pulse | repeat:Infinity for thinking/waiting |
| Mode transition | layout + AnimatePresence | existing pattern |
| Rate limit warning | bar glow at 80%+ | CSS box-shadow + red color |

### 4D. Color System

```
Progress bars:  0-60% → emerald-500  60-80% → amber-500  80%+ → red-500
Status dot:     idle → zinc-500
                running → emerald-500
                thinking → amber-500 (pulse)
                waiting → blue-500 (pulse)
                error → red-500
```

### 4E. Hover Tooltips

On progress bar hover, show detailed tooltip:
- Context: "125,000 / 200,000 tokens (78%)"
- 5h Rate: "42% used — resets in 2h 18m"
- 7d Rate: "18% used — resets in 5d 12h"

## Implementation Order

1. Rust: Status detection in MetricParser (extend MetricUpdate with status field)
2. Rust: API polling commands (fetch_claude_usage, fetch_openai_usage, fetch_gemini_usage)
3. Rust: Keychain integration for Claude OAuth
4. Frontend: New atoms (providerUsageAtom, merged metrics)
5. Frontend: Status detection in screen-metrics.ts (backup)
6. Frontend: HUD Panel redesign — compact mode with animated bars
7. Frontend: HUD Panel — expanded mode with rate limits
8. Frontend: Animations (spring progress, number counters, status pulse)
9. Frontend: Hover tooltips
10. Tests: E2E tests for new HUD features

## References

- [claude-hud](https://github.com/jarrodwatts/claude-hud) — JSONL transcript + OAuth API for rate limits
- [agent-view](https://github.com/frayo44/agent-view) — tmux capture + regex status detection
- Existing TerminAI screen-metrics.ts and metrics.rs parsers
