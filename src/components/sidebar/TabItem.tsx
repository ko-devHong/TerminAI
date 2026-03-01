import { useSortable } from "@dnd-kit/sortable";
import { useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, Circle, Copy, FolderCog, Loader2, Trash2, X } from "lucide-react";

import {
  closeTabAtom,
  duplicateTabAtom,
  focusTabAtom,
  openCwdEditorAtom,
  tabAtom,
} from "@/atoms/spaces";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
  const duplicateTab = useSetAtom(duplicateTabAtom);
  const openCwdEditor = useSetAtom(openCwdEditorAtom);
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: `tab:${tabId}`,
  });

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
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          className={cn(
            "tab-item group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors",
            currentTab.isFocused
              ? "border-l-2 border-emerald-500 bg-zinc-800 text-zinc-50"
              : "text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-100",
            isDragging ? "opacity-60" : "",
          )}
        >
          <button
            type="button"
            {...attributes}
            {...listeners}
            onClick={() => focusTab(currentTab.id)}
            className="flex min-w-0 flex-1 cursor-grab items-center gap-2 text-left active:cursor-grabbing"
            title={`${currentTab.name} (${currentTab.provider})\n${currentTab.cwd}`}
          >
            <StatusIcon status={currentTab.processStatus} />
            <span className="truncate">{currentTab.name}</span>
          </button>

          <button
            type="button"
            aria-label={`Close tab ${currentTab.name}`}
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              void handleClose();
            }}
            className="shrink-0 rounded p-1 text-zinc-400 opacity-100 transition hover:bg-zinc-700 hover:text-zinc-100"
          >
            <X className="size-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44 border-zinc-700 bg-zinc-900 text-zinc-100">
        <ContextMenuItem onSelect={() => duplicateTab(currentTab.id)}>
          <Copy className="size-3.5" />
          Duplicate
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => openCwdEditor(currentTab.id)}>
          <FolderCog className="size-3.5" />
          Set Working Directory...
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onSelect={() => {
            void handleClose();
          }}
        >
          <Trash2 className="size-3.5" />
          Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
