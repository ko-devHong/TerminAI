use crate::provider::{build_provider_command, detect_providers as detect_provider_paths, DetectedProvider};
use crate::state::{AppState, PtySession, SessionStatus};
use portable_pty::{native_pty_system, PtySize};
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::task;
use uuid::Uuid;

#[tauri::command]
pub async fn spawn_session(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    provider: String,
    cwd: String,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to open pty: {error}"))?;

    let mut command = build_provider_command(&provider, &cwd)?;
    command.env("TERM", "xterm-256color");

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

    let session_id = Uuid::new_v4().to_string();

    let session = Arc::new(PtySession {
        id: session_id.clone(),
        master: Arc::new(tokio::sync::Mutex::new(pair.master)),
        writer: Arc::new(tokio::sync::Mutex::new(writer)),
        child: Arc::new(tokio::sync::Mutex::new(child)),
        status: Arc::new(tokio::sync::Mutex::new(SessionStatus::Running)),
    });

    state
        .sessions
        .lock()
        .await
        .insert(session_id.clone(), Arc::clone(&session));

    emit_status(&app, &session_id, SessionStatus::Running)?;
    spawn_reader_task(app, Arc::clone(&session), reader);

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

fn spawn_reader_task(app: AppHandle, session: Arc<PtySession>, mut reader: Box<dyn Read + Send>) {
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
                                    chunk.push_str(&String::from_utf8_lossy(&pending_utf8[..valid_up_to]));
                                    pending_utf8.drain(..valid_up_to);
                                }

                                if error.error_len().is_none() {
                                    break;
                                }

                                if !pending_utf8.is_empty() {
                                    chunk.push('�');
                                    pending_utf8.drain(..1);
                                }
                            }
                        }
                    }

                    let event_name = format!("pty-output-{}", session.id);
                    if !chunk.is_empty() {
                        let _ = app.emit(event_name.as_str(), chunk);
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
