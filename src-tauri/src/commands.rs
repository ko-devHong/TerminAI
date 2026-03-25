use crate::file_watcher::FileWatcher;
use crate::metrics::{create_parser, MetricParser};
use crate::provider::{
    build_provider_command, detect_providers as detect_provider_paths, DetectedProvider,
};
use crate::state::{AppState, PtySession, SessionStatus};
use crate::statusline::StatuslineWatcher;
use crate::transcript::{discover_transcript_path, TranscriptWatcher};
use portable_pty::{native_pty_system, PtySize};
use regex::Regex;
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::{Arc, LazyLock};
use tauri::{AppHandle, Emitter};
use tokio::process::Command as TokioCommand;
use tokio::task;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

// ── Static regexes (compiled once) ──────────────────────────────────────────

static CODEX_MODEL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^\s*Model:\s+([^\n(]+(?:\([^)]+\))?)").unwrap()
});
static CODEX_FIVE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^\s*5h limit:\s+\[[^\]]*\]\s*(\d+(?:\.\d+)?)%\s*left(?:\s*\(resets\s+([^)]+)\))?").unwrap()
});
static CODEX_WEEK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^\s*Weekly limit:\s+\[[^\]]*\]\s*(\d+(?:\.\d+)?)%\s*left(?:\s*\(resets\s+([^)]+)\))?").unwrap()
});
static CODEX_COST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)\$\s?(\d+(?:\.\d+)?)").unwrap()
});
static GEMINI_ROW_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^\s*(gemini-[\w.-]+)\s+\S+\s+(\d+(?:\.\d+)?)%\s+resets\s+in\s+([0-9hms ]+)\s*$").unwrap()
});
static GEMINI_HOURS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d+)h").unwrap()
});
static GEMINI_MINS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d+)m").unwrap()
});

#[tauri::command]
pub async fn spawn_session(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    provider: String,
    cwd: String,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pty_rows = 40_u16;
    let pty_cols = 120_u16;

    let pair = pty_system
        .openpty(PtySize {
            rows: pty_rows,
            cols: pty_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to open pty: {error}"))?;

    let session_id = Uuid::new_v4().to_string();

    let mut command = build_provider_command(&provider, &cwd)?;
    command.env("TERM", "xterm-256color");
    command.env("COLUMNS", pty_cols.to_string());
    command.env("LINES", pty_rows.to_string());
    command.env("COLORTERM", "truecolor");

    // Set statusline file path for claude-code sessions
    let statusline_watcher = if provider == "claude-code" {
        let watcher = StatuslineWatcher::new(&session_id);
        command.env("TERMINAI_SL_PATH", watcher.sl_file_path());
        Some(watcher)
    } else {
        None
    };

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to spawn provider: {error}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to clone pty reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("failed to take pty writer: {error}"))?;

    let session = Arc::new(PtySession {
        id: session_id.clone(),
        master: Arc::new(tokio::sync::Mutex::new(pair.master)),
        writer: Arc::new(tokio::sync::Mutex::new(writer)),
        child: Arc::new(tokio::sync::Mutex::new(child)),
        status: Arc::new(tokio::sync::Mutex::new(SessionStatus::Running)),
        statusline_abort: Arc::new(std::sync::Mutex::new(None)),
    });

    state
        .sessions
        .lock()
        .await
        .insert(session_id.clone(), Arc::clone(&session));

    emit_status(&app, &session_id, SessionStatus::Running)?;

    let parser = create_parser(&provider);
    spawn_reader_task(app.clone(), Arc::clone(&session), reader, parser);

    // Spawn statusline poller for claude-code sessions
    if let Some(watcher) = statusline_watcher {
        spawn_statusline_poller(app, Arc::clone(&session), watcher);
    }

    Ok(session_id)
}

#[tauri::command]
pub async fn write_to_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| format!("session not found: {session_id}"))?
    };

    let mut writer = session.writer.lock().await;
    writer
        .write_all(data.as_bytes())
        .map_err(|error| format!("failed to write to session: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("failed to flush session writer: {error}"))?;

    Ok(())
}

#[tauri::command]
pub async fn resize_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| format!("session not found: {session_id}"))?
    };

    let master = session.master.lock().await;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to resize session: {error}"))?;

    Ok(())
}

