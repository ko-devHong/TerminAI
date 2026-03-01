import { useAtomValue, useSetAtom } from "jotai";
import { Plus } from "lucide-react";

import { createTabAtom, focusedTabAtom, spacesAtom } from "@/atoms/spaces";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PROVIDERS } from "@/lib/providers";
import { type AIProvider } from "@/types";

const NEW_TAB_PROVIDERS: AIProvider[] = ["claude-code", "codex-cli", "gemini-cli"];

export function NewTabButton() {
  const spaces = useAtomValue(spacesAtom);
  const focusedTab = useAtomValue(focusedTabAtom);
  const createTab = useSetAtom(createTabAtom);

  function handleCreateTab(provider: AIProvider) {
    const fallbackSpaceId = spaces[0]?.id;
    const nextSpaceId = focusedTab?.spaceId ?? fallbackSpaceId;
    if (!nextSpaceId) {
      return;
    }

    createTab({ spaceId: nextSpaceId, provider });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-full justify-start gap-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
        >
          <Plus className="size-3" />
          New Tab
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-48 border-zinc-700 bg-zinc-900 text-zinc-100">
        {NEW_TAB_PROVIDERS.map((provider) => (
          <DropdownMenuItem
            key={provider}
            className="cursor-pointer"
            onClick={() => handleCreateTab(provider)}
          >
            {PROVIDERS[provider].label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
