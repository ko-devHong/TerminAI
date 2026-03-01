import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import { useAtomValue, useSetAtom } from "jotai";
import { Search } from "lucide-react";
import { useMemo } from "react";

import { sidebarCollapsedAtom, sidebarWidthAtom } from "@/atoms/settings";
import { moveTabAtom, spacesAtom } from "@/atoms/spaces";
import { NewTabButton } from "@/components/sidebar/NewTabButton";
import { SpaceGroup } from "@/components/sidebar/SpaceGroup";
import { ScrollArea } from "@/components/ui/scroll-area";

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 360;

interface SidebarProps {
  onOpenCommandPalette?: () => void;
}

export function Sidebar({ onOpenCommandPalette }: SidebarProps) {
  const spaces = useAtomValue(spacesAtom);
  const sidebarWidth = useAtomValue(sidebarWidthAtom);
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const setSidebarWidth = useSetAtom(sidebarWidthAtom);
  const moveTab = useSetAtom(moveTabAtom);

  const computedWidth = useMemo(() => {
    if (sidebarCollapsed) {
      return 0;
    }

    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, sidebarWidth));
  }, [sidebarCollapsed, sidebarWidth]);

  function startResize(clientX: number) {
    const initialX = clientX;
    const initialWidth = computedWidth;

    function onMove(event: MouseEvent) {
      const delta = event.clientX - initialX;
      setSidebarWidth(
        Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, initialWidth + delta)),
      );
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  if (sidebarCollapsed) {
    return null;
  }

  function resolveSpaceByTab(tabId: string): { spaceId: string; index: number } | null {
    for (const space of spaces) {
      const index = space.tabIds.indexOf(tabId);
      if (index >= 0) {
        return { spaceId: space.id, index };
      }
    }
    return null;
  }

  function handleDragEnd(event: DragEndEvent) {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;

    if (!overId || !activeId.startsWith("tab:")) {
      return;
    }

    const draggedTabId = activeId.slice(4);
    const source = resolveSpaceByTab(draggedTabId);
    if (!source) {
      return;
    }

    if (overId.startsWith("space:")) {
      const targetSpaceId = overId.slice(6);
      const targetSpace = spaces.find((space) => space.id === targetSpaceId);
      if (!targetSpace) {
        return;
      }

      moveTab({
        tabId: draggedTabId,
        toSpaceId: targetSpaceId,
        toIndex: targetSpace.tabIds.length,
      });
      return;
    }

    if (!overId.startsWith("tab:")) {
      return;
    }

    const overTabId = overId.slice(4);
    if (overTabId === draggedTabId) {
      return;
    }

    const target = resolveSpaceByTab(overTabId);
    if (!target) {
      return;
    }

    let toIndex = target.index;
    if (source.spaceId === target.spaceId && source.index < target.index) {
      toIndex -= 1;
    }

    moveTab({
      tabId: draggedTabId,
      toSpaceId: target.spaceId,
      toIndex,
    });
  }

  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <aside className="relative flex h-full w-(--sidebar-width) shrink-0 border-r border-zinc-800 bg-zinc-900">
        <div className="flex h-full w-full flex-col gap-3 p-2">
          <button
            type="button"
            onClick={onOpenCommandPalette}
            className="flex h-8 items-center gap-2 rounded-md border border-zinc-800 px-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Search className="size-3" />
            <span>Search / Cmd+K</span>
          </button>

          <ScrollArea className="h-full">
            <div className="space-y-3 pr-2">
              {spaces.map((space) => (
                <SpaceGroup key={space.id} space={space} />
              ))}
            </div>
          </ScrollArea>

          <div className="h-px bg-zinc-800" />
          <NewTabButton />
        </div>

        <button
          type="button"
          aria-label="Resize sidebar"
          className="absolute top-0 right-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-zinc-700/60"
          onMouseDown={(event) => startResize(event.clientX)}
        />
      </aside>
    </DndContext>
  );
}
