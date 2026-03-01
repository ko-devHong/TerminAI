use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

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
}

impl MetricUpdate {
    fn empty() -> Self {
        Self {
            active_tools: Vec::new(),
            model: None,
            tokens_in: None,
            tokens_out: None,
            cost: None,
            context_used: None,
            context_total: None,
        }
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.active_tools.is_empty()
            && self.model.is_none()
            && self.tokens_in.is_none()
            && self.tokens_out.is_none()
            && self.cost.is_none()
            && self.context_used.is_none()
    }
}

pub trait MetricParser: Send + Sync {
    fn parse_chunk(&mut self, data: &str) -> Option<MetricUpdate>;
    #[allow(dead_code)]
    fn provider_id(&self) -> &str;
}

// ─── Claude Code Parser ────────────────────────────────────

static CLAUDE_TOOL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"⏺\s+(Read|Edit|Grep|Write|Glob|Bash|Agent|WebFetch|WebSearch|NotebookEdit)\b").unwrap());

static CLAUDE_COST_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\$(\d+\.?\d*)").unwrap());

static CLAUDE_MODEL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(opus|sonnet|haiku)[\s\-]*(\d[\d.]*)?").unwrap());

pub struct ClaudeMetricParser {
    active_tools: Vec<String>,
    last_model: Option<String>,
    cumulative_cost: f64,
}

impl ClaudeMetricParser {
    pub fn new() -> Self {
        Self {
            active_tools: Vec::new(),
            last_model: None,
            cumulative_cost: 0.0,
        }
    }
}

impl MetricParser for ClaudeMetricParser {
    fn provider_id(&self) -> &str {
        "claude-code"
    }

    fn parse_chunk(&mut self, data: &str) -> Option<MetricUpdate> {
        let mut update = MetricUpdate::empty();
        let mut changed = false;

        // Detect tool usage
        for cap in CLAUDE_TOOL_RE.captures_iter(data) {
            let tool_name = cap[1].to_string();
            if !self.active_tools.contains(&tool_name) {
                self.active_tools.push(tool_name);
            }
            changed = true;
        }

        // Detect model
        if let Some(cap) = CLAUDE_MODEL_RE.captures(data) {
            let model = cap[0].to_lowercase().replace(' ', "-");
            self.last_model = Some(model);
            changed = true;
        }

        // Detect cost patterns like "$1.23"
        if let Some(cap) = CLAUDE_COST_RE.captures(data) {
            if let Ok(cost) = cap[1].parse::<f64>() {
                if cost > self.cumulative_cost {
                    self.cumulative_cost = cost;
                    changed = true;
                }
            }
        }

        if changed {
            update.active_tools.clone_from(&self.active_tools);
            update.model.clone_from(&self.last_model);
            update.cost = Some(self.cumulative_cost);
            Some(update)
        } else {
            None
        }
    }
}

// ─── Codex CLI Parser ──────────────────────────────────────

static CODEX_TOOL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(reading|writing|patching|running)\s+").unwrap());

pub struct CodexMetricParser {
    active_tools: Vec<String>,
}

impl CodexMetricParser {
    pub fn new() -> Self {
        Self {
            active_tools: Vec::new(),
        }
    }
}

impl MetricParser for CodexMetricParser {
    fn provider_id(&self) -> &str {
        "codex-cli"
    }

    fn parse_chunk(&mut self, data: &str) -> Option<MetricUpdate> {
        let mut update = MetricUpdate::empty();
        let mut changed = false;

        for cap in CODEX_TOOL_RE.captures_iter(data) {
            let tool = cap[1].to_string();
            if !self.active_tools.contains(&tool) {
                self.active_tools.push(tool.clone());
            }
            changed = true;
        }

        if changed {
            update.active_tools.clone_from(&self.active_tools);
            Some(update)
        } else {
            None
        }
    }
}

// ─── Gemini CLI Parser ─────────────────────────────────────

pub struct GeminiMetricParser;

impl GeminiMetricParser {
    pub fn new() -> Self {
        Self
    }
}

impl MetricParser for GeminiMetricParser {
    fn provider_id(&self) -> &str {
        "gemini-cli"
    }

    fn parse_chunk(&mut self, _data: &str) -> Option<MetricUpdate> {
        // Gemini CLI does not expose structured metrics in stdout
        None
    }
}

pub fn create_parser(provider: &str) -> Box<dyn MetricParser> {
    match provider {
        "claude-code" => Box::new(ClaudeMetricParser::new()),
        "codex-cli" => Box::new(CodexMetricParser::new()),
        "gemini-cli" => Box::new(GeminiMetricParser::new()),
        _ => Box::new(GeminiMetricParser::new()),
    }
}
