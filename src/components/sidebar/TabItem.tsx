import { useSortable } from "@dnd-kit/sortable";
import { useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, Clock3, Copy, FolderCog, Loader2, Pencil, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  closeTabAtom,
  duplicateTabAtom,
  focusTabAtom,
  openCwdEditorAtom,
  renameTabAtom,
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
  if (status === "thinking") {
    return (
      <span className="absolute -right-0.5 -bottom-0.5">
        <Loader2 className="size-2 animate-spin text-amber-500" />
      </span>
    );
  }

  if (status === "stale") {
    return (
      <span className="absolute -right-0.5 -bottom-0.5">
        <Clock3 className="size-2 text-orange-500" />
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
  const renameTab = useSetAtom(renameTabAtom);
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: `tab:${tabId}`,
  });

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

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

  function startRenaming() {
    setRenameValue(currentTab.name);
    setIsRenaming(true);
  }

  function commitRename() {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== currentTab.name) {
      renameTab({ tabId: currentTab.id, name: trimmed });
    }
    setIsRenaming(false);
  }

  function cancelRename() {
    setIsRenaming(false);
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          className={cn(
            "tab-item group flex h-8 w-full items-center rounded-md pr-1 pl-2 text-left text-xs transition-colors",
            currentTab.isFocused
              ? "border-l-2 border-emerald-500 bg-zinc-800 text-zinc-50"
              : "text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-100",
            isDragging ? "opacity-30 border border-dashed border-zinc-600 bg-transparent" : "",
          )}
        >
          {/* Drag handle + name area: takes remaining space, allows truncation */}
          <button
            type="button"
            {...attributes}
            {...listeners}
            onClick={() => focusTab(currentTab.id)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRenaming();
            }}
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
            {isRenaming ? (
              <RenameInput
                ref={renameInputRef}
                value={renameValue}
                onChange={setRenameValue}
                onCommit={commitRename}
                onCancel={cancelRename}
              />
            ) : (
              <span className="truncate">{currentTab.name}</span>
            )}
          </button>

          {/* Close button: fixed size, always visible on hover */}
          {!isRenaming && (
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
              className="ml-1 shrink-0 rounded p-0.5 text-zinc-500 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-700 hover:text-zinc-100"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48 border-zinc-700 bg-zinc-900 text-zinc-100">
        <ContextMenuItem onSelect={() => startRenaming()}>
          <Pencil className="size-3.5" />
          Rename
        </ContextMenuItem>
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

/** Inline rename input shown when user double-clicks or selects Rename from context menu. */
const RenameInput = ({
  ref,
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  ref: React.Ref<HTMLInputElement>;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus and select all text when the input mounts
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  // Merge refs
  useEffect(() => {
    if (typeof ref === "function") {
      ref(inputRef.current);
    } else if (ref && "current" in ref) {
      (ref as React.MutableRefObject<HTMLInputElement | null>).current = inputRef.current;
    }
  }, [ref]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        onCommit();
      } else if (e.key === "Escape") {
        onCancel();
      }
    },
    [onCommit, onCancel],
  );

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={onCommit}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="min-w-0 flex-1 rounded border border-zinc-600 bg-zinc-900 px-1 py-0.5 text-xs text-zinc-100 outline-none focus:border-emerald-500"
    />
  );
};
