import { Command } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import type { Space, Tab } from "@/types";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaces: Space[];
  orderedTabs: Tab[];
  focusedTab: Tab | null;
  defaultCwd: string;
  onCreateTab: (payload: { spaceId: string; provider: Tab["provider"]; cwd: string }) => void;
  onFocusTab: (tabId: string) => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  spaces,
  orderedTabs,
  focusedTab,
  defaultCwd,
  onCreateTab,
  onFocusTab,
}: CommandPaletteProps) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search commands, tabs, spaces..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Quick Actions">
          <CommandItem
            onSelect={() => {
              const nextSpaceId = focusedTab?.spaceId ?? spaces[0]?.id;
              if (!nextSpaceId) return;
              onCreateTab({
                spaceId: nextSpaceId,
                provider: "claude-code",
                cwd: focusedTab?.cwd ?? defaultCwd,
              });
              onOpenChange(false);
            }}
          >
            <Command className="size-4" />
            New Claude Tab
            <CommandShortcut>⌘T</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              const nextSpaceId = focusedTab?.spaceId ?? spaces[0]?.id;
              if (!nextSpaceId) return;
              onCreateTab({
                spaceId: nextSpaceId,
                provider: "codex-cli",
                cwd: focusedTab?.cwd ?? defaultCwd,
              });
              onOpenChange(false);
            }}
          >
            <Command className="size-4" />
            New Codex Tab
          </CommandItem>
          <CommandItem
            onSelect={() => {
              const nextSpaceId = focusedTab?.spaceId ?? spaces[0]?.id;
              if (!nextSpaceId) return;
              onCreateTab({
                spaceId: nextSpaceId,
                provider: "gemini-cli",
                cwd: focusedTab?.cwd ?? defaultCwd,
              });
              onOpenChange(false);
            }}
          >
            <Command className="size-4" />
            New Gemini Tab
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading="Tabs">
          {orderedTabs.map((tab) => (
            <CommandItem
              key={tab.id}
              onSelect={() => {
                onFocusTab(tab.id);
                onOpenChange(false);
              }}
            >
              <span className="truncate">{tab.name}</span>
              <CommandShortcut>{tab.provider}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
