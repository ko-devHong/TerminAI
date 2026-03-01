use portable_pty::CommandBuilder;
use serde::Serialize;

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
    builder.cwd(cwd);
    Ok(builder)
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
