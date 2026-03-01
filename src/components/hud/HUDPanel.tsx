import { useAtomValue, useSetAtom } from "jotai";
import { Clock3, Cpu, DollarSign } from "lucide-react";

import { activeHudMetricsAtom, hudExpandModeAtom } from "@/atoms/hud";
import { focusedTabAtom } from "@/atoms/spaces";
import { cn } from "@/lib/utils";

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
        <span>Context 78%</span>
        <span className="text-zinc-500">|</span>
        <span className="inline-flex items-center gap-1">
          <DollarSign className="size-3" />
          {metrics?.cost?.toFixed(2) ?? "0.00"}
        </span>
        <span className="inline-flex items-center gap-1">
          <Clock3 className="size-3" />
          {metrics ? formatDuration(metrics.sessionDuration) : "0m"}
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
        </div>
      ) : null}
    </button>
  );
}
