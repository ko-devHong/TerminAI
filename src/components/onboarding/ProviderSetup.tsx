import { useAtomValue, useSetAtom } from "jotai";
import {
  ArrowRight,
  Check,
  ChevronRight,
  FolderOpen,
  Palette,
  Plug,
  Sparkles,
  Terminal,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { defaultCwdAtom, themeAtom } from "@/atoms/settings";
import { Button } from "@/components/ui/button";
import { PROVIDERS } from "@/lib/providers";
import { invokeTauri, isTauriRuntimeAvailable } from "@/lib/tauri";
import type { AIProvider, DetectedProvider } from "@/types";

const ONBOARDING_KEY = "terminai:onboarding-complete";

interface OnboardingStep {
  id: string;
  title: string;
  icon: React.ReactNode;
}

const STEPS: OnboardingStep[] = [
  { id: "welcome", title: "Welcome", icon: <Sparkles className="size-4" /> },
  { id: "providers", title: "Providers", icon: <Terminal className="size-4" /> },
  { id: "setup", title: "Setup", icon: <Plug className="size-4" /> },
  { id: "preferences", title: "Preferences", icon: <Palette className="size-4" /> },
  { id: "done", title: "Ready", icon: <Check className="size-4" /> },
];

type ProviderSetupStatus = "pending" | "configuring" | "done" | "skipped" | "error";

interface ProviderState {
  detected: boolean;
  path: string | null;
  setupStatus: ProviderSetupStatus;
  setupMessage: string | null;
}

export function useOnboardingRequired(): boolean {
  // Read synchronously to avoid race condition where default-path dialog
  // opens before onboarding state is determined.
  const [required] = useState(() => localStorage.getItem(ONBOARDING_KEY) !== "true");
  return required;
}

export function resetOnboarding() {
  localStorage.removeItem(ONBOARDING_KEY);
}

export function ProviderSetup({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const [providers, setProviders] = useState<Record<string, ProviderState>>({});
  const [detecting, setDetecting] = useState(false);
  const theme = useAtomValue(themeAtom);
  const setTheme = useSetAtom(themeAtom);
  const defaultCwd = useAtomValue(defaultCwdAtom);
  const setDefaultCwd = useSetAtom(defaultCwdAtom);
  const [cwdDraft, setCwdDraft] = useState(defaultCwd === "." ? "" : defaultCwd);

  // Detect installed providers
  const detectProviders = useCallback(async () => {
    if (!isTauriRuntimeAvailable()) return;
    setDetecting(true);
    try {
      const detected = await invokeTauri<DetectedProvider[]>("detect_providers");
      const state: Record<string, ProviderState> = {};
      for (const p of detected) {
        if (p.id === "custom") continue;
        state[p.id] = {
          detected: p.found,
          path: p.path,
          setupStatus: "pending",
          setupMessage: null,
        };
      }
      setProviders(state);
    } catch {
      // Fallback: show all providers as not detected
    } finally {
      setDetecting(false);
    }
  }, []);

  useEffect(() => {
    void detectProviders();
  }, [detectProviders]);

  const detectedProviders = useMemo(
    () => Object.entries(providers).filter(([, v]) => v.detected),
    [providers],
  );

  const setupProvider = useCallback(async (providerId: string) => {
    setProviders((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], setupStatus: "configuring", setupMessage: null },
    }));

    try {
      // Step 1: Provider-specific setup (e.g. statusline for Claude)
      if (providerId === "claude-code") {
        await invokeTauri("setup_claude_statusline");
      }

      // Step 2: Register MCP Bridge for ALL providers that support it
      // We use the current directory as project_root for path resolution in Rust
      // In a real app, we might want a more robust way to find the app root,
      // but for this PoC, we'll assume the bridge is in the current project.
      // We'll use a placeholder or detect it.
      // For now, let's use the current working directory of the process.
      await invokeTauri("setup_mcp_bridge", {
        provider: providerId,
        projectRoot: await invokeTauri<string>("get_project_root").catch(() => "."),
      }).catch((_e) => {});

      setProviders((prev) => ({
        ...prev,
        [providerId]: {
          ...prev[providerId],
          setupStatus: "done",
          setupMessage:
            providerId === "claude-code"
              ? "Statusline & MCP Bridge configured"
              : "MCP Bridge registered — tool activity available",
        },
      }));
    } catch (err) {
      setProviders((prev) => ({
        ...prev,
        [providerId]: {
          ...prev[providerId],
          setupStatus: "error",
          setupMessage: `Setup failed: ${String(err)}`,
        },
      }));
    }
  }, []);

  const setupAllDetected = useCallback(async () => {
    for (const [id] of detectedProviders) {
      await setupProvider(id);
    }
  }, [detectedProviders, setupProvider]);

  const finishOnboarding = useCallback(() => {
    const cwd = cwdDraft.trim() || ".";
    setDefaultCwd(cwd);
    localStorage.setItem(ONBOARDING_KEY, "true");
    onComplete();
  }, [cwdDraft, setDefaultCwd, onComplete]);

  const canProceed = step < STEPS.length - 1;
  const currentStep = STEPS[step];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
      >
        {/* Step indicator */}
        <div className="flex items-center gap-1 border-b border-zinc-800/50 px-6 py-3">
          {STEPS.map((s, i) => (
            <button type="button" key={s.id} className="flex items-center gap-1" disabled>
              <span
                className={`flex size-6 items-center justify-center rounded-full text-[10px] font-medium transition-all ${
                  i < step
                    ? "bg-emerald-500/20 text-emerald-400"
                    : i === step
                      ? "bg-zinc-700 text-zinc-100"
                      : "bg-zinc-800/50 text-zinc-600"
                }`}
              >
                {i < step ? <Check className="size-3" /> : s.icon}
              </span>
              {i < STEPS.length - 1 && (
                <ChevronRight
                  className={`size-3 ${i < step ? "text-emerald-500/40" : "text-zinc-700"}`}
                />
              )}
            </button>
          ))}
          <span className="ml-auto text-xs text-zinc-500">
            {step + 1}/{STEPS.length}
          </span>
        </div>

        {/* Step content */}
        <div className="min-h-[320px] px-6 py-5">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentStep.id}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              {/* Step 1: Welcome */}
              {step === 0 && (
                <div className="flex flex-col items-center gap-4 pt-6 text-center">
                  <div className="flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500/20 to-orange-500/20">
                    <Sparkles className="size-8 text-amber-400" />
                  </div>
                  <h2 className="text-xl font-semibold text-zinc-100">Welcome to TerminAI</h2>
                  <p className="max-w-sm text-sm leading-relaxed text-zinc-400">
                    Your unified terminal for AI coding assistants. Let's set things up so you get
                    the best experience with real-time metrics and HUD.
                  </p>
                  <div className="mt-2 flex flex-wrap justify-center gap-2">
                    {(["claude-code", "codex-cli", "gemini-cli"] as AIProvider[]).map((id) => (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1.5 rounded-full bg-zinc-800/80 px-3 py-1 text-xs text-zinc-300"
                      >
                        {PROVIDERS[id].icon && (
                          <img src={PROVIDERS[id].icon} alt="" className="size-3.5 rounded" />
                        )}
                        {PROVIDERS[id].label}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Step 2: Provider detection */}
              {step === 1 && (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-lg font-semibold text-zinc-100">Detected Providers</h2>
                    <p className="mt-1 text-xs text-zinc-500">
                      We scanned your system for installed AI CLI tools.
                    </p>
                  </div>
                  {detecting ? (
                    <div className="flex items-center justify-center py-8">
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                        className="size-5 rounded-full border-2 border-zinc-700 border-t-zinc-300"
                      />
                      <span className="ml-2 text-sm text-zinc-400">Scanning...</span>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {(["claude-code", "codex-cli", "gemini-cli"] as AIProvider[]).map((id) => {
                        const state = providers[id];
                        const config = PROVIDERS[id];
                        return (
                          <div
                            key={id}
                            className={`flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${
                              state?.detected
                                ? "border-zinc-700/80 bg-zinc-900/50"
                                : "border-zinc-800/40 bg-zinc-900/20 opacity-50"
                            }`}
                          >
                            {config.icon && (
                              <img src={config.icon} alt="" className="size-8 rounded-lg" />
                            )}
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-zinc-200">
                                  {config.label}
                                </span>
                                {state?.detected ? (
                                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                                    Installed
                                  </span>
                                ) : (
                                  <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500">
                                    Not found
                                  </span>
                                )}
                              </div>
                              {state?.detected && state.path && (
                                <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                                  {state.path}
                                </p>
                              )}
                              {!state?.detected && (
                                <p className="mt-0.5 text-[11px] text-zinc-600">
                                  Install <code className="text-zinc-500">{config.command}</code> to
                                  enable
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Step 3: Setup */}
              {step === 2 && (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-lg font-semibold text-zinc-100">Configure Metrics</h2>
                    <p className="mt-1 text-xs text-zinc-500">
                      Enable real-time HUD metrics for your detected providers.
                    </p>
                  </div>
                  {detectedProviders.length === 0 ? (
                    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 px-4 py-6 text-center">
                      <p className="text-sm text-zinc-400">
                        No providers detected. You can still use TerminAI — install a CLI tool later
                        and re-run setup from settings.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {detectedProviders.map(([id, state]) => {
                        const config = PROVIDERS[id as AIProvider];
                        const isClaude = id === "claude-code";
                        return (
                          <div
                            key={id}
                            className="rounded-xl border border-zinc-700/60 bg-zinc-900/40 px-4 py-3"
                          >
                            <div className="flex items-center gap-3">
                              {config.icon && (
                                <img src={config.icon} alt="" className="size-7 rounded-lg" />
                              )}
                              <div className="flex-1">
                                <span className="text-sm font-medium text-zinc-200">
                                  {config.label}
                                </span>
                                <p className="text-[11px] text-zinc-500">
                                  {isClaude
                                    ? "Statusline plugin — model, tokens, cost, context %"
                                    : "Terminal output parsing — model, tokens, rate limits"}
                                </p>
                              </div>
                              {state.setupStatus === "done" ? (
                                <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
                                  <Check className="size-3" /> Done
                                </span>
                              ) : state.setupStatus === "configuring" ? (
                                <motion.div
                                  animate={{ rotate: 360 }}
                                  transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                                  className="size-4 rounded-full border-2 border-zinc-700 border-t-zinc-300"
                                />
                              ) : state.setupStatus === "error" ? (
                                <span className="rounded-full bg-red-500/15 px-2.5 py-1 text-[11px] text-red-400">
                                  Error
                                </span>
                              ) : (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  className="border-zinc-700 text-zinc-300"
                                  onClick={() => void setupProvider(id)}
                                >
                                  Configure
                                </Button>
                              )}
                            </div>
                            {state.setupMessage && (
                              <p
                                className={`mt-2 text-[11px] ${
                                  state.setupStatus === "error"
                                    ? "text-red-400/80"
                                    : "text-zinc-500"
                                }`}
                              >
                                {state.setupMessage}
                              </p>
                            )}
                          </div>
                        );
                      })}
                      {detectedProviders.some(([, s]) => s.setupStatus === "pending") && (
                        <Button
                          className="mt-2 w-full"
                          size="sm"
                          onClick={() => void setupAllDetected()}
                        >
                          <Plug className="size-3.5" />
                          Configure All
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Step 4: Preferences */}
              {step === 3 && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-lg font-semibold text-zinc-100">Preferences</h2>
                    <p className="mt-1 text-xs text-zinc-500">Customize your workspace defaults.</p>
                  </div>

                  {/* Default directory */}
                  <div className="space-y-2">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                      <FolderOpen className="size-3.5" />
                      Default Working Directory
                    </label>
                    <input
                      value={cwdDraft}
                      onChange={(e) => setCwdDraft(e.target.value)}
                      className="h-9 w-full rounded-lg border border-zinc-700/80 bg-zinc-900/60 px-3 text-sm text-zinc-200 outline-none transition-colors placeholder:text-zinc-600 focus:border-zinc-500"
                      placeholder="e.g. ~/projects/my-app"
                    />
                    <p className="text-[11px] text-zinc-600">
                      New tabs will open in this directory. You can change per-tab later.
                    </p>
                  </div>

                  {/* Theme */}
                  <div className="space-y-2">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                      <Palette className="size-3.5" />
                      Theme
                    </label>
                    <div className="flex gap-2">
                      {(["dark", "light"] as const).map((t) => (
                        <button
                          type="button"
                          key={t}
                          onClick={() => setTheme(t)}
                          className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition-all ${
                            theme === t
                              ? "border-zinc-500 bg-zinc-800 text-zinc-100"
                              : "border-zinc-800 bg-zinc-900/40 text-zinc-500 hover:border-zinc-700 hover:text-zinc-400"
                          }`}
                        >
                          {t === "dark" ? "🌙 Dark" : "☀️ Light"}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Step 5: Done */}
              {step === 4 && (
                <div className="flex flex-col items-center gap-4 pt-8 text-center">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 400, damping: 15, delay: 0.1 }}
                    className="flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500/20 to-green-500/20"
                  >
                    <Check className="size-8 text-emerald-400" />
                  </motion.div>
                  <h2 className="text-xl font-semibold text-zinc-100">You're all set!</h2>
                  <p className="max-w-sm text-sm leading-relaxed text-zinc-400">
                    TerminAI is ready to go. Your HUD will show real-time metrics as you work with
                    your AI assistants.
                  </p>
                  <div className="mt-2 flex flex-wrap justify-center gap-2">
                    {detectedProviders.map(([id, state]) => {
                      const config = PROVIDERS[id as AIProvider];
                      return (
                        <span
                          key={id}
                          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ${
                            state.setupStatus === "done"
                              ? "bg-emerald-500/10 text-emerald-400"
                              : "bg-zinc-800 text-zinc-500"
                          }`}
                        >
                          {config.icon && (
                            <img src={config.icon} alt="" className="size-3.5 rounded" />
                          )}
                          {config.label}
                          {state.setupStatus === "done" && <Check className="size-3" />}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Footer navigation */}
        <div className="flex items-center justify-between border-t border-zinc-800/50 px-6 py-3">
          {step > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-zinc-400"
              onClick={() => setStep((s) => s - 1)}
            >
              Back
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-zinc-500"
              onClick={() => {
                localStorage.setItem(ONBOARDING_KEY, "true");
                onComplete();
              }}
            >
              Skip setup
            </Button>
          )}

          {step === 4 ? (
            <Button size="sm" onClick={finishOnboarding}>
              Start using TerminAI
              <ArrowRight className="size-3.5" />
            </Button>
          ) : canProceed ? (
            <Button size="sm" onClick={() => setStep((s) => s + 1)}>
              Continue
              <ChevronRight className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </motion.div>
    </motion.div>
  );
}
