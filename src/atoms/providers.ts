import { atom } from "jotai";
import { loadable } from "jotai/utils";

import { invokeTauri } from "@/lib/tauri";
import type { DetectedProvider } from "@/types";

const detectProvidersBaseAtom = atom(async () => {
  return invokeTauri<DetectedProvider[]>("detect_providers");
});

export const detectedProvidersAtom = loadable(detectProvidersBaseAtom);