#[tauri::command]
pub async fn kill_session(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    // First, get a reference to the session without removing it yet.
    // This prevents write_to_session from failing with "session not found"
    // while we're still killing the process.
    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| format!("session not found: {session_id}"))?
    };

    // Mark status as disconnected first to signal other tasks
    {
        let mut status = session.status.lock().await;
        *status = SessionStatus::Disconnected;
    }

    // Abort statusline poller if running
    {
        if let Ok(mut abort) = session.statusline_abort.lock() {
            if let Some(handle) = abort.take() {
                handle.abort();
            }
        }
    }

    // Kill the child process
    {
        let mut child = session.child.lock().await;
        let _ = child.kill();
        let _ = child.wait();
    }

    // Now remove from the map after cleanup is done
    {
        let mut sessions = state.sessions.lock().await;
        sessions.remove(&session_id);
    }

    // Clean up the statusline /tmp file for this session
    StatuslineWatcher::new(&session_id).cleanup();

    emit_status(&app, &session_id, SessionStatus::Disconnected)
}

#[tauri::command]
pub async fn detect_providers() -> Result<Vec<DetectedProvider>, String> {
    // detect_provider_paths uses std::process::Command (blocking I/O).
    // Run on a blocking thread to avoid starving the tokio runtime.
    tokio::task::spawn_blocking(detect_provider_paths)
        .await
        .map_err(|e| format!("detect_providers join error: {e}"))
}

#[tauri::command]
pub async fn fetch_provider_usage(
    provider: String,
) -> Result<Option<crate::usage::ProviderUsage>, String> {
    let credential = match crate::usage::discover_credential(&provider) {
        Some(c) => c,
        None => {
            // No credentials found — return marker so frontend can show "API key needed"
            return Ok(Some(crate::usage::ProviderUsage {
                rate_limit: None,
                billing: None,
                plan: None,
                has_credentials: false,
            }));
        }
    };

    match provider.as_str() {
        "claude-code" => crate::usage::fetch_claude_usage(&credential).await.map(Some),
        "codex-cli" => crate::usage::fetch_openai_usage(&credential).await.map(Some),
        "gemini-cli" => crate::usage::fetch_gemini_usage(&credential).await.map(Some),
        _ => Ok(None),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliQuotaSnapshot {
    pub provider: String,
    pub model: Option<String>,
    pub five_hour_left_percent: Option<f64>,
    pub seven_day_left_percent: Option<f64>,
    pub five_hour_reset_label: Option<String>,
    pub seven_day_reset_label: Option<String>,
    pub cost_usd: Option<f64>,
}

#[tauri::command]
pub async fn fetch_cli_quota(provider: String, cwd: String) -> Result<Option<CliQuotaSnapshot>, String> {
    let validated_cwd = validate_cwd(&cwd)?;
    let cwd = validated_cwd.to_string_lossy().to_string();
    match provider.as_str() {
        "codex-cli" => {
            let output = timeout(
                Duration::from_secs(4),
                TokioCommand::new("codex")
                    .arg("-C")
                    .arg(cwd)
                    .arg("exec")
                    .arg("--skip-git-repo-check")
                    .arg("/status")
                    .output(),
            )
            .await;

            let output = match output {
                Ok(Ok(output)) => output,
                Ok(Err(e)) => return Err(format!("failed to execute codex status: {e}")),
                Err(_) => return Ok(None),
            };

            if !output.status.success() {
                return Ok(None);
            }

            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            Ok(parse_codex_status_output(&stdout))
        }
        "gemini-cli" => {
            let output = timeout(
                Duration::from_secs(4),
                TokioCommand::new("gemini")
                    .arg("--non-interactive")
                    .arg("-p")
                    .arg("/usage")
                    .current_dir(if cwd.is_empty() { ".".to_string() } else { cwd })
                    .output(),
            )
            .await;

            let output = match output {
                Ok(Ok(output)) => output,
                // gemini CLI not installed or other I/O error — graceful fallback
                Ok(Err(_)) => return Ok(None),
                // timeout
                Err(_) => return Ok(None),
            };

            let text = String::from_utf8_lossy(&output.stdout).to_string()
                + &String::from_utf8_lossy(&output.stderr).to_string();
            Ok(parse_gemini_usage_output(&text))
        }
        _ => Ok(None),
    }
}

#[tauri::command]
pub async fn get_project_root() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("failed to get current dir: {e}"))
}

