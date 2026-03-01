import { invoke } from "@tauri-apps/api/core";
import { type Event, listen, type UnlistenFn } from "@tauri-apps/api/event";

export function isTauriRuntimeAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return "__TAURI_INTERNALS__" in window;
}

export async function invokeTauri<T>(
  command: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  if (!isTauriRuntimeAvailable()) {
    throw new Error(`Tauri runtime is unavailable: ${command}`);
  }

  return invoke<T>(command, payload);
}

export async function listenTauri<T>(
  eventName: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  if (!isTauriRuntimeAvailable()) {
    return () => {};
  }

  return listen<T>(eventName, handler);
}
