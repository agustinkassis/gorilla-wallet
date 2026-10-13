// Module registry. A module is a folder with manifest.ts (data, runs in the wallet) and ui.tsx (runs sandboxed): list
// its manifest(s) here and its UI in ./ui.ts. See docs/MODULES.md.
import type { Chain } from "@/lib/chains"
import type { ModuleManifest, Slot } from "@/lib/modules/types"
import { example } from "./example/manifest"
import { faucets } from "./faucet/manifest"

export const MODULES: ModuleManifest[] = [...faucets, example]

export const moduleById = (id: string) => MODULES.find((m) => m.id === id)

/** The user's switch (Settings → Modules), else the manifest's default. */
export const isEnabled = (m: ModuleManifest, enabled: Record<string, boolean>) => enabled[m.id] ?? m.enabled ?? false

export const runsOn = (m: ModuleManifest, chain: Chain) => m.chains === "all" || m.chains.includes(chain)

/** Enabled modules' views for a slot on the selected chain. */
export const viewsFor = (enabled: Record<string, boolean>, chain: Chain, slot: Slot) =>
  MODULES.filter((m) => isEnabled(m, enabled) && runsOn(m, chain)).flatMap((module) =>
    module.views.filter((v) => v.slot === slot).map((view) => ({ module, view })),
  )