fn parse_codex_status_output(text: &str) -> Option<CliQuotaSnapshot> {
    let model = CODEX_MODEL_RE
        .captures(text)
        .and_then(|c| c.get(1).map(|m| m.as_str().trim().to_string()));

    let (five_left, five_reset) = if let Some(cap) = CODEX_FIVE_RE.captures(text) {
        (
            cap.get(1).and_then(|m| m.as_str().parse::<f64>().ok()),
            cap.get(2).map(|m| m.as_str().trim().to_string()),
        )
    } else {
        (None, None)
    };

    let (week_left, week_reset) = if let Some(cap) = CODEX_WEEK_RE.captures(text) {
        (
            cap.get(1).and_then(|m| m.as_str().parse::<f64>().ok()),
            cap.get(2).map(|m| m.as_str().trim().to_string()),
        )
    } else {
        (None, None)
    };

    let cost = CODEX_COST_RE
        .captures(text)
        .and_then(|c| c.get(1).and_then(|m| m.as_str().parse::<f64>().ok()));

    if model.is_none() && five_left.is_none() && week_left.is_none() && cost.is_none() {
        return None;
    }

    Some(CliQuotaSnapshot {
        provider: "codex-cli".to_string(),
        model,
        five_hour_left_percent: five_left,
        seven_day_left_percent: week_left,
        five_hour_reset_label: five_reset,
        seven_day_reset_label: week_reset,
        cost_usd: cost,
    })
}

fn parse_gemini_usage_output(text: &str) -> Option<CliQuotaSnapshot> {
    let mut model: Option<String> = None;
    let mut short_left: Option<f64> = None;
    let mut short_reset: Option<String> = None;
    let mut long_left: Option<f64> = None;
    let mut long_reset: Option<String> = None;

    for cap in GEMINI_ROW_RE.captures_iter(text) {
        let row_model = cap.get(1).map(|m| m.as_str().trim().to_string());
        let remaining: f64 = match cap.get(2).and_then(|m| m.as_str().parse().ok()) {
            Some(v) => v,
            None => continue,
        };
        let reset_label = cap
            .get(3)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();

        if model.is_none() {
            model = row_model;
        }

        // Classify window by reset duration: <=8h → short (RPM/RPH), else long (RPD)
        let hours: f64 = GEMINI_HOURS_RE
            .captures(&reset_label)
            .and_then(|c| c.get(1).and_then(|m| m.as_str().parse().ok()))
            .unwrap_or(0.0);
        let mins: f64 = GEMINI_MINS_RE
            .captures(&reset_label)
            .and_then(|c| c.get(1).and_then(|m| m.as_str().parse().ok()))
            .unwrap_or(0.0);
        let total_hours = hours + mins / 60.0;
        let is_short = total_hours > 0.0 && total_hours <= 8.0;

        if is_short {
            if short_left.is_none() || remaining < short_left.unwrap_or(f64::MAX) {
                short_left = Some(remaining);
                short_reset = Some(format!("in {reset_label}"));
            }
        } else if long_left.is_none() || remaining < long_left.unwrap_or(f64::MAX) {
            long_left = Some(remaining);
            long_reset = Some(format!("in {reset_label}"));
        }
    }

    if model.is_none() && short_left.is_none() && long_left.is_none() {
        return None;
    }

    Some(CliQuotaSnapshot {
        provider: "gemini-cli".to_string(),
        model,
        five_hour_left_percent: short_left,
        seven_day_left_percent: long_left,
        five_hour_reset_label: short_reset,
        seven_day_reset_label: long_reset,
        cost_usd: None,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatuslineSetupResult {
    configured: bool,
    already_configured: bool,
}

#[tauri::command]
pub async fn setup_claude_statusline() -> Result<StatuslineSetupResult, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "cannot determine home directory".to_string())?;

    let settings_path = std::path::PathBuf::from(&home).join(".claude").join("settings.json");

    // Read existing settings or start fresh
    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path)
            .map_err(|e| format!("failed to read settings: {e}"))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("failed to parse settings: {e}"))?
    } else {
        serde_json::json!({})
    };

    // Check if statusLine is already configured
    if let Some(sl) = settings.get("statusLine") {
        let existing_cmd = sl.get("command").and_then(|c| c.as_str()).unwrap_or("");
        if existing_cmd.contains("TERMINAI_SL_PATH") {
            return Ok(StatuslineSetupResult {
                configured: false,
                already_configured: true,
            });
        }
        // Another tool's statusline exists (e.g. oh-my-claudecode) — chain with tee
        // so both TerminAI AND the existing tool receive stdin data
        if !existing_cmd.is_empty() {
            let chained = format!(
                "sh -c 'if [ -n \"$TERMINAI_SL_PATH\" ]; then tee \"$TERMINAI_SL_PATH\" 2>/dev/null | {}; else {}; fi'",
                existing_cmd.replace('\'', "'\\''"),
                existing_cmd.replace('\'', "'\\''")
            );
            settings["statusLine"] = serde_json::json!({
                "type": "command",
                "command": chained
            });

            if let Some(parent) = settings_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let formatted = serde_json::to_string_pretty(&settings)
                .map_err(|e| format!("failed to serialize settings: {e}"))?;
            std::fs::write(&settings_path, formatted)
                .map_err(|e| format!("failed to write settings: {e}"))?;

            return Ok(StatuslineSetupResult {
                configured: true,
                already_configured: false,
            });
        }
    }

    // No statusline configured — add ours
    settings["statusLine"] = serde_json::json!({
        "type": "command",
        "command": "sh -c 'cat > \"$TERMINAI_SL_PATH\" 2>/dev/null || true'"
    });

    // Ensure .claude directory exists
    if let Some(parent) = settings_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let formatted = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("failed to serialize settings: {e}"))?;
    std::fs::write(&settings_path, formatted)
        .map_err(|e| format!("failed to write settings: {e}"))?;

    Ok(StatuslineSetupResult {
        configured: true,
        already_configured: false,
    })
}

