import { useAtomValue, useSetAtom } from "jotai";
import { Clock3, Cpu, DollarSign } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
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

  const contextPercent = useMemo(() => {
    if (!metrics?.contextWindow) return 0;
    return Math.round((metrics.contextWindow.used / metrics.contextWindow.total) * 100);
  }, [metrics?.contextWindow]);

  function cycleMode() {
    const nextMode = mode === "compact" ? "expanded" : mode === "expanded" ? "hidden" : "compact";
    setMode(nextMode);
  }

  if (mode === "hidden") {
    return (
      <motion.button
        type="button"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="h-6 border-t border-zinc-800 bg-zinc-900 px-3 text-left text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-400"
        onClick={cycleMode}
      >
        Show HUD
      </motion.button>
    );
  }

  return (
    <motion.button
      type="button"
      onClick={cycleMode}
      layout
      animate={{
        height: mode === "compact" ? 36 : 84,
      }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
      className={cn(
        "w-full overflow-hidden border-t border-zinc-800 bg-zinc-900 px-3 text-left transition-colors hover:bg-zinc-800/80",
      )}
    >
      <div className="flex h-9 items-center gap-3 text-xs text-zinc-200">
        <span className="font-medium">{activeTab?.provider ?? "No active tab"}</span>

        <span className="text-zinc-600">|</span>
        <span className="text-zinc-400">{metrics?.model ?? "-"}</span>

        {metrics?.contextWindow ? (
          <>
            <span className="text-zinc-600">|</span>
            <span className="inline-flex items-center gap-1.5">
              Context
              <span className="inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-zinc-700">
                <span
                  className="metric-bar-fill h-full rounded-full"
                  style={{
                    width: `${contextPercent}%`,
                    backgroundColor:
                      contextPercent > 80 ? "#EF4444" : contextPercent > 60 ? "#F59E0B" : "#10B981",
                  }}
                />
              </span>
              <span className="text-zinc-400">{contextPercent}%</span>
            </span>
          </>
        ) : null}

        <span className="text-zinc-600">|</span>
        <StatusDot status={connectionStatusLabel} />
        <span className="text-zinc-400">{connectionStatusLabel}</span>

        <span className="ml-auto inline-flex items-center gap-3 text-zinc-400">
          <span className="inline-flex items-center gap-1">
            <DollarSign className="size-3" />
            {metrics?.cost?.toFixed(2) ?? "0.00"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock3 className="size-3" />
            {formatDuration(elapsedSeconds)}
          </span>
        </span>
      </div>

      <AnimatePresence>
        {mode === "expanded" ? (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="flex items-center gap-4 pb-2 text-xs text-zinc-400"
          >
            <span className="inline-flex items-center gap-1">
              <Cpu className="size-3" />
              Tools: {metrics?.activeTools?.join(", ") || "-"}
            </span>
            <span>
              Tokens: {metrics?.tokens?.input?.toLocaleString() ?? 0} in /{" "}
              {metrics?.tokens?.output?.toLocaleString() ?? 0} out
            </span>
            <span>
              Rate: {metrics?.rateLimit?.remaining ?? 0}/{metrics?.rateLimit?.total ?? 0}
            </span>
            <span className="ml-auto text-zinc-500">
              Session: {activeTab?.sessionId?.slice(0, 8) ?? "-"}
            </span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.button>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "running"
      ? "bg-emerald-500"
      : status === "processing"
        ? "bg-amber-500"
        : status === "error" || status === "disconnected"
          ? "bg-red-500"
          : "bg-zinc-500";

  return (
    <span
      className={cn(
        "inline-block size-1.5 rounded-full",
        color,
        status === "running" && "status-running",
      )}
    />
  );
}
