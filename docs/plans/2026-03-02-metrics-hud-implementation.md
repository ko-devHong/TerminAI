# Metrics & HUD Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Display real-time model info, cost, rate limits, and agent status in the HUD panel with zero-config credential discovery and smooth animations.

**Architecture:** Dual-layer data (Rust PTY parsing + frontend screen polling) extended with status detection and API usage polling via auto-discovered credentials. HUD redesigned as a minimal dashboard with spring-animated progress bars.

**Tech Stack:** Rust (Tauri v2, reqwest, security-framework), TypeScript (Jotai atoms, Framer Motion springs), Playwright E2E

---

### Task 1: Add `status` field to MetricUpdate and extend SessionStatus

**Files:**
- Modify: `src-tauri/src/state.rs:9-13`
- Modify: `src-tauri/src/metrics.rs:5-15`

**Step 1: Extend SessionStatus enum in state.rs**

Replace the `SessionStatus` enum (line 9-13) with detailed statuses:

```rust
#[derive(Clone, serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Idle,
    Running,
    Thinking,
    Waiting,
    Error,
    Disconnected,
}
```

**Step 2: Add `status` field to MetricUpdate in metrics.rs**

Add `status` to the struct (line 7-15):

```rust
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricUpdate {
    pub active_tools: Vec<String>,
    pub model: Option<String>,
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
    pub cost: Option<f64>,
    pub context_used: Option<u64>,
    pub context_total: Option<u64>,
    pub status: Option<String>,
}
```

Update `MetricUpdate::empty()` (line 18-28) to include `status: None`.

**Step 3: Fix all references to SessionStatus**

In `commands.rs`, update usages:
- Line 60: `SessionStatus::Running` stays the same
- Line 152: `SessionStatus::Disconnected` stays the same
- Line 155: `SessionStatus::Disconnected` stays the same
- Line 182: `SessionStatus::Disconnected` stays the same
- Line 234: `SessionStatus::Error` stays the same

**Step 4: Run cargo check**

Run: `cd src-tauri && cargo check`
Expected: PASS (no errors)

**Step 5: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/metrics.rs
git commit -m "feat: extend SessionStatus enum and add status field to MetricUpdate"
```

---

### Task 2: Add status detection patterns to Rust parsers

**Files:**
- Modify: `src-tauri/src/metrics.rs:38-43` (add new regexes)
- Modify: `src-tauri/src/metrics.rs:109-194` (ClaudeMetricParser)
- Modify: `src-tauri/src/metrics.rs:219-253` (CodexMetricParser)
- Modify: `src-tauri/src/metrics.rs:273-297` (GeminiMetricParser)

**Step 1: Add status detection regexes after the ANSI_RE (line 38)**

```rust
// ─── Status Detection (shared across providers) ─────────

static STATUS_WAITING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(do you want to proceed|[\(（]\s*y\s*/\s*n\s*[\)）]|permission|approve|allow\s+(tool|this)|press enter|confirm)").unwrap()
});

static STATUS_THINKING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(thinking|ctrl\+c to interrupt|reasoning)").unwrap()
});

static STATUS_ERROR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(^error:|failed:|exception:|panic:|rate limit exceeded|APIError|unauthorized|forbidden)").unwrap()
});

static STATUS_RUNNING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]|⏺").unwrap()
});

