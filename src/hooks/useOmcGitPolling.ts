import { useSetAtom } from "jotai";
import { useEffect } from "react";

import { gitBranchAtom, omcStateAtom } from "@/atoms/hud";
import { invokeTauri, isTauriRuntimeAvailable } from "@/lib/tauri";

const POLL_INTERVAL_MS = 10_000;

interface OmcStateResult {
  activeMode: string | null;
  phase: string | null;
  iteration: number | null;
}

export function useOmcGitPolling(sessionId: string | null, cwd: string | null) {
  const setOmcState = useSetAtom(omcStateAtom(sessionId ?? ""));
  const setGitBranch = useSetAtom(gitBranchAtom(sessionId ?? ""));

  useEffect(() => {
    if (!sessionId || !cwd || !isTauriRuntimeAvailable()) {
      return;
    }

    let timeoutId: number | undefined;
    let mounted = true;

    async function poll() {
      if (!mounted || !cwd) return;

      try {
        const [omcResult, branchResult] = await Promise.allSettled([
          invokeTauri<OmcStateResult | null>("fetch_omc_state", { cwd }),
          invokeTauri<string | null>("fetch_git_branch", { cwd }),
        ]);

        if (!mounted) return;

        if (omcResult.status === "fulfilled") {
          const s = omcResult.value;
          if (s) {
            setOmcState({
              activeMode: s.activeMode ?? undefined,
              phase: s.phase ?? undefined,
              iteration: s.iteration ?? undefined,
            });
          } else {
            setOmcState(null);
          }
        }

        if (branchResult.status === "fulfilled") {
          setGitBranch(branchResult.value ?? null);
        }
      } catch {
        // Degrade gracefully — no update on failure
      }

      if (mounted) {
        timeoutId = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    void poll();

    return () => {
      mounted = false;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [sessionId, cwd, setOmcState, setGitBranch]);
}
