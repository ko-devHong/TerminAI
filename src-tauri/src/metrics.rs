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
}

pub trait MetricParser: Send + Sync {
    fn parse_chunk(&mut self, data: &str) -> Option<MetricUpdate>;
    #[allow(dead_code)]
    fn provider_id(&self) -> &str;
}

/// Strip ANSI escape sequences so regexes can match plain text.
static ANSI_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]").unwrap());

fn strip_ansi(s: &str) -> String {
    ANSI_RE.replace_all(s, "").to_string()
}

// ─── Claude Code Parser ────────────────────────────────────

static CLAUDE_TOOL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"⏺\s+(Read|Edit|Grep|Write|Glob|Bash|Agent|WebFetch|WebSearch|NotebookEdit|TodoRead|TodoWrite|Skill|ToolSearch)\b").unwrap()
});

// Match cost: "$1.23", "$ 1.23", "Cost: $1.23", "cost=$1.23"
static CLAUDE_COST_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\$\s?(\d+\.?\d*)").unwrap());

// Match model: "opus-4", "sonnet-4", "haiku-4.5", "claude-opus-4-6"
static CLAUDE_MODEL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(claude[- ])?(opus|sonnet|haiku)[- ]?(\d[\d.]*)?\b").unwrap());

// Match token counts: "5.2k in, 1.1k out", "5200 in / 1100 out", "5.2k↑ 1.1k↓"
static CLAUDE_TOKENS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d+\.?\d*)\s*[kK]?\s*(?:↑|in)\b[,\s/|]*(\d+\.?\d*)\s*[kK]?\s*(?:↓|out)\b")
        .unwrap()
});

// Match context: "12% context", "context 40%", "3.2k / 200k"
static CLAUDE_CONTEXT_PERCENT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(\d+)%\s*context|context\s*(\d+)%").unwrap());

static CLAUDE_CONTEXT_FRACTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d+\.?\d*)\s*[kK]?\s*/\s*(\d+\.?\d*)\s*[kK]").unwrap()
});

fn parse_k_number(s: &str, raw: &str) -> u64 {
    let n: f64 = s.parse().unwrap_or(0.0);
    if raw.contains('k') || raw.contains('K') {
        (n * 1000.0) as u64
    } else if n < 100.0 && !raw.contains('.') {
        // small number without k likely already in thousands
        n as u64
    } else {
        n as u64
    }
}

pub struct ClaudeMetricParser {
    active_tools: Vec<String>,
    last_model: Option<String>,
    cumulative_cost: f64,
    tokens_in: Option<u64>,
    tokens_out: Option<u64>,
    context_used: Option<u64>,
    context_total: Option<u64>,
}

impl ClaudeMetricParser {
    pub fn new() -> Self {
        Self {
            active_tools: Vec::new(),
            last_model: None,
            cumulative_cost: 0.0,
            tokens_in: None,
            tokens_out: None,
            context_used: None,
            context_total: None,
        }
    }
}

impl MetricParser for ClaudeMetricParser {
    fn provider_id(&self) -> &str {
        "claude-code"
    }

