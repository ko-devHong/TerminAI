import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { terminalCacheMap } from "@/lib/terminal-cache";

interface TerminalSearchBarProps {
  tabId: string | null;
  open: boolean;
  onClose: () => void;
}

export function TerminalSearchBar({ tabId, open, onClose }: TerminalSearchBarProps) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    } else {
      setQuery("");
      // Return focus to terminal when closed
      if (tabId) {
        const cached = terminalCacheMap.get(tabId);
        if (cached) {
          window.requestAnimationFrame(() => {
            cached.terminal.focus();
          });
        }
      }
    }
  }, [open, tabId]);

  function getSearchAddon() {
    if (!tabId) return null;
    return terminalCacheMap.get(tabId)?.searchAddon ?? null;
  }

  function findNext() {
    const addon = getSearchAddon();
    if (!addon || !query) return;
    addon.findNext(query, { caseSensitive });
  }

  function findPrevious() {
    const addon = getSearchAddon();
    if (!addon || !query) return;
    addon.findPrevious(query, { caseSensitive });
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    const addon = getSearchAddon();
    if (!addon) return;
    if (value) {
      addon.findNext(value, { caseSensitive, incremental: true });
    } else {
      addon.clearDecorations();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        findPrevious();
      } else {
        findNext();
      }
    }
  }

  if (!open) return null;

  return (
    <div className="absolute top-0 right-0 z-50 flex items-center gap-1 rounded-bl-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 shadow-lg">
      <Search className="h-3.5 w-3.5 shrink-0 text-zinc-400" />

      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search..."
        className="w-48 bg-transparent text-xs text-zinc-100 placeholder:text-zinc-500 outline-none"
      />

      <button
        onClick={() => setCaseSensitive((prev) => !prev)}
        title="Case sensitive"
        className={`rounded px-1 py-0.5 text-xs transition-colors ${
          caseSensitive
            ? "bg-zinc-600 text-zinc-100"
            : "text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
        }`}
      >
        Aa
      </button>

      <div className="mx-1 h-4 w-px bg-zinc-700" />

      <button
        onClick={findPrevious}
        disabled={!query}
        title="Previous match (Shift+Enter)"
        className="rounded p-0.5 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200 disabled:opacity-40"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>

      <button
        onClick={findNext}
        disabled={!query}
        title="Next match (Enter)"
        className="rounded p-0.5 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200 disabled:opacity-40"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      <button
        onClick={onClose}
        title="Close (Esc)"
        className="rounded p-0.5 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
