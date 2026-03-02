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
    pub status: Option<String>,
    pub rate_limit_seconds: Option<u64>,
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
            status: None,
            rate_limit_seconds: None,
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

// ─── Status Detection (shared across providers) ─────────

static STATUS_WAITING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(do you want to proceed|[\(（]\s*y\s*/\s*n\s*[\)）]|approve this|allow tool|press enter to confirm|confirm\?)").unwrap()
});

static STATUS_THINKING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(thinking|ctrl\+c to interrupt|reasoning)").unwrap()
});

static STATUS_ERROR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(error:|failed:|exception:|panic:|rate limit exceeded|APIError|unauthorized|forbidden)").unwrap()
});

static STATUS_RUNNING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]|⏺").unwrap()
});

static STATUS_IDLE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[❯$>]\s*$").unwrap());

fn detect_status(clean: &str) -> Option<String> {
    if STATUS_WAITING_RE.is_match(clean) {
        Some("waiting".to_string())
    } else if STATUS_ERROR_RE.is_match(clean) {
        Some("error".to_string())
    } else if STATUS_THINKING_RE.is_match(clean) {
        Some("thinking".to_string())
    } else if STATUS_RUNNING_RE.is_match(clean) {
        Some("running".to_string())
    } else if STATUS_IDLE_RE.is_match(clean) {
        Some("idle".to_string())
    } else {
        None
    }
}

// ─── Rate Limit Detection ────────────────────────────────────

static RATE_LIMIT_RETRY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)retry\s+after\s+(\d+)\s+seconds").unwrap());

static RATE_LIMIT_TRY_AGAIN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)try\s+again\s+in\s+(\d+)\s+(seconds?|minutes?)").unwrap());

static RATE_LIMIT_429_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(429|too many requests|rate.?limit exceeded)").unwrap());

fn detect_rate_limit_seconds(clean: &str) -> Option<u64> {
    if let Some(cap) = RATE_LIMIT_RETRY_RE.captures(clean) {
        return cap[1].parse().ok();
    }
    if let Some(cap) = RATE_LIMIT_TRY_AGAIN_RE.captures(clean) {
        let value: u64 = cap[1].parse().ok()?;
        let unit = &cap[2];
        return Some(if unit.starts_with('m') { value * 60 } else { value });
    }
    if RATE_LIMIT_429_RE.is_match(clean) {
        return Some(60); // default 60s if no specific time
    }
    None
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

static GENERIC_TOKENS_IN_OUT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(\d+\.?\d*)\s*([kKmM]?)\s*(?:tokens?)?\s*(?:in|input|prompt)\b[^\n]{0,24}?(\d+\.?\d*)\s*([kKmM]?)\s*(?:tokens?)?\s*(?:out|output|completion)\b").unwrap()
});

static GENERIC_TOKENS_UP_DOWN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(\d+\.?\d*)\s*([kKmM]?)\s*(?:tokens?)?\s*(?:↑|⬆)\s*(\d+\.?\d*)\s*([kKmM]?)\s*(?:tokens?)?\s*(?:↓|⬇)").unwrap()
});

static GENERIC_CONTEXT_PERCENT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(\d+)%\s*(?:context|ctx)|(?:context|ctx)\s*(\d+)%").unwrap()
});

static GENERIC_CONTEXT_FRACTION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(\d+\.?\d*)\s*([kKmM]?)\s*(?:tokens?)?\s*/\s*(\d+\.?\d*)\s*([kKmM]?)\s*(?:tokens?)?",
    )
    .unwrap()
});

static CODEX_MODEL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(gpt-5(?:\.\d+)?(?:-[\w.-]+)?|gpt-4o(?:-[\w.-]+)?|o[1-4](?:-[\w.-]+)?|codex(?:-[\w.-]+)?)\b").unwrap());

static GEMINI_MODEL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(gemini[- ]?\d[\w.-]*(?:pro|flash|ultra|lite)?(?:[- ][\w.-]+)?)\b").unwrap()
});