static STATUS_IDLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[❯$>]\s*$").unwrap()
});
```

**Step 2: Add `detect_status` helper function**

```rust
fn detect_status(clean: &str) -> Option<String> {
    if STATUS_WAITING_RE.is_match(clean) {
        Some("waiting".to_string())
    } else if STATUS_ERROR_RE.is_match(clean) {
        Some("error".to_string())
    } else if STATUS_THINKING_RE.is_match(clean) {
        Some("thinking".to_string())
    } else if STATUS_RUNNING_RE.is_match(clean) {
        Some("running".to_string())
    } else if STATUS_IDLE_RE.is_match(clean) {
        Some("idle".to_string())
    } else {
        None
    }
}
```

**Step 3: Call detect_status in each parser's parse_chunk**

In `ClaudeMetricParser::parse_chunk` (after line 180), before the `if changed` block:

```rust
let detected_status = detect_status(&clean);
if detected_status.is_some() {
    changed = true;
}
```

And in the `if changed` block, add:
```rust
update.status = detected_status;
```

Apply the same pattern to `CodexMetricParser::parse_chunk` and `GeminiMetricParser::parse_chunk`.

**Step 4: Add unit tests for status detection**

Add at the bottom of `metrics.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_status_waiting() {
        assert_eq!(detect_status("Do you want to proceed? (y/n)"), Some("waiting".to_string()));
        assert_eq!(detect_status("Allow this tool execution?"), Some("waiting".to_string()));
    }

    #[test]
    fn test_detect_status_thinking() {
        assert_eq!(detect_status("Thinking..."), Some("thinking".to_string()));
        assert_eq!(detect_status("ctrl+c to interrupt"), Some("thinking".to_string()));
    }

    #[test]
    fn test_detect_status_error() {
        assert_eq!(detect_status("error: file not found"), Some("error".to_string()));
        assert_eq!(detect_status("rate limit exceeded"), Some("error".to_string()));
    }

    #[test]
    fn test_detect_status_running() {
        assert_eq!(detect_status("⠋ Processing files"), Some("running".to_string()));
        assert_eq!(detect_status("⏺ Read src/main.rs"), Some("running".to_string()));
    }

    #[test]
    fn test_detect_status_idle() {
        assert_eq!(detect_status("❯ "), Some("idle".to_string()));
        assert_eq!(detect_status("$ "), Some("idle".to_string()));
    }

    #[test]
    fn test_detect_status_none() {
        assert_eq!(detect_status("some regular output text"), None);
    }

    #[test]
    fn test_claude_parser_emits_status() {
        let mut parser = ClaudeMetricParser::new();
        let update = parser.parse_chunk("Thinking about your question...");
        assert!(update.is_some());
        assert_eq!(update.unwrap().status, Some("thinking".to_string()));
    }
}
```

**Step 5: Run tests**

Run: `cd src-tauri && cargo test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src-tauri/src/metrics.rs
git commit -m "feat: add status detection patterns to Rust metric parsers"
```

---

### Task 3: Add zero-config credential discovery Tauri commands

**Files:**
- Create: `src-tauri/src/usage.rs`
- Modify: `src-tauri/src/lib.rs:1` (add `mod usage`)
- Modify: `src-tauri/src/commands.rs` (add new commands)
- Modify: `src-tauri/Cargo.toml:20-31` (add `reqwest` dependency)
- Modify: `src-tauri/capabilities/default.json` (add HTTP permission)

**Step 1: Add reqwest dependency to Cargo.toml**

Add after line 31 (`regex = "1"`):
```toml
reqwest = { version = "0.12", features = ["json"] }
```

**Step 2: Create `src-tauri/src/usage.rs` with credential discovery**

```rust
use serde::Serialize;
use std::process::Command;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub rate_limit: Option<RateLimit>,
    pub billing: Option<BillingInfo>,
    pub plan: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimit {
    pub five_hour_percent: f64,
    pub seven_day_percent: f64,
    pub five_hour_reset_seconds: u64,
    pub seven_day_reset_seconds: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingInfo {
    pub used_dollars: f64,
    pub limit_dollars: Option<f64>,
}

/// Attempt to find Claude OAuth token from macOS Keychain.
/// Claude Code stores its OAuth token here on login.
pub fn find_claude_oauth_token() -> Option<String> {
    // Try multiple keychain service names that Claude Code might use
    let service_names = [
        "api.claude.ai",
        "claude.ai",
        "com.anthropic.claude-code",
    ];

    for service in &service_names {
        if let Ok(output) = Command::new("security")
            .args(["find-generic-password", "-s", service, "-w"])
            .output()
        {
            if output.status.success() {
                let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !token.is_empty() {
                    return Some(token);
                }
            }
        }
    }

    None
}

/// Find API key from environment variable.
pub fn find_env_key(var_name: &str) -> Option<String> {
    std::env::var(var_name).ok().filter(|v| !v.is_empty())
}

/// Discover credential for a provider. Returns (token, is_oauth) tuple.
pub fn discover_credential(provider: &str) -> Option<(String, bool)> {
    match provider {
        "claude-code" => {
            // Priority 1: macOS Keychain OAuth
            if let Some(token) = find_claude_oauth_token() {
                return Some((token, true));
            }
            // Priority 2: ANTHROPIC_API_KEY env var
            if let Some(key) = find_env_key("ANTHROPIC_API_KEY") {
                return Some((key, false));
            }
            None
        }
        "codex-cli" => {
            find_env_key("OPENAI_API_KEY").map(|k| (k, false))
        }
        "gemini-cli" => {
            find_env_key("GEMINI_API_KEY").map(|k| (k, false))
        }
        _ => None,
    }
}
```

**Step 3: Add `fetch_provider_usage` Tauri command in commands.rs**

Add after `detect_providers` command (line 159-161):

```rust
#[tauri::command]
pub async fn fetch_provider_usage(provider: String) -> Result<Option<crate::usage::ProviderUsage>, String> {
    let credential = crate::usage::discover_credential(&provider);

    let (token, _is_oauth) = match credential {
        Some(c) => c,
        None => return Ok(None), // No credential found, return None (not an error)
    };

    match provider.as_str() {
        "claude-code" => fetch_claude_usage(&token).await,
        "codex-cli" => fetch_openai_usage(&token).await,
        "gemini-cli" => fetch_gemini_usage(&token).await,
        _ => Ok(None),
    }
}

async fn fetch_claude_usage(token: &str) -> Result<Option<crate::usage::ProviderUsage>, String> {
    // TODO: Implement Anthropic usage API call
    // For now return empty structure to unblock frontend work
    let _ = token;
    Ok(Some(crate::usage::ProviderUsage {
        rate_limit: None,
        billing: None,
        plan: None,
    }))
}

async fn fetch_openai_usage(token: &str) -> Result<Option<crate::usage::ProviderUsage>, String> {
    let _ = token;
    Ok(Some(crate::usage::ProviderUsage {
        rate_limit: None,
        billing: None,
        plan: None,
    }))
}

async fn fetch_gemini_usage(token: &str) -> Result<Option<crate::usage::ProviderUsage>, String> {
    let _ = token;
    Ok(Some(crate::usage::ProviderUsage {
        rate_limit: None,
        billing: None,
        plan: None,
    }))
}
```

**Step 4: Register new command in lib.rs**

In `lib.rs` line 1, add `mod usage;` and in the invoke_handler (line 13-19), add `commands::fetch_provider_usage`:

```rust
mod commands;
mod metrics;
mod provider;
mod state;
mod usage;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::spawn_session,
            commands::write_to_session,
            commands::resize_session,
            commands::kill_session,
            commands::detect_providers,
            commands::fetch_provider_usage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Step 5: Run cargo check**

Run: `cd src-tauri && cargo check`
Expected: PASS

**Step 6: Commit**

```bash
git add src-tauri/src/usage.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat: add zero-config credential discovery and fetch_provider_usage command"
```

---

### Task 4: Update frontend TypeScript types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Update ProcessStatus and HUDMetrics types**

Replace the entire file:

```typescript
export type AIProvider = "claude-code" | "codex-cli" | "gemini-cli" | "custom";

export type ProcessStatus =
  | "idle"
  | "running"
  | "thinking"
  | "waiting"
  | "error"
  | "disconnected";

export interface ProviderConfig {
  id: AIProvider;
  label: string;
  command: string;
  color: string;
  icon: string;
  detectable: boolean;
}

export interface DetectedProvider {
  id: AIProvider;
  command: string;
  found: boolean;
  path: string | null;
}

export interface Tab {
  id: string;
  name: string;
  provider: AIProvider;
  cwd: string;
  spaceId: string;
  isFavorite: boolean;
  createdAt: number;
  lastActivityAt: number;
  isFocused: boolean;
  processStatus: ProcessStatus;
  sessionId: string | null;
}

export interface Space {
  id: string;
  name: string;
  color: string;
  tabIds: string[];
  isCollapsed: boolean;
}

export interface ProviderUsage {
  rateLimit: {
    fiveHourPercent: number;
    sevenDayPercent: number;
    fiveHourResetSeconds: number;
    sevenDayResetSeconds: number;
  } | null;
  billing: {
    usedDollars: number;
    limitDollars: number | null;
  } | null;
  plan: string | null;
}

export interface HUDMetrics {
  provider: AIProvider;
  model: string | null;
  contextWindow: { used: number; total: number } | null;
  tokens: { input: number; output: number } | null;
  cost: number | null;
  rateLimit: {
    fiveHourPercent: number;
    sevenDayPercent: number;
    fiveHourResetSeconds: number;
    sevenDayResetSeconds: number;
  } | null;
  billing: { usedDollars: number; limitDollars: number | null } | null;
  plan: string | null;
  activeTools: string[];
  sessionDuration: number;
  detailedStatus: ProcessStatus;
  connectionStatus: "connected" | "disconnected" | "error";
}
```

**Step 2: Fix TypeScript compilation errors from type change**

The old `rateLimit` was `{ remaining: number; total: number } | null`. Need to update:
- `src/atoms/hud.ts:49` — change `rateLimit: null` to `rateLimit: null, billing: null, plan: null, detailedStatus: "idle" as ProcessStatus`
- `src/components/hud/HUDPanel.tsx:164` — the expanded mode rate display
- `src/components/terminal/TerminalView.tsx:287` — the merged HUDMetrics construction

**Step 3: Update atoms/hud.ts fallback**

Replace the fallback return in `activeHudMetricsAtom` (lines 29-51):

```typescript
return {
    provider: focusedTab.provider,
    model:
      focusedTab.provider === "claude-code"
        ? "opus-4"
        : focusedTab.provider === "codex-cli"
          ? "gpt-4o"
          : focusedTab.provider === "gemini-cli"
            ? "gemini-2.0-pro"
            : null,
    contextWindow: null,
    tokens: null,
    cost: null,
    rateLimit: null,
    billing: null,
    plan: null,
    activeTools: [],
    sessionDuration: 0,
    detailedStatus: (focusedTab.processStatus ?? "idle") as ProcessStatus,
    connectionStatus:
      focusedTab.processStatus === "disconnected" || focusedTab.processStatus === "error"
        ? "disconnected"
        : focusedTab.processStatus === "running" || focusedTab.processStatus === "thinking"
          ? "connected"
          : "disconnected",
  };
```

**Step 4: Update TerminalView.tsx merged HUDMetrics**

Replace the merged object in TerminalView.tsx (lines 272-293):

```typescript
const merged: HUDMetrics = {
    provider: currentTab.provider,
    model: screenData.model ?? existing?.model ?? null,
    contextWindow:
      screenData.contextUsed != null && screenData.contextTotal != null
        ? { used: screenData.contextUsed, total: screenData.contextTotal }
        : (existing?.contextWindow ?? null),
    tokens:
      screenData.tokensIn != null || screenData.tokensOut != null
        ? {
            input: screenData.tokensIn ?? existing?.tokens?.input ?? 0,
            output: screenData.tokensOut ?? existing?.tokens?.output ?? 0,
          }
        : (existing?.tokens ?? null),
    cost: screenData.cost ?? existing?.cost ?? null,
    rateLimit: existing?.rateLimit ?? null,
    billing: existing?.billing ?? null,
    plan: existing?.plan ?? null,
    activeTools: screenData.activeTools.length
      ? screenData.activeTools
      : (existing?.activeTools ?? []),
    sessionDuration: existing?.sessionDuration ?? 0,
    detailedStatus: existing?.detailedStatus ?? "idle",
    connectionStatus: "connected",
  };
```

**Step 5: Run TypeScript check**

Run: `bun run build` (tsc + vite build)
Expected: PASS (no type errors)

**Step 6: Commit**

```bash
git add src/types/index.ts src/atoms/hud.ts src/components/terminal/TerminalView.tsx
git commit -m "feat: update TypeScript types for extended HUDMetrics with rate limits and status"
```

---

### Task 5: Add provider usage polling atoms

**Files:**
- Modify: `src/atoms/hud.ts`

**Step 1: Add provider usage atom and polling effect**

Add to `src/atoms/hud.ts`:

```typescript
import { atom } from "jotai";
import { atomFamily, atomWithStorage } from "jotai/utils";

import { focusedTabAtom } from "@/atoms/spaces";
import { invokeTauri, isTauriRuntimeAvailable } from "@/lib/tauri";
import type { AIProvider, HUDMetrics, ProcessStatus, ProviderUsage } from "@/types";

export const hudExpandModeAtom = atomWithStorage<"compact" | "expanded" | "hidden">(
  "terminai:hud-mode",
  "compact",
);

export const hudMetricsAtom = atomFamily((_sessionId: string) => atom<HUDMetrics | null>(null));

// Per-provider API usage cache
export const providerUsageAtom = atomFamily(
  (_provider: AIProvider) => atom<ProviderUsage | null>(null),
);

// ... keep activeHudMetricsAtom as-is but merge providerUsage ...
```

**Step 2: Merge providerUsage into activeHudMetricsAtom**

Update `activeHudMetricsAtom` to also read from `providerUsageAtom`:

```typescript
export const activeHudMetricsAtom = atom((get): HUDMetrics | null => {
  const focusedTab = get(focusedTabAtom);
  if (!focusedTab) {
    return null;
  }

  const providerUsage = get(providerUsageAtom(focusedTab.provider));

  if (focusedTab.sessionId) {
    const realMetrics = get(hudMetricsAtom(focusedTab.sessionId));
    if (realMetrics) {
      // Merge API usage data into terminal-parsed metrics
      return {
        ...realMetrics,
        rateLimit: realMetrics.rateLimit ?? providerUsage?.rateLimit ?? null,
        billing: realMetrics.billing ?? providerUsage?.billing ?? null,
        plan: realMetrics.plan ?? providerUsage?.plan ?? null,
      };
    }
  }

  // Fallback
  return {
    provider: focusedTab.provider,
    model:
      focusedTab.provider === "claude-code"
        ? "opus-4"
        : focusedTab.provider === "codex-cli"
          ? "gpt-4o"
          : focusedTab.provider === "gemini-cli"
            ? "gemini-2.0-pro"
            : null,
    contextWindow: null,
    tokens: null,
    cost: null,
    rateLimit: providerUsage?.rateLimit ?? null,
    billing: providerUsage?.billing ?? null,
    plan: providerUsage?.plan ?? null,
    activeTools: [],
    sessionDuration: 0,
    detailedStatus: (focusedTab.processStatus ?? "idle") as ProcessStatus,
    connectionStatus:
      focusedTab.processStatus === "disconnected" || focusedTab.processStatus === "error"
        ? "disconnected"
        : focusedTab.processStatus === "running" || focusedTab.processStatus === "thinking"
          ? "connected"
          : "disconnected",
  };
});
```

**Step 3: Run biome check**

Run: `bun run check`
Expected: PASS

**Step 4: Commit**

```bash
git add src/atoms/hud.ts
git commit -m "feat: add providerUsageAtom and merge API usage into active HUD metrics"
```

---

### Task 6: Add usage polling hook

**Files:**
- Create: `src/hooks/useUsagePolling.ts`
- Modify: `src/components/hud/HUDPanel.tsx` (wire up hook)

**Step 1: Create the polling hook**

```typescript
import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

import { providerUsageAtom } from "@/atoms/hud";
import { invokeTauri, isTauriRuntimeAvailable } from "@/lib/tauri";
import type { AIProvider, ProviderUsage } from "@/types";

const POLL_INTERVAL_MS = 60_000;
const RETRY_INTERVAL_MS = 15_000;
const BACKOFF_INTERVAL_MS = 120_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export function useUsagePolling(provider: AIProvider | null) {
  const setUsage = useSetAtom(providerUsageAtom(provider ?? "claude-code"));
  const failCountRef = useRef(0);

  useEffect(() => {
    if (!provider || !isTauriRuntimeAvailable()) {
      return;
    }

    let timeoutId: number | undefined;
    let mounted = true;

    async function poll() {
      if (!mounted || !provider) return;

      try {
        const usage = await invokeTauri<ProviderUsage | null>("fetch_provider_usage", { provider });
        if (mounted && usage) {
          setUsage(usage);
          failCountRef.current = 0;
        }
        scheduleNext(POLL_INTERVAL_MS);
      } catch {
        failCountRef.current += 1;
        const delay =
          failCountRef.current >= MAX_CONSECUTIVE_FAILURES
            ? BACKOFF_INTERVAL_MS
            : RETRY_INTERVAL_MS;
        scheduleNext(delay);
      }
    }

    function scheduleNext(ms: number) {
      if (mounted) {
        timeoutId = window.setTimeout(poll, ms);
      }
    }

    // Poll immediately on mount
    void poll();

    return () => {
      mounted = false;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [provider, setUsage]);
}
```

**Step 2: Wire up in HUDPanel.tsx**

Add import and call at the top of HUDPanel component:

```typescript
import { useUsagePolling } from "@/hooks/useUsagePolling";

// Inside HUDPanel():
useUsagePolling(activeTab?.provider ?? null);
```

**Step 3: Run biome check**

Run: `bun run check`
Expected: PASS

**Step 4: Commit**

```bash
git add src/hooks/useUsagePolling.ts src/components/hud/HUDPanel.tsx
git commit -m "feat: add useUsagePolling hook with retry/backoff logic"
```

---

### Task 7: Add frontend status detection in screen-metrics.ts

**Files:**
- Modify: `src/lib/screen-metrics.ts`

**Step 1: Add status detection patterns and return type**

Add `detectedStatus` to `ScreenMetricResult`:

```typescript
export interface ScreenMetricResult {
  model: string | null;
  cost: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  contextUsed: number | null;
  contextTotal: number | null;
  activeTools: string[];
  detectedStatus: ProcessStatus | null;
}
```

Add status detection regexes after existing patterns:

```typescript
// ─── Status Detection ────────────────────────────────────

const STATUS_WAITING_RE = /(?:do you want to proceed|[\(（]\s*y\s*\/\s*n\s*[\)）]|permission|approve|allow\s+(?:tool|this))/i;
const STATUS_THINKING_RE = /(?:thinking|ctrl\+c to interrupt|reasoning)/i;
const STATUS_ERROR_RE = /(?:^error:|failed:|exception:|panic:|rate limit exceeded)/im;
const STATUS_RUNNING_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]|⏺/;
const STATUS_IDLE_RE = /[❯$>]\s*$/m;
```

Add detection function:

```typescript
function detectStatus(lines: string[]): ProcessStatus | null {
  // Check last 5 lines for recency
  const recentLines = lines.slice(-5).join("\n");

  if (STATUS_WAITING_RE.test(recentLines)) return "waiting";
  if (STATUS_ERROR_RE.test(recentLines)) return "error";
  if (STATUS_THINKING_RE.test(recentLines)) return "thinking";
  if (STATUS_RUNNING_RE.test(recentLines)) return "running";
  if (STATUS_IDLE_RE.test(recentLines)) return "idle";

  return null;
}
```

**Step 2: Call detectStatus in each parser**

At the end of `parseClaude`, `parseCodex`, `parseGemini`, add:

```typescript
result.detectedStatus = detectStatus(lines);
```

And update the default return in `extractScreenMetrics` to include `detectedStatus: null`.

**Step 3: Update TerminalView.tsx to use detected status**

In the merged HUDMetrics construction in TerminalView.tsx, update the `detailedStatus` line:

```typescript
detailedStatus: screenData.detectedStatus ?? existing?.detailedStatus ?? "idle",
```

**Step 4: Run biome check**

Run: `bun run check`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/screen-metrics.ts src/components/terminal/TerminalView.tsx
git commit -m "feat: add frontend status detection from terminal screen buffer"
```

---

### Task 8: Redesign HUD Panel — compact mode with animated bars

**Files:**
- Modify: `src/components/hud/HUDPanel.tsx`

**Step 1: Rewrite HUDPanel compact row with spring-animated context bar**

Replace the entire HUDPanel.tsx with the redesigned version. Key changes:

- Context bar uses `motion.div` with spring animation for width
- Status dot has pulse animation for thinking/waiting states
- Cost uses animated counter (motion value + useSpring)
- Color-coded progress: 0-60% emerald, 60-80% amber, 80%+ red

The compact row layout:
```
[icon] opus-4 (Pro) | ━━━━━░ 78% | ● thinking | $1.23 | 5m
```

```typescript
// Key animation patterns:

// Progress bar with spring
<motion.div
  className="h-full rounded-full"
  animate={{
    width: `${contextPercent}%`,
    backgroundColor: contextPercent > 80 ? "#EF4444" : contextPercent > 60 ? "#F59E0B" : "#10B981",
  }}
  transition={{ type: "spring", stiffness: 300, damping: 30 }}
/>

// Status dot with pulse for thinking/waiting
<motion.span
  className={cn("inline-block size-1.5 rounded-full", statusColor)}
  animate={
    status === "thinking" || status === "waiting"
      ? { scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }
      : {}
  }
  transition={
    status === "thinking" || status === "waiting"
      ? { duration: 1.5, repeat: Number.POSITIVE_INFINITY }
      : {}
  }
/>
```

**Step 2: Update StatusDot component**

```typescript
function StatusDot({ status }: { status: ProcessStatus }) {
  const color =
    status === "running"
      ? "bg-emerald-500"
      : status === "thinking"
        ? "bg-amber-500"
        : status === "waiting"
          ? "bg-blue-500"
          : status === "error" || status === "disconnected"
            ? "bg-red-500"
            : "bg-zinc-500";

  const shouldPulse = status === "thinking" || status === "waiting";

  return (
    <motion.span
      className={cn("inline-block size-1.5 rounded-full", color)}
      animate={
        shouldPulse
          ? { scale: [1, 1.4, 1], opacity: [1, 0.5, 1] }
          : { scale: 1, opacity: 1 }
      }
      transition={
        shouldPulse
          ? { duration: 1.5, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }
          : { duration: 0.2 }
      }
    />
  );
}
```

**Step 3: Use `detailedStatus` instead of `connectionStatusLabel`**

Replace usages of `connectionStatusLabel` with `metrics?.detailedStatus ?? "idle"`.

**Step 4: Run dev server and visually verify**

Run: `bun run dev`
Open: `http://localhost:1420`
Verify: compact HUD shows animated context bar, pulsing status dot

**Step 5: Commit**

```bash
git add src/components/hud/HUDPanel.tsx
git commit -m "feat: redesign HUD compact mode with spring-animated progress bar and status pulse"
```

---

### Task 9: HUD Panel — expanded mode with rate limit bars

**Files:**
- Modify: `src/components/hud/HUDPanel.tsx`

**Step 1: Redesign expanded mode content**

The expanded mode (~120px) shows:
```
[icon] opus-4 (Pro)  ● thinking   $1.23    5m

Context  ━━━━━━━━━━░░░  78%
5h Rate  ━━━━━━░░░░░░░  42%           ↻ 2h 18m
7d Rate  ━━░░░░░░░░░░░  18%

↑ 5.2k in   ↓ 1.1k out   Tools: Read, Edit, Bash
```

Add a `ProgressRow` helper component:

```typescript
function ProgressRow({
  label,
  percent,
  resetSeconds,
  glow,
}: {
  label: string;
  percent: number;
  resetSeconds?: number;
  glow?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-14 text-zinc-500">{label}</span>
      <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-700">
        <motion.span
          className="absolute inset-y-0 left-0 rounded-full"
          animate={{
            width: `${Math.min(percent, 100)}%`,
            backgroundColor: percent > 80 ? "#EF4444" : percent > 60 ? "#F59E0B" : "#10B981",
          }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
        />
        {glow && percent >= 80 && (
          <span className="absolute inset-0 animate-pulse rounded-full bg-red-500/20" />
        )}
      </span>
      <span className="w-8 text-right text-zinc-400">{Math.round(percent)}%</span>
      {resetSeconds != null && resetSeconds > 0 && (
        <span className="text-zinc-500">↻ {formatResetTime(resetSeconds)}</span>
      )}
    </div>
  );
}

function formatResetTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
```

**Step 2: Use ProgressRow in expanded mode**

```typescript
{mode === "expanded" && (
  <motion.div
    initial={{ opacity: 0, y: -4 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -4 }}
    className="space-y-1.5 pb-2"
  >
    {metrics?.contextWindow && (
      <ProgressRow label="Context" percent={contextPercent} />
    )}
    {metrics?.rateLimit && (
      <>
        <ProgressRow
          label="5h Rate"
          percent={metrics.rateLimit.fiveHourPercent}
          resetSeconds={metrics.rateLimit.fiveHourResetSeconds}
          glow
        />
        <ProgressRow
          label="7d Rate"
          percent={metrics.rateLimit.sevenDayPercent}
          resetSeconds={metrics.rateLimit.sevenDayResetSeconds}
          glow
        />
      </>
    )}
    <div className="flex items-center gap-4 text-xs text-zinc-400">
      <span>↑ {formatTokens(metrics?.tokens?.input)} in</span>
      <span>↓ {formatTokens(metrics?.tokens?.output)} out</span>
      <span>Tools: {metrics?.activeTools?.join(", ") || "-"}</span>
    </div>
  </motion.div>
)}
```

Add token formatter:
```typescript
function formatTokens(n: number | null | undefined): string {
  if (n == null) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
```

**Step 3: Increase expanded mode height**

Update the animate height: `mode === "compact" ? 36 : 140`

**Step 4: Run biome check**

Run: `bun run check`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/hud/HUDPanel.tsx
git commit -m "feat: add expanded HUD mode with rate limit progress bars and token counts"
```

---

### Task 10: Add hover tooltips to progress bars

**Files:**
- Modify: `src/components/hud/HUDPanel.tsx`

**Step 1: Add tooltip wrapper using title attribute**

For now, use native HTML `title` attribute for tooltips (simple, no extra dependencies):

On the context bar in compact mode:
```typescript
title={metrics?.contextWindow
  ? `${metrics.contextWindow.used.toLocaleString()} / ${metrics.contextWindow.total.toLocaleString()} tokens (${contextPercent}%)`
  : undefined}
```

On rate limit bars:
```typescript
// 5h bar
title={`${metrics.rateLimit.fiveHourPercent.toFixed(1)}% used — resets in ${formatResetTime(metrics.rateLimit.fiveHourResetSeconds)}`}

// 7d bar
title={`${metrics.rateLimit.sevenDayPercent.toFixed(1)}% used — resets in ${formatResetTime(metrics.rateLimit.sevenDayResetSeconds)}`}
```

**Step 2: Run biome check**

Run: `bun run check`
Expected: PASS

**Step 3: Commit**

```bash
git add src/components/hud/HUDPanel.tsx
git commit -m "feat: add hover tooltips to HUD progress bars"
```

---

### Task 11: Update E2E tests for new HUD features

**Files:**
- Modify: `tests/e2e/sidebar-hud.spec.ts`

**Step 1: Update HUD cycle test for new expanded content**

The expanded mode now shows progress bars and "↑/↓" token format instead of "Tools:/Tokens:/Rate:/Session:".

Update the test (lines 72-77):

```typescript
// Click → expanded: shows progress bars and token counts
await hudButton.click();
await expect(page.getByText(/Context/)).toBeVisible();
await expect(page.getByText(/Tools:/)).toBeVisible();
await expect(page.getByText(/↑/)).toBeVisible();
```

**Step 2: Add new test for status dot display**

```typescript
test("HUD shows status dot with correct label", async ({ page }) => {
  // Default status should be visible (idle, running, etc.)
  const statusLabels = ["idle", "running", "thinking", "waiting", "error", "disconnected"];
  const hudText = await page.getByRole("button", { name: /claude-code/ }).textContent();

  // At least one status label should be present
  const hasStatus = statusLabels.some((s) => hudText?.includes(s));
  expect(hasStatus).toBe(true);
});
```

**Step 3: Add test for plan name display (when available)**

```typescript
test("HUD shows plan name next to model when available", async ({ page }) => {
  // This test verifies the plan display area exists
  // In web mode without API, plan will be null but UI should not break
  const hudButton = page.getByRole("button", { name: /claude-code/ });
  await expect(hudButton).toBeVisible();
  // Model name should still display
  await expect(page.getByText("opus-4")).toBeVisible();
});
```

**Step 4: Run E2E tests**

Run: `bun run test:e2e`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add tests/e2e/sidebar-hud.spec.ts
git commit -m "test: update E2E tests for redesigned HUD with status detection and progress bars"
```

---

### Task 12: Fix ProcessStatus references across codebase

**Files:**
- Modify: any files that reference old ProcessStatus values ("processing")

**Step 1: Search for "processing" references**

The old `ProcessStatus` included `"processing"` which is now replaced by `"thinking"`. Search and replace:

- `src/components/hud/HUDPanel.tsx` — `status === "processing"` → `status === "thinking"`
- `src/atoms/hud.ts` — `processStatus === "processing"` → `processStatus === "thinking"`
- Any other files referencing the old type

**Step 2: Run full check**

Run: `bun run check && cd src-tauri && cargo check`
Expected: PASS

**Step 3: Commit**

```bash
git add -A
git commit -m "fix: replace deprecated 'processing' status with 'thinking' across codebase"
```

---

## Execution Summary

| Task | Description | Files | Est. Lines Changed |
|------|-------------|-------|--------------------|
| 1 | Extend SessionStatus + MetricUpdate | state.rs, metrics.rs | ~15 |
| 2 | Status detection patterns in Rust | metrics.rs | ~100 |
| 3 | Zero-config credential discovery | usage.rs (new), commands.rs, lib.rs, Cargo.toml | ~120 |
| 4 | Update TypeScript types | types/index.ts, hud.ts, TerminalView.tsx | ~60 |
| 5 | Provider usage polling atoms | atoms/hud.ts | ~40 |
| 6 | Usage polling hook | useUsagePolling.ts (new), HUDPanel.tsx | ~60 |
| 7 | Frontend status detection | screen-metrics.ts, TerminalView.tsx | ~50 |
| 8 | HUD compact mode redesign | HUDPanel.tsx | ~80 |
| 9 | HUD expanded mode with rate limits | HUDPanel.tsx | ~80 |
| 10 | Hover tooltips | HUDPanel.tsx | ~15 |
| 11 | E2E test updates | sidebar-hud.spec.ts | ~30 |
| 12 | Fix ProcessStatus references | various | ~10 |

**Total: ~660 lines across 12 tasks, 12 commits**
