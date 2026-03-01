import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

import { providerUsageAtom } from "@/atoms/hud";
import { invokeTauri, isTauriRuntimeAvailable } from "@/lib/tauri";
import type { AIProvider, ProviderUsage } from "@/types";

const POLL_INTERVAL_MS = 60_000;
const RETRY_INTERVAL_MS = 15_000;
const BACKOFF_INTERVAL_MS = 120_000;
const MAX_CONSECUTIVE_FAILURES = 3;

export function useUsagePolling(provider: AIProvider | null) {
  const setUsage = useSetAtom(providerUsageAtom(provider ?? "claude-code"));
  const failCountRef = useRef(0);

  useEffect(() => {
    if (!provider || !isTauriRuntimeAvailable()) {
      return;
    }

    let timeoutId: number | undefined;
    let mounted = true;

    async function poll() {
      if (!mounted || !provider) return;

      try {
        const usage = await invokeTauri<ProviderUsage | null>("fetch_provider_usage", {
          provider,
        });
        if (mounted && usage) {
          setUsage(usage);
          failCountRef.current = 0;
        }
        scheduleNext(POLL_INTERVAL_MS);
      } catch {
        failCountRef.current += 1;
        const delay =
          failCountRef.current >= MAX_CONSECUTIVE_FAILURES
            ? BACKOFF_INTERVAL_MS
            : RETRY_INTERVAL_MS;
        scheduleNext(delay);
      }
    }

    function scheduleNext(ms: number) {
      if (mounted) {
        timeoutId = window.setTimeout(poll, ms);
      }
    }

    void poll();

    return () => {
      mounted = false;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [provider, setUsage]);
}