fn parse_scaled_number(s: &str, suffix: Option<&str>) -> u64 {
    let n: f64 = s.parse().unwrap_or(0.0);
    let scale = match suffix.unwrap_or("").to_ascii_lowercase().as_str() {
        "k" => 1_000.0,
        "m" => 1_000_000.0,
        _ => 1.0,
    };
    (n * scale) as u64
}

fn parse_cost(clean: &str, existing_cost: f64) -> Option<f64> {
    let cap = CLAUDE_COST_RE.captures(clean)?;
    let parsed = cap[1].parse::<f64>().ok()?;
    if parsed >= existing_cost && parsed < 10000.0 {
        return Some(parsed);
    }
    None
}

fn parse_tokens(clean: &str) -> Option<(u64, u64)> {
    if let Some(cap) = GENERIC_TOKENS_IN_OUT_RE.captures(clean) {
        return Some((
            parse_scaled_number(&cap[1], cap.get(2).map(|m| m.as_str())),
            parse_scaled_number(&cap[3], cap.get(4).map(|m| m.as_str())),
        ));
    }

    if let Some(cap) = GENERIC_TOKENS_UP_DOWN_RE.captures(clean) {
        return Some((
            parse_scaled_number(&cap[1], cap.get(2).map(|m| m.as_str())),
            parse_scaled_number(&cap[3], cap.get(4).map(|m| m.as_str())),
        ));
    }

    None
}