#[tauri::command]
pub async fn setup_mcp_bridge(provider: String, project_root: String) -> Result<StatuslineSetupResult, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "cannot determine home directory".to_string())?;

    // MCP Bridge absolute path
    let bridge_path = std::path::PathBuf::from(&project_root)
        .join("terminai-mcp-bridge")
        .join("index.ts");
    
    let bridge_path_str = bridge_path.to_str()
        .ok_or_else(|| "invalid bridge path".to_string())?;

    if provider == "claude-code" {
        let settings_path = std::path::PathBuf::from(&home).join(".claude").join("settings.json");
        let mut settings: serde_json::Value = if settings_path.exists() {
            let content = std::fs::read_to_string(&settings_path)
                .map_err(|e| format!("failed to read settings: {e}"))?;
            serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        // Ensure mcpServers object exists
        if settings.get("mcpServers").is_none() {
            settings["mcpServers"] = serde_json::json!({});
        }

        // Add or update terminai-bridge
        settings["mcpServers"]["terminai-bridge"] = serde_json::json!({
            "command": "bun",
            "args": ["run", bridge_path_str]
        });

        if let Some(parent) = settings_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let formatted = serde_json::to_string_pretty(&settings)
            .map_err(|e| format!("failed to serialize settings: {e}"))?;
        std::fs::write(&settings_path, formatted)
            .map_err(|e| format!("failed to write settings: {e}"))?;

        return Ok(StatuslineSetupResult {
            configured: true,
            already_configured: false,
        });
    }

    // Codex/Gemini: Future implementation based on their specific config locations
    Ok(StatuslineSetupResult {
        configured: false,
        already_configured: false,
    })
}

