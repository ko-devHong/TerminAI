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
              if (
                confirm("모든 데이터(탭, 스페이스, 설정)를 초기화하고 온보딩을 다시 시작할까요?")
              ) {
                window.localStorage.clear();
                window.location.reload();
              }
            }}
            className="text-red-400 focus:bg-red-500/10 focus:text-red-400"
          >
            <Command className="size-4" />앱 데이터 전체 초기화 (Reset)
          </CommandItem>
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