fn parse_context(clean: &str) -> Option<(u64, u64)> {
    if let Some(cap) = GENERIC_CONTEXT_PERCENT_RE.captures(clean) {
        let pct_str = cap.get(1).or(cap.get(2)).map(|m| m.as_str())?;
        let pct = pct_str.parse::<u64>().ok()?;
        return Some((pct, 100));
    }

    if let Some(cap) = GENERIC_CONTEXT_FRACTION_RE.captures(clean) {
        let used = parse_scaled_number(&cap[1], cap.get(2).map(|m| m.as_str()));
        let total = parse_scaled_number(&cap[3], cap.get(4).map(|m| m.as_str()));
        if total > 0 {
            return Some((used, total));
        }
    }

    None
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

        // Detect tokens: "5.2k in, 1.1k out" and similar variants
        if let Some((in_val, out_val)) = parse_tokens(&clean) {
            if in_val > 0 || out_val > 0 {
                self.tokens_in = Some(in_val);
                self.tokens_out = Some(out_val);
                changed = true;
            }
        }

        // Detect context usage
        if let Some((used, total)) = parse_context(&clean) {
            self.context_used = Some(used);
            self.context_total = Some(total);
            changed = true;
        }

        let detected_status = detect_status(&clean);
        if detected_status.is_some() {
            changed = true;
        }

        let rate_limit = detect_rate_limit_seconds(&clean);
        if rate_limit.is_some() {
            changed = true;
        }

        if changed {
            update.active_tools.clone_from(&self.active_tools);
            update.model.clone_from(&self.last_model);
            update.cost = Some(self.cumulative_cost);
            update.tokens_in = self.tokens_in;
            update.tokens_out = self.tokens_out;
            update.context_used = self.context_used;
            update.context_total = self.context_total;
            update.status = detected_status;
            update.rate_limit_seconds = rate_limit;
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
    last_model: Option<String>,
    cumulative_cost: f64,
    tokens_in: Option<u64>,
    tokens_out: Option<u64>,
    context_used: Option<u64>,
    context_total: Option<u64>,
}

impl CodexMetricParser {
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

        if let Some(cap) = CODEX_MODEL_RE.captures(&clean) {
            let parsed = cap[1].to_lowercase().replace(' ', "-");
            if self.last_model.as_ref() != Some(&parsed) {
                self.last_model = Some(parsed);
                changed = true;
            }
        }

        if let Some(cost) = parse_cost(&clean, self.cumulative_cost) {
            self.cumulative_cost = cost;
            changed = true;
        } else if let Some(cap) = CODEX_COST_RE.captures(&clean) {
            if let Ok(cost) = cap[1].parse::<f64>() {
                if cost >= self.cumulative_cost && cost < 10000.0 {
                    self.cumulative_cost = cost;
                    changed = true;
                }
            }
        }

        if let Some((input, output)) = parse_tokens(&clean) {
            if input > 0 || output > 0 {
                self.tokens_in = Some(input);
                self.tokens_out = Some(output);
                changed = true;
            }
        }

        if let Some((used, total)) = parse_context(&clean) {
            self.context_used = Some(used);
            self.context_total = Some(total);
            changed = true;
        }

        let detected_status = detect_status(&clean);
        if detected_status.is_some() {
            changed = true;
        }

        let rate_limit = detect_rate_limit_seconds(&clean);
        if rate_limit.is_some() {
            changed = true;
        }

        if changed {
            update.active_tools.clone_from(&self.active_tools);
            update.model.clone_from(&self.last_model);
            update.cost = Some(self.cumulative_cost);
            update.tokens_in = self.tokens_in;
            update.tokens_out = self.tokens_out;
            update.context_used = self.context_used;
            update.context_total = self.context_total;
            update.status = detected_status;
            update.rate_limit_seconds = rate_limit;
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
    last_model: Option<String>,
    cumulative_cost: f64,
    tokens_in: Option<u64>,
    tokens_out: Option<u64>,
    context_used: Option<u64>,
    context_total: Option<u64>,
}

impl GeminiMetricParser {
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

        if let Some(cap) = GEMINI_MODEL_RE.captures(&clean) {
            let parsed = cap[1].to_lowercase().replace(' ', "-");
            if self.last_model.as_ref() != Some(&parsed) {
                self.last_model = Some(parsed);
                changed = true;
            }
        }

        if let Some(cost) = parse_cost(&clean, self.cumulative_cost) {
            self.cumulative_cost = cost;
            changed = true;
        }

        if let Some((input, output)) = parse_tokens(&clean) {
            if input > 0 || output > 0 {
                self.tokens_in = Some(input);
                self.tokens_out = Some(output);
                changed = true;
            }
        }

        if let Some((used, total)) = parse_context(&clean) {
            self.context_used = Some(used);
            self.context_total = Some(total);
            changed = true;
        }

        let detected_status = detect_status(&clean);
        if detected_status.is_some() {
            changed = true;
        }

        let rate_limit = detect_rate_limit_seconds(&clean);
        if rate_limit.is_some() {
            changed = true;
        }

        if changed {
            update.active_tools.clone_from(&self.active_tools);
            update.model.clone_from(&self.last_model);
            update.cost = Some(self.cumulative_cost);
            update.tokens_in = self.tokens_in;
            update.tokens_out = self.tokens_out;
            update.context_used = self.context_used;
            update.context_total = self.context_total;
            update.status = detected_status;
            update.rate_limit_seconds = rate_limit;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_status_waiting() {
        assert_eq!(detect_status("Do you want to proceed? (y/n)"), Some("waiting".to_string()));
        assert_eq!(detect_status("Allow tool execution?"), Some("waiting".to_string()));
        assert_eq!(detect_status("approve this action"), Some("waiting".to_string()));
    }

    #[test]
    fn detect_status_thinking() {
        assert_eq!(detect_status("Thinking..."), Some("thinking".to_string()));
        assert_eq!(detect_status("ctrl+c to interrupt"), Some("thinking".to_string()));
    }

    #[test]
    fn detect_status_error() {
        assert_eq!(detect_status("error: file not found"), Some("error".to_string()));
        assert_eq!(detect_status("rate limit exceeded"), Some("error".to_string()));
    }

    #[test]
    fn detect_status_running() {
        assert_eq!(detect_status("⠋ Processing files"), Some("running".to_string()));
        assert_eq!(detect_status("⏺ Read src/main.rs"), Some("running".to_string()));
    }

    #[test]
    fn detect_status_idle() {
        assert_eq!(detect_status("❯ "), Some("idle".to_string()));
        assert_eq!(detect_status("$ "), Some("idle".to_string()));
    }

    #[test]
    fn detect_status_none() {
        assert_eq!(detect_status("some regular output text"), None);
    }

    #[test]
    fn claude_parser_emits_status() {
        let mut parser = ClaudeMetricParser::new();
        let update = parser.parse_chunk("Thinking about your question...");
        assert!(update.is_some());
        assert_eq!(update.unwrap().status, Some("thinking".to_string()));
    }

    #[test]
    fn claude_parser_detects_model_and_cost() {
        let mut parser = ClaudeMetricParser::new();
        let update = parser.parse_chunk("Using opus-4 model, cost so far $1.23");
        assert!(update.is_some());
        let u = update.unwrap();
        assert_eq!(u.model, Some("opus-4".to_string()));
        assert_eq!(u.cost, Some(1.23));
    }

    #[test]
    fn codex_parser_emits_status() {
        let mut parser = CodexMetricParser::new();
        let update = parser.parse_chunk("⠙ reading files...");
        assert!(update.is_some());
        let u = update.unwrap();
        assert_eq!(u.status, Some("running".to_string()));
    }

    #[test]
    fn codex_parser_detects_model_tokens_context() {
        let mut parser = CodexMetricParser::new();
        let update = parser.parse_chunk("model gpt-5, 12.5k in / 1.4k out, context 38%");
        assert!(update.is_some());
        let u = update.unwrap();
        assert_eq!(u.model, Some("gpt-5".to_string()));
        assert_eq!(u.tokens_in, Some(12_500));
        assert_eq!(u.tokens_out, Some(1_400));
        assert_eq!(u.context_used, Some(38));
        assert_eq!(u.context_total, Some(100));
    }

    #[test]
    fn gemini_parser_emits_status() {
        let mut parser = GeminiMetricParser::new();
        let update = parser.parse_chunk("error: something went wrong");
        assert!(update.is_some());
        assert_eq!(update.unwrap().status, Some("error".to_string()));
    }

    #[test]
    fn gemini_parser_detects_model_tokens_and_cost() {
        let mut parser = GeminiMetricParser::new();
        let update = parser.parse_chunk("Generating with gemini-2.5-pro | 900 input 120 output | $0.42");
        assert!(update.is_some());
        let u = update.unwrap();
        assert_eq!(u.model, Some("gemini-2.5-pro".to_string()));
        assert_eq!(u.tokens_in, Some(900));
        assert_eq!(u.tokens_out, Some(120));
        assert_eq!(u.cost, Some(0.42));
    }

    #[test]
    fn detect_rate_limit_retry_after() {
        assert_eq!(detect_rate_limit_seconds("Please retry after 30 seconds"), Some(30));
    }

    #[test]
    fn detect_rate_limit_try_again_minutes() {
        assert_eq!(detect_rate_limit_seconds("Try again in 2 minutes"), Some(120));
    }

    #[test]
    fn detect_rate_limit_429() {
        assert_eq!(detect_rate_limit_seconds("HTTP 429 Too Many Requests"), Some(60));
    }

    #[test]
    fn detect_rate_limit_none() {
        assert_eq!(detect_rate_limit_seconds("normal output text"), None);
    }

    #[test]
    fn claude_parser_detects_rate_limit() {
        let mut parser = ClaudeMetricParser::new();
        let update = parser.parse_chunk("Rate limit exceeded, retry after 45 seconds");
        assert!(update.is_some());
        let u = update.unwrap();
        assert_eq!(u.rate_limit_seconds, Some(45));
    }
}