fn spawn_statusline_poller(
    app: AppHandle,
    session: Arc<PtySession>,
    mut watcher: StatuslineWatcher,
) {
    let session_id = session.id.clone();
    let sl_path = std::path::PathBuf::from(watcher.sl_file_path().to_string());

    let handle = tokio::spawn(async move {
        let mut first_data_received = false;
        let session_start = std::time::SystemTime::now();

        // Transcript watcher state
        let mut transcript_watcher: Option<TranscriptWatcher> = None;

        // Set up file watcher for statusline JSON (event-driven, replaces 500ms polling)
        let (mut sl_rx, _fw_handle) = match FileWatcher::watch(sl_path) {
            Ok((fw, rx)) => (rx, Some(fw)),
            Err(e) => {
                tracing::warn!("[statusline] file watcher failed, falling back to polling: {e}");
                // Fallback: create a channel that we'll feed manually via a poll loop
                let (tx, rx) = tokio::sync::mpsc::channel(16);
                let fallback_path =
                    std::path::PathBuf::from(watcher.sl_file_path().to_string());
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        if tx.send(fallback_path.clone()).await.is_err() {
                            break;
                        }
                    }
                });
                (rx, None)
            }
        };

        // Transcript poll timer (1s interval, independent of statusline events)
        let mut transcript_interval = tokio::time::interval(std::time::Duration::from_secs(1));
        // Timeout for initial data: try transcript discovery after 10s of no statusline data
        let mut discovery_attempted = false;

        loop {
            tokio::select! {
                // Statusline file changed (event-driven via notify)
                Some(_path) = sl_rx.recv() => {
                    if let Some(update) = watcher.poll() {
                        if !first_data_received {
                            first_data_received = true;
                            tracing::info!("[statusline] first data received for session {}", session_id);
                        }
                        let metrics_event = format!("metrics-{}", session_id);
                        let _ = app.emit(metrics_event.as_str(), &update);

                        // Pick up transcript_path from statusline
                        if transcript_watcher.is_none() {
                            if let Some(path) = watcher.last_transcript_path() {
                                tracing::info!("[transcript] using path from statusline: {}", path);
                                transcript_watcher =
                                    Some(TranscriptWatcher::new(std::path::PathBuf::from(path)));
                            }
                        }
                    }
                }
                // Transcript poll (1s timer, separate from statusline events)
                _ = transcript_interval.tick() => {
                    // Attempt transcript discovery if no statusline data after 10s
                    if !first_data_received && !discovery_attempted {
                        let elapsed = session_start.elapsed().unwrap_or_default();
                        if elapsed.as_secs() >= 10 && transcript_watcher.is_none() {
                            discovery_attempted = true;
                            if let Some(path) = discover_transcript_path(session_start) {
                                tracing::info!(
                                    "[transcript] discovered path via fallback scan: {}",
                                    path.display()
                                );
                                transcript_watcher = Some(TranscriptWatcher::new(path));
                            }
                        }
                    }

                    if let Some(ref mut tw) = transcript_watcher {
                        if let Some(update) = tw.poll() {
                            let metrics_event = format!("metrics-{}", session_id);
                            let _ = app.emit(metrics_event.as_str(), &update);
                        }
                    }
                }
            }
        }
    });

    // Store abort handle synchronously so kill_session always sees it
    let abort_handle = handle.abort_handle();
    if let Ok(mut guard) = session.statusline_abort.lock() {
        *guard = Some(abort_handle);
    }
}

