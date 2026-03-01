import { useAtomValue, useSetAtom } from "jotai";
import { ChevronDown, ChevronRight } from "lucide-react";

import { tabAtom, toggleSpaceCollapsedAtom } from "@/atoms/spaces";
import { TabItem } from "@/components/sidebar/TabItem";
import type { Space } from "@/types";

interface SpaceGroupProps {
  space: Space;
}

export function SpaceGroup({ space }: SpaceGroupProps) {
  const toggleSpaceCollapsed = useSetAtom(toggleSpaceCollapsedAtom);

  return (
    <section className="space-y-1">
      <button
        type="button"
        onClick={() => toggleSpaceCollapsed(space.id)}
        className="flex h-8 w-full items-center gap-1 rounded-md px-2 text-left text-xs text-zinc-300 hover:bg-zinc-800"
      >
        {space.isCollapsed ? (
          <ChevronRight className="size-3" />
        ) : (
          <ChevronDown className="size-3" />
        )}
        <span className="truncate">{space.name}</span>
      </button>

      {!space.isCollapsed ? (
        <div className="space-y-1 pl-2">
          {space.tabIds.map((tabId) => (
            <SpaceTabGuard key={tabId} tabId={tabId} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SpaceTabGuard({ tabId }: { tabId: string }) {
  const tab = useAtomValue(tabAtom(tabId));
  if (!tab) {
    return null;
  }
  return <TabItem tabId={tabId} />;
}
