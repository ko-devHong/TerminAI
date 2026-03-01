import { useAtomValue, useStore } from "jotai";
import { useEffect } from "react";

import { allTabsAtom, tabAtom } from "@/atoms/spaces";

const STALE_THRESHOLD_MS = 180_000; // 3 minutes
const CHECK_INTERVAL_MS = 30_000; // check every 30s

export function useStaleDetection() {
  const allTabs = useAtomValue(allTabsAtom);
  const store = useStore();

  useEffect(() => {
    function checkStale() {
      const now = Date.now();

      for (const tab of allTabs) {
        if (!tab.sessionId) continue;

        const status = tab.processStatus;
        // Only mark as stale if currently running or thinking
        if (status !== "running" && status !== "thinking") continue;

        if (now - tab.lastActivityAt >= STALE_THRESHOLD_MS) {
          const current = store.get(tabAtom(tab.id));
          if (
            current &&
            (current.processStatus === "running" || current.processStatus === "thinking")
          ) {
            store.set(tabAtom(tab.id), {
              ...current,
              processStatus: "stale",
            });
          }
        }
      }
    }

    const interval = window.setInterval(checkStale, CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [allTabs, store]);
}
