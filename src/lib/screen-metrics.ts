import type { Terminal } from "@xterm/xterm";

import type { AIProvider, ProcessStatus } from "@/types";

export interface ScreenMetricResult {
  model: string | null;
  cost: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  contextUsed: number | null;
  contextTotal: number | null;
  rateFiveHourLeft: number | null;
  rateSevenDayLeft: number | null;
  rateFiveHourResetSeconds: number | null;
  rateSevenDayResetSeconds: number | null;
  rateFiveHourResetLabel: string | null;
  rateSevenDayResetLabel: string | null;
  activeTools: string[];
  detectedStatus: ProcessStatus | null;
}

// ─── Shared patterns ──────────────────────────────────────

const COST_RE = /\$\s?(\d+\.?\d*)/;

// ─── Claude Code ──────────────────────────────────────────

const CLAUDE_MODEL_RE = /(?:claude[- ]?)?(opus|sonnet|haiku)[- ]?(\d[\d.]*)?/i;
const CLAUDE_TOKENS_UP_DOWN_RE = /([\d.]+)\s*([kKmM]?)\s*[↑⬆]\s*([\d.]+)\s*([kKmM]?)\s*[↓⬇]/;
const CLAUDE_TOKENS_IN_OUT_RE =
  /([\d.]+)\s*([kKmM]?)\s*(?:tokens?)?\s*(?:in|input|prompt)\b[,\s/|]*([\d.]+)\s*([kKmM]?)\s*(?:tokens?)?\s*(?:out|output|completion)\b/i;
const CLAUDE_CONTEXT_PCT_RE = /(\d+)%\s*(?:context|ctx)/i;
const CLAUDE_CONTEXT_FRAC_RE =
  /([\d.]+)\s*([kKmM]?)\s*(?:tokens?)?\s*\/\s*([\d.]+)\s*([kKmM]?)\s*(?:tokens?)?/i;
const CLAUDE_TOOL_RE =
  /[⏺●]\s+(Read|Edit|Grep|Write|Glob|Bash|Agent|WebFetch|WebSearch|NotebookEdit|TodoRead|TodoWrite|Skill|ToolSearch)\b/;

// ─── Codex CLI ────────────────────────────────────────────

const CODEX_MODEL_RE =
  /\b(gpt-5(?:\.\d+)?(?:-[\w.-]+)?|gpt-4o(?:-[\w.-]+)?|o[1-4](?:-[\w.-]+)?|codex(?:-[\w.-]+)?)\b/i;
const CODEX_FIVE_HOUR_LEFT_RE =
  /5h\s+limit:\s*\[[^\]]*\]\s*(\d+)%\s*left(?:\s*\(resets\s+([^)]+)\))?/i;
const CODEX_WEEKLY_LEFT_RE =
  /Weekly\s+limit:\s*\[[^\]]*\]\s*(\d+)%\s*left(?:\s*\(resets\s+([^)]+)\))?/i;

// ─── Gemini CLI ───────────────────────────────────────────

const GEMINI_MODEL_RE = /\b(gemini[- ][\d.]+-(?:pro|flash|ultra)(?:[- ]\w+)?)\b/i;
const GEMINI_GENERATING_RE = /Generating with\s+([\w.-]+)/i;

// ─── Status Detection ────────────────────────────────────

const STATUS_WAITING_RE =
  /(?:do you want to proceed|[(（]\s*y\s*\/\s*n\s*[)）]|approve this|allow tool|press enter to confirm|confirm\?)/i;
const STATUS_THINKING_RE = /(?:thinking|ctrl\+c to interrupt|reasoning)/i;
const STATUS_ERROR_RE = /(?:error:|failed:|exception:|panic:|rate limit exceeded)/i;
const STATUS_RUNNING_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]|⏺/;
const STATUS_IDLE_RE = /[❯$>]\s*$/m;

function parseScaledNumber(numStr: string, suffix = ""): number | null {
  const n = Number.parseFloat(numStr);
  if (Number.isNaN(n)) return null;
  const scale = suffix.toLowerCase() === "m" ? 1_000_000 : suffix.toLowerCase() === "k" ? 1000 : 1;
  return Math.round(n * scale);
}

