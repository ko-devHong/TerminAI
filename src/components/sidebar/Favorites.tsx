import { useAtomValue } from "jotai";
import { Star } from "lucide-react";

import { favoriteTabIdsAtom } from "@/atoms/spaces";
import { TabItem } from "@/components/sidebar/TabItem";

export function Favorites() {
  const favoriteTabIds = useAtomValue(favoriteTabIdsAtom);

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 px-2 text-xs font-medium text-zinc-300">
        <Star className="size-3" />
        <span>Favorites</span>
      </div>

      <div className="space-y-1">
        {favoriteTabIds.length === 0 ? (
          <p className="px-2 text-xs text-zinc-500">No favorites yet.</p>
        ) : (
          favoriteTabIds.map((tabId) => <TabItem key={tabId} tabId={tabId} />)
        )}
      </div>
    </section>
  );
}
