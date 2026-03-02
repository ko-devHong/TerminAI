use portable_pty::CommandBuilder;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedProvider {
    pub id: String,
    pub command: String,
    pub found: bool,
    pub path: Option<String>,
}

pub fn build_provider_command(provider: &str, cwd: &str) -> Result<CommandBuilder, String> {
    let command = match provider {
        "claude-code" => "claude",
        "codex-cli" => "codex",
        "gemini-cli" => "gemini",
        "custom" => {
            return Err("custom provider is not supported in Phase 1 yet".to_string());
        }
        _ => return Err(format!("unsupported provider: {provider}")),
    };

    let mut builder = CommandBuilder::new(command);
    if provider == "claude-code" {
        // Use non-interactive permissions mode without bypass warning confirmation.
        builder.arg("--permission-mode");
        builder.arg("dontAsk");
    }
    let resolved_cwd = resolve_cwd(cwd)?;
    if provider == "claude-code" {
        ensure_claude_project_trusted(&resolved_cwd);
    }
    builder.cwd(resolved_cwd);
    Ok(builder)
}

fn ensure_claude_project_trusted(project_dir: &str) {
    let Some(home) = home_dir() else {
        return;
    };
    let claude_json_path = home.join(".claude.json");
    let Ok(content) = fs::read_to_string(&claude_json_path) else {
        return;
    };
    let Ok(mut root) = serde_json::from_str::<Value>(&content) else {
        return;
    };

    let Some(root_obj) = root.as_object_mut() else {
        return;
    };
    let projects_value = root_obj
        .entry("projects".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Some(projects_obj) = projects_value.as_object_mut() else {
        return;
    };

    let project_value = projects_obj
        .entry(project_dir.to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Some(project_obj) = project_value.as_object_mut() else {
        return;
    };

    let already_trusted = project_obj
        .get("hasTrustDialogAccepted")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if already_trusted {
        return;
    }

    project_obj.insert("hasTrustDialogAccepted".to_string(), Value::Bool(true));

    if let Ok(serialized) = serde_json::to_string_pretty(&root) {
        let _ = fs::write(claude_json_path, serialized);
    }
}

fn home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        return Some(PathBuf::from(home));
    }

    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

fn resolve_cwd(cwd: &str) -> Result<String, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() || trimmed == "." {
        return home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .ok_or_else(|| "failed to resolve home directory for '.'".to_string());
    }

    let expanded = if trimmed == "~" {
        home_dir().ok_or_else(|| "failed to resolve home directory for '~'".to_string())?
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        let mut home =
            home_dir().ok_or_else(|| "failed to resolve home directory for '~/'".to_string())?;
        home.push(rest);
        home
    } else {
        PathBuf::from(trimmed)
    };

    if !Path::new(&expanded).exists() {
        return Err(format!("working directory does not exist: {}", expanded.display()));
    }

    Ok(expanded.to_string_lossy().to_string())
}

pub fn detect_providers() -> Vec<DetectedProvider> {
    let providers = [
        ("claude-code", "claude"),
        ("codex-cli", "codex"),
        ("gemini-cli", "gemini"),
    ];

    providers
        .iter()
        .map(|(id, command)| {
            let output = std::process::Command::new("which").arg(command).output().ok();

            if let Some(out) = output {
                if out.status.success() {
                    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    return DetectedProvider {
                        id: (*id).to_string(),
                        command: (*command).to_string(),
                        found: true,
                        path: Some(path),
                    };
                }
            }

            DetectedProvider {
                id: (*id).to_string(),
                command: (*command).to_string(),
                found: false,
                path: None,
            }
        })
        .collect()
}
