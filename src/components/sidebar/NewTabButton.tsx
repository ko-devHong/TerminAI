import { useAtomValue, useSetAtom } from "jotai";
import { Plus } from "lucide-react";

import { detectedProvidersAtom } from "@/atoms/providers";
import { defaultCwdAtom } from "@/atoms/settings";
import { createTabAtom, focusedTabAtom, spacesAtom } from "@/atoms/spaces";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PROVIDERS } from "@/lib/providers";
import type { AIProvider } from "@/types";

const NEW_TAB_PROVIDERS: AIProvider[] = ["claude-code", "codex-cli", "gemini-cli"];

export function NewTabButton() {
  const spaces = useAtomValue(spacesAtom);
  const focusedTab = useAtomValue(focusedTabAtom);
  const defaultCwd = useAtomValue(defaultCwdAtom);
  const detectedProviders = useAtomValue(detectedProvidersAtom);
  const createTab = useSetAtom(createTabAtom);

  function handleCreateTab(provider: AIProvider) {
    const fallbackSpaceId = spaces[0]?.id;
    const nextSpaceId = focusedTab?.spaceId ?? fallbackSpaceId;
    if (!nextSpaceId) {
      return;
    }

    createTab({ spaceId: nextSpaceId, provider, cwd: focusedTab?.cwd ?? defaultCwd });

    // Prevent Enter from re-triggering this button while terminal tab is opening.
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
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

      <DropdownMenuContent
        side="top"
        className="w-52 border-zinc-700 bg-zinc-900 p-1 text-zinc-100"
      >
        {NEW_TAB_PROVIDERS.map((provider) => {
          const isLoading = detectedProviders.state === "loading";
          const isDetectable = PROVIDERS[provider].detectable;
          const isInstalled =
            !isDetectable ||
            detectedProviders.state !== "hasData" ||
            detectedProviders.data.some((detected) => detected.id === provider && detected.found);

          const isDisabled = isLoading || !isInstalled;

          return (
            <DropdownMenuItem
              key={provider}
              disabled={isDisabled}
              className="cursor-pointer gap-3 rounded-md px-3 py-2.5 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
              onSelect={() => handleCreateTab(provider)}
            >
              {PROVIDERS[provider].icon ? (
                <img
                  src={PROVIDERS[provider].icon}
                  alt=""
                  className="size-5 shrink-0 rounded object-contain"
                />
              ) : null}
              <span>{PROVIDERS[provider].label}</span>
              {!isInstalled ? <span className="text-xs text-zinc-500">(미설치)</span> : null}
              {isLoading ? <span className="text-xs text-zinc-500">(확인 중)</span> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
