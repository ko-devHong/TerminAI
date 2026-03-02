import { useAtomValue, useSetAtom } from "jotai";
import { AlertTriangle, Clock3, DollarSign, KeyRound } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";

import { activeHudMetricsAtom, hudExpandModeAtom } from "@/atoms/hud";
import { focusedTabAtom } from "@/atoms/spaces";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useUsagePolling } from "@/hooks/useUsagePolling";
import { PROVIDERS } from "@/lib/providers";
import { cn } from "@/lib/utils";
import type { ProcessStatus } from "@/types";

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatTokens(n: number | null | undefined): string {
  if (n == null) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatResetTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function progressColor(percent: number): string {
  if (percent > 80) return "#EF4444";
  if (percent > 60) return "#F59E0B";
  return "#10B981";
}

export function HUDPanel() {
  const mode = useAtomValue(hudExpandModeAtom);
  const setMode = useSetAtom(hudExpandModeAtom);
  const activeTab = useAtomValue(focusedTabAtom);
  const metrics = useAtomValue(activeHudMetricsAtom);
  const [liveStatus, setLiveStatus] = useState<ProcessStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Start usage polling for the active provider
  useUsagePolling(activeTab?.provider ?? null);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const currentStatus = useMemo((): ProcessStatus => {
    return metrics?.detailedStatus ?? liveStatus ?? activeTab?.processStatus ?? "idle";
  }, [metrics?.detailedStatus, liveStatus, activeTab?.processStatus]);

  useEffect(() => {
    setLiveStatus(activeTab?.processStatus ?? null);
  }, [activeTab?.processStatus]);

  useTauriEvent<ProcessStatus>(
    activeTab?.sessionId ? `session-status-${activeTab.sessionId}` : null,
    (status) => setLiveStatus(status),
  );

  const elapsedSeconds = useMemo(() => {
    if (!activeTab) return 0;
    return Math.max(0, Math.floor((now - activeTab.createdAt) / 1000));
  }, [activeTab, now]);

  const contextPercent = useMemo(() => {
    if (!metrics?.contextWindow || metrics.contextWindow.total <= 0) return 0;
    return Math.round((metrics.contextWindow.used / metrics.contextWindow.total) * 100);
  }, [metrics?.contextWindow]);
  const isCodex = activeTab?.provider === "codex-cli";

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
      animate={{ height: mode === "compact" ? 36 : 148 }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
      className={cn(
        "w-full overflow-hidden border-t border-zinc-800 bg-zinc-900 px-3 text-left transition-colors hover:bg-zinc-800/80",
      )}
    >
      {/* ── Compact row ── */}
      <div className="flex h-9 items-center gap-2.5 text-xs text-zinc-200">
        {activeTab?.provider && PROVIDERS[activeTab.provider]?.icon ? (
          <img
            src={PROVIDERS[activeTab.provider].icon}
            alt={activeTab.provider}
            className="size-4 rounded object-contain"
          />
        ) : (
          <span className="font-medium">{activeTab?.provider ?? "No active tab"}</span>
        )}

        <span className="text-zinc-400">
          {metrics?.model ?? "-"}
          {metrics?.plan ? <span className="ml-1 text-zinc-500">({metrics.plan})</span> : null}
        </span>

        <span className="text-zinc-600">|</span>

        {/* Context bar (compact) */}
        <span
          className="inline-flex items-center gap-1.5"
          title={
            metrics?.contextWindow
              ? `${metrics.contextWindow.used.toLocaleString()} / ${metrics.contextWindow.total.toLocaleString()} tokens (${contextPercent}%)`
              : undefined
          }
        >
          <span className="inline-flex h-1.5 w-14 overflow-hidden rounded-full bg-zinc-700">
            <motion.span
              className="h-full rounded-full"
              animate={{
                width: `${contextPercent}%`,
                backgroundColor: progressColor(contextPercent),
              }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
            />
          </span>
          <span className="text-zinc-400">{contextPercent}%</span>
        </span>
        <ContextWarning percent={contextPercent} />

        <span className="text-zinc-600">|</span>

        {/* Status */}
        <StatusDot status={currentStatus} />
        <span className="text-zinc-400">{currentStatus}</span>
        {isCodex && metrics?.rateLimit ? (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">
            5h {Math.round(100 - metrics.rateLimit.fiveHourPercent)}% left
          </span>
        ) : null}
        {isCodex && metrics?.rateLimit ? (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">
            7d {Math.round(100 - metrics.rateLimit.sevenDayPercent)}% left
          </span>
        ) : null}
        <RateLimitBadge
          countdown={metrics?.rateLimitCountdown ?? null}
          detectedAt={metrics?.rateLimitDetectedAt ?? null}
          now={now}
        />

        {/* Right side: cost + duration */}
        <span className="ml-auto inline-flex items-center gap-3 text-zinc-400">
          <span className="inline-flex items-center gap-1">
            <DollarSign className="size-3" />
            {metrics?.cost != null ? metrics.cost.toFixed(2) : "-"}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock3 className="size-3" />
            {formatDuration(elapsedSeconds)}
          </span>
        </span>
      </div>

      {/* ── Expanded section ── */}
      <AnimatePresence>
        {mode === "expanded" ? (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="space-y-1.5 pb-2"
          >
            {/* Context bar (expanded) */}
            {metrics?.contextWindow ? (
              <>
                <ProgressRow
                  label="Context"
                  percent={contextPercent}
                  tooltip={`${metrics.contextWindow.used.toLocaleString()} / ${metrics.contextWindow.total.toLocaleString()} tokens`}
                />
                <ContextWarning percent={contextPercent} />
              </>
            ) : null}

            {/* Rate limit bars */}
            {metrics?.rateLimit ? (
              <>
                <ProgressRow
                  label="5h Rate"
                  percent={
                    isCodex
                      ? 100 - metrics.rateLimit.fiveHourPercent
                      : metrics.rateLimit.fiveHourPercent
                  }
                  valueLabel={
                    isCodex
                      ? `${Math.round(100 - metrics.rateLimit.fiveHourPercent)}% left`
                      : `${Math.round(metrics.rateLimit.fiveHourPercent)}% used`
                  }
                  resetSeconds={metrics.rateLimit.fiveHourResetSeconds}
                  resetLabel={metrics.rateLimitFiveHourResetLabel ?? null}
                  tooltip={
                    isCodex
                      ? `${(100 - metrics.rateLimit.fiveHourPercent).toFixed(1)}% left`
                      : `${metrics.rateLimit.fiveHourPercent.toFixed(1)}% used`
                  }
                  glow
                />
                <ProgressRow
                  label="7d Rate"
                  percent={
                    isCodex
                      ? 100 - metrics.rateLimit.sevenDayPercent
                      : metrics.rateLimit.sevenDayPercent
                  }
                  valueLabel={
                    isCodex
                      ? `${Math.round(100 - metrics.rateLimit.sevenDayPercent)}% left`
                      : `${Math.round(metrics.rateLimit.sevenDayPercent)}% used`
                  }
                  resetSeconds={metrics.rateLimit.sevenDayResetSeconds}
                  resetLabel={metrics.rateLimitSevenDayResetLabel ?? null}
                  tooltip={
                    isCodex
                      ? `${(100 - metrics.rateLimit.sevenDayPercent).toFixed(1)}% left`
                      : `${metrics.rateLimit.sevenDayPercent.toFixed(1)}% used`
                  }
                  glow
                />
              </>
            ) : null}
            <RateLimitBadge
              countdown={metrics?.rateLimitCountdown ?? null}
              detectedAt={metrics?.rateLimitDetectedAt ?? null}
              now={now}
            />

            {/* API key needed indicator */}
            {metrics && !metrics.hasCredentials ? (
              <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                <KeyRound className="size-3" />
                <span>API key needed for rate limits</span>
              </div>
            ) : null}

            {/* Stale warning */}
            {currentStatus === "stale" ? (
              <div className="flex items-center gap-1.5 text-xs text-orange-400">
                <Clock3 className="size-3" />
                <span>No output for 3+ minutes</span>
              </div>
            ) : null}

            {/* Tokens + Tools */}
            <div className="flex items-center gap-4 text-xs text-zinc-400">
              <span>↑ {formatTokens(metrics?.tokens?.input)} in</span>
              <span>↓ {formatTokens(metrics?.tokens?.output)} out</span>
              <span className="truncate">Tools: {metrics?.activeTools?.join(", ") || "-"}</span>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.button>
  );
}

// ─── Sub-components ─────────────────────────────────────

function ProgressRow({
  label,
  percent,
  resetSeconds,
  resetLabel,
  valueLabel,
  tooltip,
  glow,
}: {
  label: string;
  percent: number;
  resetSeconds?: number;
  resetLabel?: string | null;
  valueLabel?: string;
  tooltip?: string;
  glow?: boolean;
}) {
  const clampedPercent = Math.min(Math.max(percent, 0), 100);
  const shownValue = valueLabel ?? `${Math.round(clampedPercent)}%`;

  return (
    <div className="rounded border border-zinc-800/80 bg-zinc-950/40 px-2 py-1.5" title={tooltip}>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="font-medium text-zinc-300">{label}</span>
        <span className="text-zinc-200">{shownValue}</span>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-700">
          <motion.span
            className="absolute inset-y-0 left-0 rounded-full"
            animate={{
              width: `${clampedPercent}%`,
              backgroundColor: progressColor(percent),
            }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
          />
          {glow && percent >= 80 ? (
            <span className="absolute inset-0 animate-pulse rounded-full bg-red-500/20" />
          ) : null}
        </span>
        {resetLabel ? (
          <span className="text-zinc-500">↻ {resetLabel}</span>
        ) : resetSeconds != null && resetSeconds > 0 ? (
          <span className="text-zinc-500">↻ {formatResetTime(resetSeconds)}</span>
        ) : null}
      </div>
    </div>
  );
}

function RateLimitBadge({
  countdown,
  detectedAt,
  now,
}: {
  countdown: number | null;
  detectedAt: number | null;
  now: number;
}) {
  if (countdown == null || detectedAt == null) return null;

  const elapsed = Math.floor((now - detectedAt) / 1000);
  const remaining = countdown - elapsed;

  if (remaining <= 0) return null;

  return (
    <span className="inline-flex animate-pulse items-center gap-0.5 rounded bg-red-500/20 px-1 py-0.5 text-[10px] font-medium text-red-400">
      <Clock3 className="size-2.5" />
      Rate limited {remaining}s
    </span>
  );
}

function ContextWarning({ percent }: { percent: number }) {
  if (percent < 85) return null;

  if (percent >= 95) {
    return (
      <span className="inline-flex animate-pulse items-center gap-0.5 rounded bg-red-500/20 px-1 py-0.5 text-[10px] font-medium text-red-400">
        <AlertTriangle className="size-2.5" />
        Critical
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-orange-500/20 px-1 py-0.5 text-[10px] font-medium text-orange-400">
      <AlertTriangle className="size-2.5" />
      Low ctx
    </span>
  );
}

function StatusDot({ status }: { status: ProcessStatus }) {
  const color =
    status === "running"
      ? "bg-emerald-500"
      : status === "thinking"
        ? "bg-amber-500"
        : status === "waiting"
          ? "bg-blue-500"
          : status === "stale"
            ? "bg-orange-500"
            : status === "error" || status === "disconnected"
              ? "bg-red-500"
              : "bg-zinc-500";

  const shouldPulse = status === "thinking" || status === "waiting" || status === "stale";

  return (
    <motion.span
      className={cn("inline-block size-1.5 rounded-full", color)}
      animate={
        shouldPulse ? { scale: [1, 1.4, 1], opacity: [1, 0.5, 1] } : { scale: 1, opacity: 1 }
      }
      transition={
        shouldPulse
          ? {
              duration: 1.5,
              repeat: Number.POSITIVE_INFINITY,
              ease: "easeInOut",
            }
          : { duration: 0.2 }
      }
    />
  );
}
