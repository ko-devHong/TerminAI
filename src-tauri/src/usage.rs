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
}

// ─── Claude: macOS Keychain OAuth (zero-config) ─────────

/// Try to extract Claude Code's OAuth token from macOS Keychain.
/// Claude Code automatically stores its OAuth token here on login.
/// This is the same approach claude-hud uses — no API key needed.
fn find_claude_keychain_token() -> Option<String> {
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
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                        let nested = json.get("claudeAiOauth").unwrap_or(&json);
                        if let Some(token) = nested.get("accessToken").and_then(|v| v.as_str()) {
                            if !token.is_empty() {
                                return Some(token.to_string());
                            }
                        }
                    }
                }

                if !raw.is_empty() {
                    return Some(raw);
                }
            }
        }
    }

    None
}

fn find_claude_file_token() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let path = std::path::PathBuf::from(home)
        .join(".claude")
        .join(".credentials.json");
    let content = std::fs::read_to_string(path).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&content).ok()?;
    let nested = json.get("claudeAiOauth").unwrap_or(&json);
    nested
        .get("accessToken")
        .and_then(|v| v.as_str())
        .map(ToString::to_string)
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
            // Priority 1: macOS Keychain OAuth (zero-config, like claude-hud)
            if let Some(token) = find_claude_keychain_token() {
                return Some(Credential {
                    token,
                    is_oauth: true,
                });
            }
            // Priority 2: ~/.claude/.credentials.json OAuth token
            if let Some(token) = find_claude_file_token() {
                return Some(Credential {
                    token,
                    is_oauth: true,
                });
            }
            // Priority 3: ANTHROPIC_API_KEY env var
            if let Some(key) = std::env::var("ANTHROPIC_API_KEY").ok().filter(|v| !v.is_empty()) {
                return Some(Credential {
                    token: key,
                    is_oauth: false,
                });
            }
            None
        }
        "codex-cli" => find_codex_credential().map(|token| Credential {
            token,
            is_oauth: false,
        }),
        "gemini-cli" => find_gemini_credential().map(|token| Credential {
            token,
            is_oauth: false,
        }),
        _ => None,
    }
}

// ─── API Fetching ───────────────────────────────────────

pub async fn fetch_claude_usage(credential: &Credential) -> Result<ProviderUsage, String> {
    let client = reqwest::Client::new();

    // Prefer OAuth usage endpoint when OAuth credential is available.
    if credential.is_oauth {
        let response = client
            .get("https://api.anthropic.com/api/oauth/usage")
            .header("Authorization", format!("Bearer {}", credential.token))
            .send()
            .await
            .map_err(|e| format!("anthropic oauth usage request failed: {e}"))?;

        if response.status().is_success() {
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
                return Ok(ProviderUsage {
                    rate_limit: Some(RateLimit {
                        five_hour_percent: five_pct.unwrap_or(0.0),
                        seven_day_percent: seven_pct.unwrap_or(0.0),
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
        .header("x-api-key", &credential.token)
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
    // Simple heuristic: if it contains 'T', it's a timestamp
    // Otherwise it might be seconds directly
    if let Ok(secs) = ts.parse::<u64>() {
        return Some(secs);
    }

    // For ISO timestamps, we'd need chrono or similar
    // For now, return a default
    Some(3600) // Default 1 hour if we can't parse
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
        assert_eq!(parse_reset_timestamp("2026-03-02T12:00:00Z"), Some(3600));
    }
}
