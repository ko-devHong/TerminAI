import type { AIProvider, ProviderConfig } from "@/types";

export const PROVIDERS: Record<AIProvider, ProviderConfig> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    command: "claude",
    color: "#D97706",
    icon: "/providers/claude-code.png",
    detectable: true,
  },
  "codex-cli": {
    id: "codex-cli",
    label: "Codex CLI",
    command: "codex",
    color: "#10B981",
    icon: "/providers/codex-cli.png",
    detectable: true,
  },
  "gemini-cli": {
    id: "gemini-cli",
    label: "Gemini CLI",
    command: "gemini",
    color: "#3B82F6",
    icon: "/providers/gemini-cli.png",
    detectable: true,
  },
  custom: {
    id: "custom",
    label: "Custom CLI",
    command: "",
    color: "#71717A",
    icon: "",
    detectable: false,
  },
};
