import { useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, Circle, Loader2 } from "lucide-react";

import { focusTabAtom, tabAtom } from "@/atoms/spaces";
import { cn } from "@/lib/utils";

interface TabItemProps {
  tabId: string;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "running") {
    return <Circle className="status-running size-3 fill-emerald-500 text-emerald-500" />;
  }

  if (status === "processing") {
    return <Loader2 className="status-processing size-3 text-amber-500" />;
  }

  if (status === "error" || status === "disconnected") {
    return <AlertCircle className="size-3 text-red-500" />;
  }

  return <Circle className="size-3 text-zinc-500" />;
}

export function TabItem({ tabId }: TabItemProps) {
  const tab = useAtomValue(tabAtom(tabId));
  const focusTab = useSetAtom(focusTabAtom);

  if (!tab) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => focusTab(tab.id)}
      className={cn(
        "tab-item flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors",
        tab.isFocused
          ? "border-l-2 border-emerald-500 bg-zinc-800 text-zinc-50"
          : "text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-100",
      )}
      title={`${tab.name} (${tab.provider})`}
    >
      <StatusIcon status={tab.processStatus} />
      <span className="truncate">{tab.name}</span>
    </button>
  );
}
