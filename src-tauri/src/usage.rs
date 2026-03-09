use chrono::{DateTime, Utc};
use serde::Serialize;
use std::process::Command;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub rate_limit: Option<RateLimit>,
    pub billing: Option<BillingInfo>,
    pub plan: Option<String>,
    /// True if data was fetched via API. False means no credentials found.
    pub has_credentials: bool,
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

/// Discovered credential.
#[derive(Debug)]
pub struct Credential {
    pub token: String,
    pub is_oauth: bool,
    pub refresh_token: Option<String>,
    pub expires_at_ms: Option<i64>,
}

// ─── Claude: macOS Keychain OAuth (zero-config) ─────────

/// Try to extract Claude Code's OAuth token from macOS Keychain.
/// Claude Code automatically stores its OAuth token here on login.
/// This is the same approach claude-hud uses — no API key needed.
fn parse_claude_oauth_json(raw: &str) -> Option<Credential> {
    let json = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let nested = json.get("claudeAiOauth").unwrap_or(&json);
    let token = nested.get("accessToken").and_then(|v| v.as_str())?;
    if token.is_empty() {
        return None;
    }
    let refresh_token = nested
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .map(ToString::to_string);
    let expires_at_ms = nested.get("expiresAt").and_then(|v| v.as_i64());

    Some(Credential {
        token: token.to_string(),
        is_oauth: true,
        refresh_token,
        expires_at_ms,
    })
}

fn find_claude_keychain_credential() -> Option<Credential> {
    // Claude Code stores tokens under these service names
    let service_names = [
        "Claude Code-credentials",
        "claude.ai",
        "api.claude.ai",
        "com.anthropic.claude-code",
    ];

    for service in &service_names {
        if let Ok(output) = Command::new("security")
            .args(["find-generic-password", "-s", service, "-w"])
            .output()
        {
            if output.status.success() {
                let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if raw.is_empty() {
                    continue;
                }

                if raw.starts_with('{') {
                    if let Some(parsed) = parse_claude_oauth_json(&raw) {
                        return Some(parsed);
                    }
                } else if !raw.is_empty() {
                    return Some(Credential {
                        token: raw,
                        is_oauth: true,
                        refresh_token: None,
                        expires_at_ms: None,
                    });
                }
            }
        }
    }

    None
}

fn find_claude_file_credential() -> Option<Credential> {
    let home = std::env::var_os("HOME")?;
    let path = std::path::PathBuf::from(home)
        .join(".claude")
        .join(".credentials.json");
    let content = std::fs::read_to_string(path).ok()?;
    parse_claude_oauth_json(&content)
}

// ─── Codex: config file + env var ───────────────────────

fn find_codex_credential() -> Option<String> {
    // Check config file first
    if let Some(home) = std::env::var_os("HOME") {
        let config_path = std::path::PathBuf::from(home).join(".codex").join("config.json");
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(key) = json.get("apiKey").and_then(|v| v.as_str()) {
                    if !key.is_empty() {
                        return Some(key.to_string());
                    }
                }
            }
        }
    }

    // Fallback: env var
    std::env::var("OPENAI_API_KEY").ok().filter(|v| !v.is_empty())
}

// ─── Gemini: config file + env var ──────────────────────

fn find_gemini_credential() -> Option<String> {
    // Check gcloud application default credentials
    if let Some(home) = std::env::var_os("HOME") {
        let adc_path = std::path::PathBuf::from(&home)
            .join(".config")
            .join("gcloud")
            .join("application_default_credentials.json");
        if adc_path.exists() {
            // ADC exists, but we can't easily use it for REST calls
            // Just note it exists
        }
    }

    // Fallback: env var
    std::env::var("GEMINI_API_KEY")
        .or_else(|_| std::env::var("GOOGLE_API_KEY"))
        .ok()
        .filter(|v| !v.is_empty())
}

/// Discover the best available credential for a provider.
pub fn discover_credential(provider: &str) -> Option<Credential> {
    match provider {
        "claude-code" => {
            // Priority 1: ~/.claude/.credentials.json OAuth token (has refresh metadata)
            if let Some(credential) = find_claude_file_credential() {
                return Some(credential);
            }
            // Priority 2: macOS Keychain OAuth (zero-config, like claude-hud)
            if let Some(credential) = find_claude_keychain_credential() {
                return Some(credential);
            }
            // Priority 3: ANTHROPIC_API_KEY env var
            if let Some(key) = std::env::var("ANTHROPIC_API_KEY").ok().filter(|v| !v.is_empty()) {
                return Some(Credential {
                    token: key,
                    is_oauth: false,
                    refresh_token: None,
                    expires_at_ms: None,
                });
            }
            None
        }
        "codex-cli" => find_codex_credential().map(|token| Credential {
            token,
            is_oauth: false,
            refresh_token: None,
            expires_at_ms: None,
        }),
        "gemini-cli" => find_gemini_credential().map(|token| Credential {
            token,
            is_oauth: false,
            refresh_token: None,
            expires_at_ms: None,
        }),
        _ => None,
    }
}

