import type { Terminal } from "@xterm/xterm";

import type { AIProvider, ProcessStatus } from "@/types";

export interface ScreenMetricResult {
  model: string | null;
  cost: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  contextUsed: number | null;
  contextTotal: number | null;
  activeTools: string[];
  detectedStatus: ProcessStatus | null;
}

// ─── Shared patterns ──────────────────────────────────────

const COST_RE = /\$\s?(\d+\.?\d*)/;

// ─── Claude Code ──────────────────────────────────────────

const CLAUDE_MODEL_RE = /(?:claude[- ]?)?(opus|sonnet|haiku)[- ]?(\d[\d.]*)?/i;
const CLAUDE_TOKENS_UP_DOWN_RE = /([\d.]+)\s*[kK]?\s*[↑⬆]\s*([\d.]+)\s*[kK]?\s*[↓⬇]/;
const CLAUDE_TOKENS_IN_OUT_RE = /([\d.]+)\s*[kK]?\s*in\b[,\s/|]*([\d.]+)\s*[kK]?\s*out\b/i;
const CLAUDE_CONTEXT_PCT_RE = /(\d+)%\s*(?:context|ctx)/i;
const CLAUDE_CONTEXT_FRAC_RE = /([\d.]+)\s*[kK]?\s*\/\s*([\d.]+)\s*[kK]/;
const CLAUDE_TOOL_RE =
  /[⏺●]\s+(Read|Edit|Grep|Write|Glob|Bash|Agent|WebFetch|WebSearch|NotebookEdit|TodoRead|TodoWrite|Skill|ToolSearch)\b/;

// ─── Codex CLI ────────────────────────────────────────────

const CODEX_MODEL_RE = /\b(gpt-4o|o[1-4](?:-\w+)?|codex\b)/i;

// ─── Gemini CLI ───────────────────────────────────────────

const GEMINI_MODEL_RE = /\b(gemini[- ][\d.]+-(?:pro|flash|ultra)(?:[- ]\w+)?)\b/i;
const GEMINI_GENERATING_RE = /Generating with\s+([\w.-]+)/i;

// ─── Status Detection ────────────────────────────────────

const STATUS_WAITING_RE =
  /(?:do you want to proceed|[(（]\s*y\s*\/\s*n\s*[)）]|permission|approve|allow\s+(?:tool|this))/i;
const STATUS_THINKING_RE = /(?:thinking|ctrl\+c to interrupt|reasoning)/i;
const STATUS_ERROR_RE = /(?:error:|failed:|exception:|panic:|rate limit exceeded)/i;
const STATUS_RUNNING_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]|⏺/;
const STATUS_IDLE_RE = /[❯$>]\s*$/m;

function parseKNumber(numStr: string, context: string): number {
  const n = Number.parseFloat(numStr);
  if (context.includes("k") || context.includes("K")) {
    return Math.round(n * 1000);
  }
  return Math.round(n);
}

/**
 * Read the last N lines from an xterm.js terminal buffer.
 * This reads the RENDERED screen content, not the raw PTY output.
 */
function readTerminalLines(terminal: Terminal, lineCount: number): string[] {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  const totalRows = buffer.length;

  const startRow = Math.max(0, totalRows - lineCount);
  for (let i = startRow; i < totalRows; i++) {
    const line = buffer.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }

  return lines;
}

function detectStatus(lines: string[]): ProcessStatus | null {
  const recentLines = lines.slice(-5).join("\n");

  if (STATUS_WAITING_RE.test(recentLines)) return "waiting";
  if (STATUS_ERROR_RE.test(recentLines)) return "error";
  if (STATUS_THINKING_RE.test(recentLines)) return "thinking";
  if (STATUS_RUNNING_RE.test(recentLines)) return "running";
  if (STATUS_IDLE_RE.test(recentLines)) return "idle";

  return null;
}

