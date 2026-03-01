import { useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, Circle, Loader2, X } from "lucide-react";

import { closeTabAtom, focusTabAtom, tabAtom } from "@/atoms/spaces";
import { invokeTauri } from "@/lib/tauri";
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
  const closeTab = useSetAtom(closeTabAtom);

  if (!tab) {
    return null;
  }
  const currentTab = tab;

  async function handleClose(): Promise<void> {
    if (currentTab.sessionId) {
      try {
        await invokeTauri<void>("kill_session", { sessionId: currentTab.sessionId });
      } catch {
        // Session may already be gone; local close still proceeds.
      }
    }

    closeTab(currentTab.id);
  }

  return (
    <div
      className={cn(
        "tab-item group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors",
        currentTab.isFocused
          ? "border-l-2 border-emerald-500 bg-zinc-800 text-zinc-50"
          : "text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-100",
      )}
    >
      <button
        type="button"
        onClick={() => focusTab(currentTab.id)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        title={`${currentTab.name} (${currentTab.provider})`}
      >
        <StatusIcon status={currentTab.processStatus} />
        <span className="truncate">{currentTab.name}</span>
      </button>

      <button
        type="button"
        aria-label={`Close tab ${currentTab.name}`}
        onClick={() => {
          void handleClose();
        }}
        className="rounded p-1 text-zinc-500 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-700 hover:text-zinc-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
