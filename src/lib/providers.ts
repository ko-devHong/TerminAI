import { type AIProvider, type ProviderConfig } from "@/types";

export const PROVIDERS: Record<AIProvider, ProviderConfig> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    command: "claude",
    color: "#D97706",
    detectable: true,
  },
  "codex-cli": {
    id: "codex-cli",
    label: "Codex CLI",
    command: "codex",
    color: "#10B981",
    detectable: true,
  },
  "gemini-cli": {
    id: "gemini-cli",
    label: "Gemini CLI",
    command: "gemini",
    color: "#3B82F6",
    detectable: true,
  },
  custom: {
    id: "custom",
    label: "Custom CLI",
    command: "",
    color: "#71717A",
    detectable: false,
  },
};
