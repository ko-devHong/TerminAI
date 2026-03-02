use crate::metrics::{create_parser, MetricParser};
use crate::provider::{
    build_provider_command, detect_providers as detect_provider_paths, DetectedProvider,
};
use crate::state::{AppState, PtySession, SessionStatus};
use crate::statusline::StatuslineWatcher;
use portable_pty::{native_pty_system, PtySize};
use regex::Regex;
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::process::Command as TokioCommand;
use tokio::task;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

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
        statusline_abort: Arc::new(tokio::sync::Mutex::new(None)),
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
    let session = {
        let mut sessions = state.sessions.lock().await;
        sessions
            .remove(&session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))?
    };

    // Abort statusline poller if running
    {
        let mut abort = session.statusline_abort.lock().await;
        if let Some(handle) = abort.take() {
            handle.abort();
        }
    }

    {
        let mut child = session.child.lock().await;
        child
            .kill()
            .map_err(|error| format!("failed to kill session: {error}"))?;
    }

    {
        let mut status = session.status.lock().await;
        *status = SessionStatus::Disconnected;
    }

    emit_status(&app, &session_id, SessionStatus::Disconnected)
}

#[tauri::command]
pub async fn detect_providers() -> Result<Vec<DetectedProvider>, String> {
    Ok(detect_provider_paths())
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
    if provider != "codex-cli" {
        return Ok(None);
    }

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

fn parse_codex_status_output(text: &str) -> Option<CliQuotaSnapshot> {
    let model_re = Regex::new(r"(?im)^\s*Model:\s+([^\n(]+(?:\([^)]+\))?)").ok()?;
    let five_re = Regex::new(r"(?im)^\s*5h limit:\s+\[[^\]]*\]\s*(\d+(?:\.\d+)?)%\s*left(?:\s*\(resets\s+([^)]+)\))?").ok()?;
    let week_re =
        Regex::new(r"(?im)^\s*Weekly limit:\s+\[[^\]]*\]\s*(\d+(?:\.\d+)?)%\s*left(?:\s*\(resets\s+([^)]+)\))?").ok()?;
    let cost_re = Regex::new(r"(?im)\$\s?(\d+(?:\.\d+)?)").ok()?;

    let model = model_re
        .captures(text)
        .and_then(|c| c.get(1).map(|m| m.as_str().trim().to_string()));

    let (five_left, five_reset) = if let Some(cap) = five_re.captures(text) {
        (
            cap.get(1).and_then(|m| m.as_str().parse::<f64>().ok()),
            cap.get(2).map(|m| m.as_str().trim().to_string()),
        )
    } else {
        (None, None)
    };

    let (week_left, week_reset) = if let Some(cap) = week_re.captures(text) {
        (
            cap.get(1).and_then(|m| m.as_str().parse::<f64>().ok()),
            cap.get(2).map(|m| m.as_str().trim().to_string()),
        )
    } else {
        (None, None)
    };

    let cost = cost_re
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
    if settings.get("statusLine").is_some() {
        return Ok(StatuslineSetupResult {
            configured: false,
            already_configured: true,
        });
    }

    // Add our statusline command
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

fn spawn_statusline_poller(
    app: AppHandle,
    session: Arc<PtySession>,
    mut watcher: StatuslineWatcher,
) {
    let session_id = session.id.clone();

    let handle = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            if let Some(update) = watcher.poll() {
                let metrics_event = format!("metrics-{}", session_id);
                let _ = app.emit(metrics_event.as_str(), &update);
            }
        }
    });

    // Store abort handle so we can clean up on session kill
    let abort_handle = handle.abort_handle();
    let abort_store = session.statusline_abort.clone();
    tokio::spawn(async move {
        let mut guard = abort_store.lock().await;
        *guard = Some(abort_handle);
    });
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
                        if let Some(metric_update) = parser.parse_chunk(&chunk) {
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
