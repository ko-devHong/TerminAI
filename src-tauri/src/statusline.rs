use crate::metrics::MetricUpdate;
use serde::Deserialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::SystemTime;

#[derive(Debug, Deserialize)]
struct StatuslineJson {
    model: Option<StatuslineModel>,
    context_window: Option<StatuslineContext>,
    cost: Option<StatuslineCost>,
}

#[derive(Debug, Deserialize)]
struct StatuslineModel {
    display_name: Option<String>,
    #[allow(dead_code)]
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StatuslineContext {
    used_percentage: Option<f64>,
    context_window_size: Option<u64>,
    total_input_tokens: Option<u64>,
    total_output_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct StatuslineCost {
    total_cost_usd: Option<f64>,
}

pub struct StatuslineWatcher {
    sl_file_path: PathBuf,
    last_modified: Option<SystemTime>,
    last_content_hash: u64,
}

impl StatuslineWatcher {
    pub fn new(session_id: &str) -> Self {
        let sl_file_path = PathBuf::from(format!("/tmp/terminai-sl-{session_id}.json"));
        Self {
            sl_file_path,
            last_modified: None,
            last_content_hash: 0,
        }
    }

    pub fn sl_file_path(&self) -> &str {
        self.sl_file_path.to_str().unwrap_or("")
    }

    /// Poll the statusline file for changes.
    /// Returns `Some(MetricUpdate)` if the file was updated with new data.
    pub fn poll(&mut self) -> Option<MetricUpdate> {
        let metadata = std::fs::metadata(&self.sl_file_path).ok()?;
        let modified = metadata.modified().ok()?;

        // Skip if file hasn't been modified
        if Some(modified) == self.last_modified {
            return None;
        }

        let content = std::fs::read_to_string(&self.sl_file_path).ok()?;

        // Avoid re-parsing identical content
        let mut hasher = DefaultHasher::new();
        content.hash(&mut hasher);
        let hash = hasher.finish();
        if hash == self.last_content_hash {
            self.last_modified = Some(modified);
            return None;
        }

        self.last_modified = Some(modified);
        self.last_content_hash = hash;

        let json: StatuslineJson = serde_json::from_str(&content).ok()?;
        Some(to_metric_update(&json))
    }

    #[allow(dead_code)]
    pub fn cleanup(&self) {
        let _ = std::fs::remove_file(&self.sl_file_path);
    }
}

fn to_metric_update(json: &StatuslineJson) -> MetricUpdate {
    let model = json
        .model
        .as_ref()
        .and_then(|m| m.display_name.clone());

    let (context_used, context_total) = match &json.context_window {
        Some(ctx) => {
            let total = ctx.context_window_size.unwrap_or(0);
            let used = if let Some(pct) = ctx.used_percentage {
                // Compute used tokens from percentage
                ((pct / 100.0) * total as f64) as u64
            } else {
                // Fall back to sum of input + output tokens
                let input = ctx.total_input_tokens.unwrap_or(0);
                let output = ctx.total_output_tokens.unwrap_or(0);
                input + output
            };
            (Some(used), Some(total))
        }
        None => (None, None),
    };

    let tokens_in = json
        .context_window
        .as_ref()
        .and_then(|c| c.total_input_tokens);
    let tokens_out = json
        .context_window
        .as_ref()
        .and_then(|c| c.total_output_tokens);

    let cost = json.cost.as_ref().and_then(|c| c.total_cost_usd);

    MetricUpdate {
        active_tools: Vec::new(),
        model,
        tokens_in,
        tokens_out,
        cost,
        context_used,
        context_total,
        status: None,
        rate_limit_seconds: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_full_statusline_json() {
        let json_str = r#"{
            "model": { "display_name": "opus-4", "id": "claude-opus-4-6" },
            "context_window": {
                "used_percentage": 42.5,
                "context_window_size": 200000,
                "total_input_tokens": 50000,
                "total_output_tokens": 35000
            },
            "cost": { "total_cost_usd": 1.23 }
        }"#;

        let json: StatuslineJson = serde_json::from_str(json_str).unwrap();
        let update = to_metric_update(&json);

        assert_eq!(update.model, Some("opus-4".to_string()));
        assert_eq!(update.context_used, Some(85000)); // 42.5% of 200000
        assert_eq!(update.context_total, Some(200000));
        assert_eq!(update.tokens_in, Some(50000));
        assert_eq!(update.tokens_out, Some(35000));
        assert_eq!(update.cost, Some(1.23));
    }

    #[test]
    fn parse_minimal_statusline_json() {
        let json_str = r#"{}"#;
        let json: StatuslineJson = serde_json::from_str(json_str).unwrap();
        let update = to_metric_update(&json);

        assert_eq!(update.model, None);
        assert_eq!(update.context_used, None);
        assert_eq!(update.cost, None);
    }
}
