import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { tabAtom, toggleSpaceCollapsedAtom } from "@/atoms/spaces";
import { TabItem } from "@/components/sidebar/TabItem";
import type { Space } from "@/types";

interface SpaceGroupProps {
  space: Space;
}

export function SpaceGroup({ space }: SpaceGroupProps) {
  const toggleSpaceCollapsed = useSetAtom(toggleSpaceCollapsedAtom);
  const { setNodeRef, isOver } = useDroppable({
    id: `space:${space.id}`,
  });

  return (
    <section className="space-y-1">
      <button
        type="button"
        onClick={() => toggleSpaceCollapsed(space.id)}
        className="flex h-8 w-full items-center gap-1 rounded-md px-2 text-left text-xs text-zinc-300 hover:bg-zinc-800"
      >
        <motion.span
          animate={{ rotate: space.isCollapsed ? 0 : 90 }}
          transition={{ duration: 0.15 }}
          className="inline-flex"
        >
          <ChevronRight className="size-3" />
        </motion.span>
        <span className="truncate">{space.name}</span>
      </button>

      <AnimatePresence initial={false}>
        {!space.isCollapsed ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
            style={{ overflow: "hidden" }}
          >
            <div
              ref={setNodeRef}
              className={`space-y-1 rounded-md pl-2 ${isOver ? "bg-zinc-800/40" : ""}`}
            >
              <SortableContext
                items={space.tabIds.map((tabId) => `tab:${tabId}`)}
                strategy={verticalListSortingStrategy}
              >
                <AnimatePresence mode="popLayout">
                  {space.tabIds.map((tabId) => (
                    <motion.div
                      key={tabId}
                      layout
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20, transition: { duration: 0.15 } }}
                      transition={{ type: "spring", stiffness: 500, damping: 30 }}
                    >
                      <SpaceTabGuard tabId={tabId} />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </SortableContext>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
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
