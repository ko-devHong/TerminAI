export type AIProvider = "claude-code" | "codex-cli" | "gemini-cli" | "custom";

export type ProcessStatus = "idle" | "running" | "processing" | "error" | "disconnected";

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

export interface HUDMetrics {
  provider: AIProvider;
  model: string | null;
  contextWindow: { used: number; total: number } | null;
  tokens: { input: number; output: number } | null;
  cost: number | null;
  rateLimit: { remaining: number; total: number } | null;
  activeTools: string[];
  sessionDuration: number;
  connectionStatus: "connected" | "disconnected" | "error";
}
