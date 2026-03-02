export type AIProvider = "claude-code" | "codex-cli" | "gemini-cli" | "custom";

export type ProcessStatus =
  | "idle"
  | "running"
  | "thinking"
  | "waiting"
  | "error"
  | "disconnected"
  | "stale";

export interface ProviderConfig {
  id: AIProvider;
  label: string;
  command: string;
  color: string;
  icon: string;
  detectable: boolean;
}

export interface DetectedProvider {
  id: AIProvider;
  command: string;
  found: boolean;
  path: string | null;
}

export interface Tab {
  id: string;
  name: string;
  provider: AIProvider;
  cwd: string;
  spaceId: string;
  isFavorite: boolean;
  createdAt: number;
  lastActivityAt: number;
  isFocused: boolean;
  processStatus: ProcessStatus;
  sessionId: string | null;
}

export interface Space {
  id: string;
  name: string;
  color: string;
  tabIds: string[];
  isCollapsed: boolean;
}

export interface ProviderUsage {
  rateLimit: {
    fiveHourPercent: number;
    sevenDayPercent: number;
    fiveHourResetSeconds: number;
    sevenDayResetSeconds: number;
  } | null;
  billing: { usedDollars: number; limitDollars: number | null } | null;
  plan: string | null;
  hasCredentials: boolean;
}

export interface HUDMetrics {
  provider: AIProvider;
  model: string | null;
  contextWindow: { used: number; total: number } | null;
  tokens: { input: number; output: number } | null;
  cost: number | null;
  rateLimit: {
    fiveHourPercent: number;
    sevenDayPercent: number;
    fiveHourResetSeconds: number;
    sevenDayResetSeconds: number;
  } | null;
  billing: { usedDollars: number; limitDollars: number | null } | null;
  plan: string | null;
  hasCredentials: boolean;
  activeTools: string[];
  sessionDuration: number;
  detailedStatus: ProcessStatus;
  connectionStatus: "connected" | "disconnected" | "error";
  rateLimitCountdown: number | null;
  rateLimitDetectedAt: number | null;
  rateLimitFiveHourResetLabel: string | null;
  rateLimitSevenDayResetLabel: string | null;
}

export interface MetricUpdate {
  activeTools: string[];
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cost: number | null;
  contextUsed: number | null;
  contextTotal: number | null;
  status: string | null;
  rateLimitSeconds: number | null;
}

export interface CliQuotaSnapshot {
  provider: AIProvider;
  model: string | null;
  fiveHourLeftPercent: number | null;
  sevenDayLeftPercent: number | null;
  fiveHourResetLabel: string | null;
  sevenDayResetLabel: string | null;
  costUsd: number | null;
}