fn is_expired(expires_at_ms: Option<i64>) -> bool {
    let Some(ts) = expires_at_ms else {
        return false;
    };
    let now = Utc::now().timestamp_millis();
    ts <= now + 60_000
}

async fn refresh_claude_access_token(refresh_token: &str) -> Option<Credential> {
    let client_id = std::env::var("CLAUDE_CODE_OAUTH_CLIENT_ID")
        .unwrap_or_else(|_| "9d1c250a-e61b-44d9-88ed-5944d1962f5e".to_string());

    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id.as_str()),
    ];

    let response = reqwest::Client::new()
        .post("https://platform.claude.com/v1/oauth/token")
        .form(&params)
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let payload = response.json::<serde_json::Value>().await.ok()?;
    let access_token = payload.get("access_token").and_then(|v| v.as_str())?;
    if access_token.is_empty() {
        return None;
    }

    let refresh = payload
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(ToString::to_string)
        .or_else(|| Some(refresh_token.to_string()));

    let expires_at_ms = if let Some(expires_in) = payload.get("expires_in").and_then(|v| v.as_i64()) {
        Some(Utc::now().timestamp_millis() + (expires_in * 1000))
    } else {
        payload.get("expires_at").and_then(|v| v.as_i64())
    };

    Some(Credential {
        token: access_token.to_string(),
        is_oauth: true,
        refresh_token: refresh,
        expires_at_ms,
    })
}

// ─── API Fetching ───────────────────────────────────────

pub async fn fetch_claude_usage(credential: &Credential) -> Result<ProviderUsage, String> {
    let client = reqwest::Client::new();
    let mut working_credential = Credential {
        token: credential.token.clone(),
        is_oauth: credential.is_oauth,
        refresh_token: credential.refresh_token.clone(),
        expires_at_ms: credential.expires_at_ms,
    };

    if working_credential.is_oauth && is_expired(working_credential.expires_at_ms) {
        if let Some(refresh_token) = &working_credential.refresh_token {
            if let Some(refreshed) = refresh_claude_access_token(refresh_token).await {
                working_credential = refreshed;
            }
        }
    }

    // Prefer OAuth usage endpoint when OAuth credential is available.
    if working_credential.is_oauth {
        eprintln!("[HUD] Fetching Claude OAuth usage (token len={})", working_credential.token.len());
        let response = client
            .get("https://api.anthropic.com/api/oauth/usage")
            .header("Authorization", format!("Bearer {}", working_credential.token))
            .send()
            .await
            .map_err(|e| format!("anthropic oauth usage request failed: {e}"))?;

        let status = response.status();
        if status.as_u16() == 429 {
            eprintln!("[HUD] Claude OAuth usage API rate limited (429). Will back off.");
            return Err("rate_limited".to_string());
        }
        if !status.is_success() {
            eprintln!("[HUD] Claude OAuth usage API returned {status}");
        }
        if status.is_success() {
            let usage = response
                .json::<serde_json::Value>()
                .await
                .map_err(|e| format!("anthropic oauth usage parse failed: {e}"))?;

            let five_pct = usage
                .get("five_hour")
                .and_then(|v| v.get("utilization"))
                .and_then(|v| v.as_f64());
            let seven_pct = usage
                .get("seven_day")
                .and_then(|v| v.get("utilization"))
                .and_then(|v| v.as_f64());
            let five_reset = usage
                .get("five_hour")
                .and_then(|v| v.get("resets_at"))
                .and_then(|v| v.as_str())
                .and_then(parse_reset_timestamp)
                .unwrap_or(0);
            let seven_reset = usage
                .get("seven_day")
                .and_then(|v| v.get("resets_at"))
                .and_then(|v| v.as_str())
                .and_then(parse_reset_timestamp)
                .unwrap_or(0);

            if five_pct.is_some() || seven_pct.is_some() {
                // API returns utilization as a fraction (0.0–1.0), convert to percent
                let to_pct = |v: f64| if v <= 1.0 { v * 100.0 } else { v };
                return Ok(ProviderUsage {
                    rate_limit: Some(RateLimit {
                        five_hour_percent: five_pct.map(to_pct).unwrap_or(0.0),
                        seven_day_percent: seven_pct.map(to_pct).unwrap_or(0.0),
                        five_hour_reset_seconds: five_reset,
                        seven_day_reset_seconds: seven_reset,
                    }),
                    billing: None,
                    plan: None,
                    has_credentials: true,
                });
            }
        }
    }

    // API-key fallback: extract request limit headers from a minimal message API call.
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &working_credential.token)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .body(
            r#"{"model":"claude-sonnet-4-20250514","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}"#,
        )
        .send()
        .await
        .map_err(|e| format!("anthropic api request failed: {e}"))?;

    let headers = response.headers().clone();

    // Extract rate limit info from response headers
    let requests_limit = headers
        .get("anthropic-ratelimit-requests-limit")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());

    let requests_remaining = headers
        .get("anthropic-ratelimit-requests-remaining")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());

    let reset_seconds = headers
        .get("anthropic-ratelimit-requests-reset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| parse_reset_timestamp(v));

    let rate_limit = match (requests_limit, requests_remaining) {
        (Some(limit), Some(remaining)) if limit > 0 => {
            let used_pct = ((limit - remaining) as f64 / limit as f64) * 100.0;
            Some(RateLimit {
                five_hour_percent: used_pct,
                seven_day_percent: 0.0, // Not available from headers
                five_hour_reset_seconds: reset_seconds.unwrap_or(0),
                seven_day_reset_seconds: 0,
            })
        }
        _ => None,
    };

    Ok(ProviderUsage {
        rate_limit,
        billing: None,
        plan: None,
        has_credentials: true,
    })
}