function parseCodexResetLabelToSeconds(label: string): number | null {
  const match = /(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]{3})/i.exec(label.trim());
  if (!match) return null;

  const monthMap: Record<string, number> = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const month = monthMap[match[4].toLowerCase()];
  if (Number.isNaN(hour) || Number.isNaN(minute) || Number.isNaN(day) || month == null) {
    return null;
  }

  const now = new Date();
  const target = new Date(now.getFullYear(), month, day, hour, minute, 0, 0);
  if (target.getTime() < now.getTime()) {
    target.setFullYear(target.getFullYear() + 1);
  }

  return Math.max(0, Math.floor((target.getTime() - now.getTime()) / 1000));
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
    rateFiveHourLeft: null,
    rateSevenDayLeft: null,
    rateFiveHourResetSeconds: null,
    rateSevenDayResetSeconds: null,
    rateFiveHourResetLabel: null,
    rateSevenDayResetLabel: null,
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
    result.tokensIn = parseScaledNumber(tokUpDown[1], tokUpDown[2]);
    result.tokensOut = parseScaledNumber(tokUpDown[3], tokUpDown[4]);
  } else {
    const tokInOut = CLAUDE_TOKENS_IN_OUT_RE.exec(text);
    if (tokInOut) {
      result.tokensIn = parseScaledNumber(tokInOut[1], tokInOut[2]);
      result.tokensOut = parseScaledNumber(tokInOut[3], tokInOut[4]);
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
      result.contextUsed = parseScaledNumber(ctxFrac[1], ctxFrac[2]);
      result.contextTotal = parseScaledNumber(ctxFrac[3], ctxFrac[4]);
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
    rateFiveHourLeft: null,
    rateSevenDayLeft: null,
    rateFiveHourResetSeconds: null,
    rateSevenDayResetSeconds: null,
    rateFiveHourResetLabel: null,
    rateSevenDayResetLabel: null,
    activeTools: [],
    detectedStatus: null,
  };

  const text = lines.join("\n");

  const modelMatch = CODEX_MODEL_RE.exec(text);
  if (modelMatch) {
    result.model = modelMatch[1].toLowerCase();
  }

  const tokInOut = CLAUDE_TOKENS_IN_OUT_RE.exec(text);
  if (tokInOut) {
    result.tokensIn = parseScaledNumber(tokInOut[1], tokInOut[2]);
    result.tokensOut = parseScaledNumber(tokInOut[3], tokInOut[4]);
  }

  const ctxPct = CLAUDE_CONTEXT_PCT_RE.exec(text);
  if (ctxPct) {
    result.contextUsed = Number.parseInt(ctxPct[1], 10);
    result.contextTotal = 100;
  }

  const fiveLeft = CODEX_FIVE_HOUR_LEFT_RE.exec(text);
  if (fiveLeft) {
    const left = Number.parseInt(fiveLeft[1], 10);
    if (!Number.isNaN(left)) {
      result.rateFiveHourLeft = Math.max(0, Math.min(100, left));
    }
    if (fiveLeft[2]) {
      result.rateFiveHourResetLabel = fiveLeft[2].trim();
      result.rateFiveHourResetSeconds = parseCodexResetLabelToSeconds(fiveLeft[2]);
    }
  }

  const weeklyLeft = CODEX_WEEKLY_LEFT_RE.exec(text);
  if (weeklyLeft) {
    const left = Number.parseInt(weeklyLeft[1], 10);
    if (!Number.isNaN(left)) {
      result.rateSevenDayLeft = Math.max(0, Math.min(100, left));
    }
    if (weeklyLeft[2]) {
      result.rateSevenDayResetLabel = weeklyLeft[2].trim();
      result.rateSevenDayResetSeconds = parseCodexResetLabelToSeconds(weeklyLeft[2]);
    }
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
    rateFiveHourLeft: null,
    rateSevenDayLeft: null,
    rateFiveHourResetSeconds: null,
    rateSevenDayResetSeconds: null,
    rateFiveHourResetLabel: null,
    rateSevenDayResetLabel: null,
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

  const tokInOut = CLAUDE_TOKENS_IN_OUT_RE.exec(text);
  if (tokInOut) {
    result.tokensIn = parseScaledNumber(tokInOut[1], tokInOut[2]);
    result.tokensOut = parseScaledNumber(tokInOut[3], tokInOut[4]);
  }

  const ctxPct = CLAUDE_CONTEXT_PCT_RE.exec(text);
  if (ctxPct) {
    result.contextUsed = Number.parseInt(ctxPct[1], 10);
    result.contextTotal = 100;
  }

  const costMatch = COST_RE.exec(text);
  if (costMatch) {
    result.cost = Number.parseFloat(costMatch[1]);
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
        rateFiveHourLeft: null,
        rateSevenDayLeft: null,
        rateFiveHourResetSeconds: null,
        rateSevenDayResetSeconds: null,
        rateFiveHourResetLabel: null,
        rateSevenDayResetLabel: null,
        activeTools: [],
        detectedStatus: null,
      };
  }
}
