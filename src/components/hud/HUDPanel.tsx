import { useAtomValue, useSetAtom } from "jotai";
import { Clock3, Cpu, DollarSign } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { activeHudMetricsAtom, hudExpandModeAtom } from "@/atoms/hud";
import { focusedTabAtom } from "@/atoms/spaces";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { cn } from "@/lib/utils";
import type { ProcessStatus } from "@/types";

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

export function HUDPanel() {
  const mode = useAtomValue(hudExpandModeAtom);
  const setMode = useSetAtom(hudExpandModeAtom);
  const activeTab = useAtomValue(focusedTabAtom);
  const metrics = useAtomValue(activeHudMetricsAtom);
  const [liveStatus, setLiveStatus] = useState<ProcessStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const connectionStatusLabel = useMemo(() => {
    const status = liveStatus ?? activeTab?.processStatus;
    if (!status) return "idle";
    return status;
  }, [activeTab?.processStatus, liveStatus]);

  useEffect(() => {
    setLiveStatus(activeTab?.processStatus ?? null);
  }, [activeTab?.processStatus]);

  useTauriEvent<ProcessStatus>(
    activeTab?.sessionId ? `session-status-${activeTab.sessionId}` : null,
    (status) => setLiveStatus(status),
  );

  const elapsedSeconds = useMemo(() => {
    if (!activeTab) {
      return 0;
    }
    return Math.max(0, Math.floor((now - activeTab.createdAt) / 1000));
  }, [activeTab, now]);

  function cycleMode() {
    const nextMode = mode === "compact" ? "expanded" : mode === "expanded" ? "hidden" : "compact";
    setMode(nextMode);
  }

  if (mode === "hidden") {
    return (
      <button
        type="button"
        className="h-8 border-t border-zinc-800 bg-zinc-900 px-3 text-left text-xs text-zinc-400 hover:bg-zinc-800"
        onClick={cycleMode}
      >
        Show HUD
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={cycleMode}
      className={cn(
        "w-full border-t border-zinc-800 bg-zinc-900 px-3 text-left transition-colors hover:bg-zinc-800",
        mode === "compact" ? "h-9" : "h-[84px] py-2",
      )}
    >
      <div className="flex h-full items-center gap-3 text-xs text-zinc-200">
        <span className="font-medium">{activeTab?.provider ?? "No active tab"}</span>
        <span className="text-zinc-500">|</span>
        <span>{metrics?.model ?? "-"}</span>
        <span className="text-zinc-500">|</span>
        <span>상태: {connectionStatusLabel}</span>
        <span className="text-zinc-500">|</span>
        <span className="inline-flex items-center gap-1">
          <DollarSign className="size-3" />
          {metrics?.cost?.toFixed(2) ?? "0.00"}
        </span>
        <span className="inline-flex items-center gap-1">
          <Clock3 className="size-3" />
          {formatDuration(elapsedSeconds)}
        </span>
      </div>

      {mode === "expanded" ? (
        <div className="mt-2 flex items-center gap-4 text-xs text-zinc-400">
          <span className="inline-flex items-center gap-1">
            <Cpu className="size-3" />
            Tools: {metrics?.activeTools.join(", ") ?? "-"}
          </span>
          <span>
            Tokens: {metrics?.tokens?.input ?? 0} in / {metrics?.tokens?.output ?? 0} out
          </span>
          <span>
            Rate: {metrics?.rateLimit?.remaining ?? 0}/{metrics?.rateLimit?.total ?? 0}
          </span>
          <span>Session: {activeTab?.sessionId ?? "-"}</span>
        </div>
      ) : null}
    </button>
  );
}