pub async fn fetch_openai_usage(credential: &Credential) -> Result<ProviderUsage, String> {
    let client = reqwest::Client::new();

    // Check rate limit headers via a models list request (cheap)
    let response = client
        .get("https://api.openai.com/v1/models")
        .header("Authorization", format!("Bearer {}", credential.token))
        .send()
        .await
        .map_err(|e| format!("openai api request failed: {e}"))?;

    let headers = response.headers().clone();

    let requests_limit = headers
        .get("x-ratelimit-limit-requests")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());

    let requests_remaining = headers
        .get("x-ratelimit-remaining-requests")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());

    let rate_limit = match (requests_limit, requests_remaining) {
        (Some(limit), Some(remaining)) if limit > 0 => {
            let used_pct = ((limit - remaining) as f64 / limit as f64) * 100.0;
            Some(RateLimit {
                five_hour_percent: used_pct,
                seven_day_percent: 0.0,
                five_hour_reset_seconds: 0,
                seven_day_reset_seconds: 0,
            })
        }
        _ => None,
    };

    Ok(ProviderUsage {
        rate_limit,
        billing: None,
        plan: None,
        has_credentials: true,
    })
}

pub async fn fetch_gemini_usage(credential: &Credential) -> Result<ProviderUsage, String> {
    let client = reqwest::Client::new();

    // List models to check if the key works
    let response = client
        .get(format!(
            "https://generativelanguage.googleapis.com/v1beta/models?key={}",
            credential.token
        ))
        .send()
        .await
        .map_err(|e| format!("gemini api request failed: {e}"))?;

    let status = response.status();

    Ok(ProviderUsage {
        rate_limit: None, // Gemini doesn't expose rate limits in headers
        billing: None,
        plan: if status.is_success() {
            Some("active".to_string())
        } else {
            None
        },
        has_credentials: true,
    })
}

/// Parse an ISO 8601 reset timestamp into seconds from now.
fn parse_reset_timestamp(ts: &str) -> Option<u64> {
    if let Ok(secs) = ts.parse::<u64>() {
        return Some(secs);
    }

    let parsed = DateTime::parse_from_rfc3339(ts).ok()?;
    let now = Utc::now();
    let diff = parsed.with_timezone(&Utc).timestamp() - now.timestamp();
    Some(diff.max(0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discover_credential_returns_none_for_unknown_provider() {
        assert!(discover_credential("unknown-provider").is_none());
    }

    #[test]
    fn parse_reset_timestamp_parses_seconds() {
        assert_eq!(parse_reset_timestamp("3600"), Some(3600));
        assert_eq!(parse_reset_timestamp("0"), Some(0));
    }

    #[test]
    fn parse_reset_timestamp_iso_fallback() {
        assert!(parse_reset_timestamp("2026-03-02T12:00:00Z").is_some());
    }
}
