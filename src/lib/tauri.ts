import { invoke } from "@tauri-apps/api/core";
import { type Event, listen, type UnlistenFn } from "@tauri-apps/api/event";

export async function invokeTauri<T>(
  command: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  return invoke<T>(command, payload);
}

export async function listenTauri<T>(
  eventName: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  return listen<T>(eventName, handler);
}
