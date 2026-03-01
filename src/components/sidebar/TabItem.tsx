import { useSortable } from "@dnd-kit/sortable";
import { useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, Copy, FolderCog, Loader2, Trash2, X } from "lucide-react";

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
import { PROVIDERS } from "@/lib/providers";
import { invokeTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface TabItemProps {
  tabId: string;
}

/** Presentational tab row used by both TabItem and DragOverlay. */
export function TabItemContent({
  name,
  provider,
  processStatus,
  isFocused,
}: {
  name: string;
  provider: string;
  processStatus: string;
  isFocused: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs",
        isFocused
          ? "border-l-2 border-emerald-500 bg-zinc-800 text-zinc-50"
          : "bg-zinc-800 text-zinc-300",
      )}
    >
      <span className="relative shrink-0">
        <img
          src={PROVIDERS[provider as keyof typeof PROVIDERS]?.icon}
          alt=""
          className="size-4 rounded object-contain"
        />
        <StatusOverlay status={processStatus} />
      </span>
      <span className="truncate">{name}</span>
    </div>
  );
}

function StatusOverlay({ status }: { status: string }) {
  if (status === "processing") {
    return (
      <span className="absolute -right-0.5 -bottom-0.5">
        <Loader2 className="size-2 animate-spin text-amber-500" />
      </span>
    );
  }

  if (status === "error" || status === "disconnected") {
    return (
      <span className="absolute -right-0.5 -bottom-0.5">
        <AlertCircle className="size-2 text-red-500" />
      </span>
    );
  }

  return null;
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
            isDragging ? "opacity-30 border border-dashed border-zinc-600 bg-transparent" : "",
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
            <span className="relative shrink-0">
              <img
                src={PROVIDERS[currentTab.provider]?.icon}
                alt=""
                className="size-4 rounded object-contain"
              />
              <StatusOverlay status={currentTab.processStatus} />
            </span>
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
