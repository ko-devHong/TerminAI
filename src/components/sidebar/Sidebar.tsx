import { useAtomValue, useSetAtom } from "jotai";
import { Search } from "lucide-react";
import { useMemo } from "react";

import { sidebarCollapsedAtom, sidebarWidthAtom } from "@/atoms/settings";
import { spacesAtom } from "@/atoms/spaces";
import { Favorites } from "@/components/sidebar/Favorites";
import { NewTabButton } from "@/components/sidebar/NewTabButton";
import { SpaceGroup } from "@/components/sidebar/SpaceGroup";
import { ScrollArea } from "@/components/ui/scroll-area";

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 360;

export function Sidebar() {
  const spaces = useAtomValue(spacesAtom);
  const sidebarWidth = useAtomValue(sidebarWidthAtom);
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const setSidebarWidth = useSetAtom(sidebarWidthAtom);

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

  return (
    <aside className="relative flex h-full w-(--sidebar-width) shrink-0 border-r border-zinc-800 bg-zinc-900">
      <div className="flex h-full w-full flex-col gap-3 p-2">
        <button
          type="button"
          className="flex h-8 items-center gap-2 rounded-md border border-zinc-800 px-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <Search className="size-3" />
          <span>Search / Cmd+K</span>
        </button>

        <ScrollArea className="h-full">
          <div className="space-y-3 pr-2">
            <Favorites />

            <div className="h-px bg-zinc-800" />

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
  );
}