fn spawn_reader_task(
    app: AppHandle,
    session: Arc<PtySession>,
    mut reader: Box<dyn Read + Send>,
    mut parser: Box<dyn MetricParser>,
) {
    task::spawn_blocking(move || {
        let mut buf = vec![0_u8; 16 * 1024];
        let mut pending_utf8: Vec<u8> = Vec::new();

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    if !pending_utf8.is_empty() {
                        let tail = String::from_utf8_lossy(&pending_utf8).to_string();
                        let event_name = format!("pty-output-{}", session.id);
                        let _ = app.emit(event_name.as_str(), tail);
                        pending_utf8.clear();
                    }
                    let _ = emit_status(&app, &session.id, SessionStatus::Disconnected);
                    break;
                }
                Ok(size) => {
                    pending_utf8.extend_from_slice(&buf[..size]);
                    let mut chunk = String::new();

                    loop {
                        match std::str::from_utf8(&pending_utf8) {
                            Ok(valid) => {
                                chunk.push_str(valid);
                                pending_utf8.clear();
                                break;
                            }
                            Err(error) => {
                                let valid_up_to = error.valid_up_to();
                                if valid_up_to > 0 {
                                    chunk.push_str(
                                        &String::from_utf8_lossy(&pending_utf8[..valid_up_to]),
                                    );
                                    pending_utf8.drain(..valid_up_to);
                                }

                                if error.error_len().is_none() {
                                    break;
                                }

                                if !pending_utf8.is_empty() {
                                    chunk.push('\u{FFFD}');
                                    pending_utf8.drain(..1);
                                }
                            }
                        }
                    }

                    if !chunk.is_empty() {
                        let event_name = format!("pty-output-{}", session.id);
                        let _ = app.emit(event_name.as_str(), &chunk);

                        // Parse metrics from the chunk
                        if let Some(mut metric_update) = parser.parse_chunk(&chunk) {
                            metric_update.source = Some("pty-regex".to_string());
                            let metrics_event = format!("metrics-{}", session.id);
                            let _ = app.emit(metrics_event.as_str(), &metric_update);

                            // Forward detected status to session-status event
                            if let Some(ref status_str) = metric_update.status {
                                let session_status = match status_str.as_str() {
                                    "thinking" => SessionStatus::Thinking,
                                    "waiting" => SessionStatus::Waiting,
                                    "idle" => SessionStatus::Idle,
                                    "error" => SessionStatus::Error,
                                    _ => SessionStatus::Running,
                                };
                                let _ = emit_status(&app, &session.id, session_status);
                            }
                        }
                    }
                }
                Err(_) => {
                    if !pending_utf8.is_empty() {
                        let tail = String::from_utf8_lossy(&pending_utf8).to_string();
                        let event_name = format!("pty-output-{}", session.id);
                        let _ = app.emit(event_name.as_str(), tail);
                    }
                    let _ = emit_status(&app, &session.id, SessionStatus::Error);
                    break;
                }
            }
        }
    });
}

fn emit_status(app: &AppHandle, session_id: &str, status: SessionStatus) -> Result<(), String> {
    let event_name = format!("session-status-{session_id}");
    app.emit(event_name.as_str(), status)
        .map_err(|error| format!("failed to emit status event: {error}"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmcState {
    pub active_mode: Option<String>,
    pub phase: Option<String>,
    pub iteration: Option<u32>,
}

fn validate_cwd(cwd: &str) -> Result<std::path::PathBuf, String> {
    let canonical = std::fs::canonicalize(cwd)
        .map_err(|_| "invalid working directory".to_string())?;
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() && !canonical.starts_with(&home) {
        return Err("cwd must be under home directory".to_string());
    }
    Ok(canonical)
}

#[tauri::command]
pub async fn fetch_omc_state(cwd: String) -> Result<Option<OmcState>, String> {
    let canonical = validate_cwd(&cwd)?;

    tokio::task::spawn_blocking(move || {
        let state_dir = canonical.join(".omc").join("state");
        if !state_dir.exists() {
            return Ok(None);
        }

        let modes = ["ralph", "autopilot", "ultrawork", "team", "ultraqa", "ralplan"];
        for mode in &modes {
            let file = state_dir.join(format!("{mode}-state.json"));
            if let Ok(content) = std::fs::read_to_string(&file) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                    if json.get("active").and_then(|v| v.as_bool()) == Some(true) {
                        return Ok(Some(OmcState {
                            active_mode: Some(mode.to_string()),
                            phase: json.get("current_phase").and_then(|v| v.as_str()).map(String::from),
                            iteration: json.get("iteration").and_then(|v| v.as_u64()).map(|v| v as u32),
                        }));
                    }
                }
            }
        }

        Ok(None)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
pub async fn fetch_git_branch(cwd: String) -> Result<Option<String>, String> {
    let canonical = validate_cwd(&cwd)?;

    let output = TokioCommand::new("git")
        .arg("rev-parse")
        .arg("--abbrev-ref")
        .arg("HEAD")
        .current_dir(&canonical)
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if branch.is_empty() { Ok(None) } else { Ok(Some(branch)) }
        }
        _ => Ok(None),
    }
}