    fn parse_chunk(&mut self, data: &str) -> Option<MetricUpdate> {
        let clean = strip_ansi(data);
        let mut update = MetricUpdate::empty();
        let mut changed = false;

        // Detect tool usage
        for cap in CLAUDE_TOOL_RE.captures_iter(&clean) {
            let tool_name = cap[1].to_string();
            if !self.active_tools.contains(&tool_name) {
                self.active_tools.push(tool_name);
            }
            changed = true;
        }

        // Detect model
        if let Some(cap) = CLAUDE_MODEL_RE.captures(&clean) {
            let variant = cap[2].to_lowercase();
            let version = cap.get(3).map_or("".to_string(), |m| m.as_str().to_string());
            let model = if version.is_empty() {
                variant
            } else {
                format!("{variant}-{version}")
            };
            self.last_model = Some(model);
            changed = true;
        }

        // Detect cost
        if let Some(cap) = CLAUDE_COST_RE.captures(&clean) {
            if let Ok(cost) = cap[1].parse::<f64>() {
                if cost >= self.cumulative_cost && cost < 10000.0 {
                    self.cumulative_cost = cost;
                    changed = true;
                }
            }
        }

        // Detect tokens: "5.2k in, 1.1k out"
        if let Some(cap) = CLAUDE_TOKENS_RE.captures(&clean) {
            let raw_in = cap.get(0).map_or("", |m| m.as_str());
            let in_val = parse_k_number(&cap[1], raw_in);
            let out_val = parse_k_number(&cap[2], raw_in);
            if in_val > 0 || out_val > 0 {
                self.tokens_in = Some(in_val);
                self.tokens_out = Some(out_val);
                changed = true;
            }
        }

        // Detect context usage
        if let Some(cap) = CLAUDE_CONTEXT_PERCENT_RE.captures(&clean) {
            let pct_str = cap.get(1).or(cap.get(2)).map_or("0", |m| m.as_str());
            if let Ok(pct) = pct_str.parse::<u64>() {
                self.context_used = Some(pct);
                self.context_total = Some(100);
                changed = true;
            }
        } else if let Some(cap) = CLAUDE_CONTEXT_FRACTION_RE.captures(&clean) {
            let raw = cap.get(0).map_or("", |m| m.as_str());
            let used = parse_k_number(&cap[1], raw);
            let total = parse_k_number(&cap[2], raw);
            if total > 0 {
                self.context_used = Some(used);
                self.context_total = Some(total);
                changed = true;
            }
        }

        if changed {
            update.active_tools.clone_from(&self.active_tools);
            update.model.clone_from(&self.last_model);
            update.cost = Some(self.cumulative_cost);
            update.tokens_in = self.tokens_in;
            update.tokens_out = self.tokens_out;
            update.context_used = self.context_used;
            update.context_total = self.context_total;
            Some(update)
        } else {
            None
        }
    }
}

// ─── Codex CLI Parser ──────────────────────────────────────

static CODEX_TOOL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(reading|writing|patching|running)\s+").unwrap());

static CODEX_COST_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\$\s?(\d+\.?\d*)").unwrap());

pub struct CodexMetricParser {
    active_tools: Vec<String>,
    cumulative_cost: f64,
}

impl CodexMetricParser {
    pub fn new() -> Self {
        Self {
            active_tools: Vec::new(),
            cumulative_cost: 0.0,
        }
    }
}

impl MetricParser for CodexMetricParser {
    fn provider_id(&self) -> &str {
        "codex-cli"
    }

    fn parse_chunk(&mut self, data: &str) -> Option<MetricUpdate> {
        let clean = strip_ansi(data);
        let mut update = MetricUpdate::empty();
        let mut changed = false;

        for cap in CODEX_TOOL_RE.captures_iter(&clean) {
            let tool = cap[1].to_string();
            if !self.active_tools.contains(&tool) {
                self.active_tools.push(tool);
            }
            changed = true;
        }

        if let Some(cap) = CODEX_COST_RE.captures(&clean) {
            if let Ok(cost) = cap[1].parse::<f64>() {
                if cost >= self.cumulative_cost && cost < 10000.0 {
                    self.cumulative_cost = cost;
                    changed = true;
                }
            }
        }

        if changed {
            update.active_tools.clone_from(&self.active_tools);
            update.cost = Some(self.cumulative_cost);
            Some(update)
        } else {
            None
        }
    }
}

// ─── Gemini CLI Parser ─────────────────────────────────────

static GEMINI_TOOL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(reading|writing|running|searching)\s+").unwrap());

pub struct GeminiMetricParser {
    active_tools: Vec<String>,
}

impl GeminiMetricParser {
    pub fn new() -> Self {
        Self {
            active_tools: Vec::new(),
        }
    }
}

impl MetricParser for GeminiMetricParser {
    fn provider_id(&self) -> &str {
        "gemini-cli"
    }

    fn parse_chunk(&mut self, data: &str) -> Option<MetricUpdate> {
        let clean = strip_ansi(data);
        let mut update = MetricUpdate::empty();
        let mut changed = false;

        for cap in GEMINI_TOOL_RE.captures_iter(&clean) {
            let tool = cap[1].to_string();
            if !self.active_tools.contains(&tool) {
                self.active_tools.push(tool);
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

pub fn create_parser(provider: &str) -> Box<dyn MetricParser> {
    match provider {
        "claude-code" => Box::new(ClaudeMetricParser::new()),
        "codex-cli" => Box::new(CodexMetricParser::new()),
        "gemini-cli" => Box::new(GeminiMetricParser::new()),
        _ => Box::new(GeminiMetricParser::new()),
    }
}
