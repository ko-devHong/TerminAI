import type { UnlistenFn } from "@tauri-apps/api/event";
import { useEffect } from "react";

import { listenTauri } from "@/lib/tauri";

export function useTauriEvent<T>(eventName: string | null, handler: (payload: T) => void): void {
  useEffect(() => {
    if (!eventName) {
      return;
    }

    let unlisten: UnlistenFn | null = null;
    let isMounted = true;

    void listenTauri<T>(eventName, (event) => {
      if (isMounted) {
        handler(event.payload);
      }
    }).then((detach) => {
      if (isMounted) {
        unlisten = detach;
      } else {
        detach();
      }
    });

    return () => {
      isMounted = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, [eventName, handler]);
}