function parseClaude(lines: string[]): ScreenMetricResult {
  const result: ScreenMetricResult = {
    model: null,
    cost: null,
    tokensIn: null,
    tokensOut: null,
    contextUsed: null,
    contextTotal: null,
    activeTools: [],
    detectedStatus: null,
  };

  const text = lines.join("\n");

  // Model
  const modelMatch = CLAUDE_MODEL_RE.exec(text);
  if (modelMatch) {
    const variant = modelMatch[1].toLowerCase();
    const version = modelMatch[2] ?? "";
    result.model = version ? `${variant}-${version}` : variant;
  }

  // Cost
  const costMatch = COST_RE.exec(text);
  if (costMatch) {
    result.cost = Number.parseFloat(costMatch[1]);
  }

  // Tokens (↑↓ style first, then in/out style)
  const tokUpDown = CLAUDE_TOKENS_UP_DOWN_RE.exec(text);
  if (tokUpDown) {
    const raw = tokUpDown[0];
    result.tokensIn = parseKNumber(tokUpDown[1], raw);
    result.tokensOut = parseKNumber(tokUpDown[2], raw);
  } else {
    const tokInOut = CLAUDE_TOKENS_IN_OUT_RE.exec(text);
    if (tokInOut) {
      const raw = tokInOut[0];
      result.tokensIn = parseKNumber(tokInOut[1], raw);
      result.tokensOut = parseKNumber(tokInOut[2], raw);
    }
  }

  // Context
  const ctxPct = CLAUDE_CONTEXT_PCT_RE.exec(text);
  if (ctxPct) {
    result.contextUsed = Number.parseInt(ctxPct[1], 10);
    result.contextTotal = 100;
  } else {
    const ctxFrac = CLAUDE_CONTEXT_FRAC_RE.exec(text);
    if (ctxFrac) {
      const raw = ctxFrac[0];
      result.contextUsed = parseKNumber(ctxFrac[1], raw);
      result.contextTotal = parseKNumber(ctxFrac[2], raw);
    }
  }

  // Tools
  const tools: string[] = [];
  for (const line of lines) {
    const toolMatch = CLAUDE_TOOL_RE.exec(line);
    if (toolMatch && !tools.includes(toolMatch[1])) {
      tools.push(toolMatch[1]);
    }
  }
  if (tools.length > 0) {
    result.activeTools = tools;
  }

  // Status
  result.detectedStatus = detectStatus(lines);

  return result;
}

function parseCodex(lines: string[]): ScreenMetricResult {
  const result: ScreenMetricResult = {
    model: null,
    cost: null,
    tokensIn: null,
    tokensOut: null,
    contextUsed: null,
    contextTotal: null,
    activeTools: [],
    detectedStatus: null,
  };

  const text = lines.join("\n");

  const modelMatch = CODEX_MODEL_RE.exec(text);
  if (modelMatch) {
    result.model = modelMatch[1].toLowerCase();
  }

  const costMatch = COST_RE.exec(text);
  if (costMatch) {
    result.cost = Number.parseFloat(costMatch[1]);
  }

  result.detectedStatus = detectStatus(lines);

  return result;
}

function parseGemini(lines: string[]): ScreenMetricResult {
  const result: ScreenMetricResult = {
    model: null,
    cost: null,
    tokensIn: null,
    tokensOut: null,
    contextUsed: null,
    contextTotal: null,
    activeTools: [],
    detectedStatus: null,
  };

  const text = lines.join("\n");

  // Try "Generating with ..." pattern first
  const genMatch = GEMINI_GENERATING_RE.exec(text);
  if (genMatch) {
    result.model = genMatch[1];
  } else {
    const modelMatch = GEMINI_MODEL_RE.exec(text);
    if (modelMatch) {
      result.model = modelMatch[1];
    }
  }

  result.detectedStatus = detectStatus(lines);

  return result;
}

/**
 * Extract metrics from the rendered xterm.js screen buffer.
 * Reads the last `lineCount` lines and parses provider-specific patterns.
 */
export function extractScreenMetrics(
  terminal: Terminal,
  provider: AIProvider,
  lineCount = 30,
): ScreenMetricResult {
  const lines = readTerminalLines(terminal, lineCount);

  switch (provider) {
    case "claude-code":
      return parseClaude(lines);
    case "codex-cli":
      return parseCodex(lines);
    case "gemini-cli":
      return parseGemini(lines);
    default:
      return {
        model: null,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        contextUsed: null,
        contextTotal: null,
        activeTools: [],
        detectedStatus: null,
      };
  }
}
