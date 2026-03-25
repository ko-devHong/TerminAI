import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

import { providerUsageAtom } from "@/atoms/hud";
import { invokeTauri, isTauriRuntimeAvailable } from "@/lib/tauri";
import type { AIProvider, ProviderUsage } from "@/types";

const POLL_INTERVAL_MS = 60_000;
const RETRY_INTERVAL_MS = 15_000;
const BACKOFF_INTERVAL_MS = 120_000;
const RATE_LIMIT_BACKOFF_MS = 300_000; // 5 min backoff on 429
const MAX_CONSECUTIVE_FAILURES = 3;

// Global dedup: only one poll per provider across all tabs/components
const activePollers = new Map<string, { subscribers: number; cleanup: (() => void) | null }>();

export function useUsagePolling(provider: AIProvider | null) {
  const setUsage = useSetAtom(providerUsageAtom(provider ?? "claude-code"));
  const failCountRef = useRef(0);

  useEffect(() => {
    // Reset fail counter when provider changes
    failCountRef.current = 0;

    if (!provider || !isTauriRuntimeAvailable()) {
      return;
    }

    // Dedup: if another component is already polling this provider, just subscribe
    const existing = activePollers.get(provider);
    if (existing) {
      existing.subscribers += 1;
      return () => {
        existing.subscribers -= 1;
        if (existing.subscribers <= 0) {
          existing.cleanup?.();
          activePollers.delete(provider);
        }
      };
    }

    let timeoutId: number | undefined;
    let mounted = true;

    const entry = { subscribers: 1, cleanup: null as (() => void) | null };
    activePollers.set(provider, entry);

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
      } catch (err) {
        const errStr = String(err);
        const isRateLimited = errStr.includes("rate_limited");
        if (isRateLimited) {
          scheduleNext(RATE_LIMIT_BACKOFF_MS);
        } else {
          failCountRef.current += 1;
          const delay =
            failCountRef.current >= MAX_CONSECUTIVE_FAILURES
              ? BACKOFF_INTERVAL_MS
              : RETRY_INTERVAL_MS;
          scheduleNext(delay);
        }
      }
    }

    function scheduleNext(ms: number) {
      if (mounted) {
        timeoutId = window.setTimeout(poll, ms);
      }
    }

    void poll();

    const cleanup = () => {
      mounted = false;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
    entry.cleanup = cleanup;

    return () => {
      entry.subscribers -= 1;
      if (entry.subscribers <= 0) {
        cleanup();
        activePollers.delete(provider);
      }
    };
  }, [provider, setUsage]);
}
