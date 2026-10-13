import type { ModuleManifest } from "@/lib/modules/types"

/** Reference module: a block/price ticker card, a page that exercises the whole API, and a transaction type. */
export const example: ModuleManifest = {
  id: "example",
  name: "Example",
  description: "Developer reference: block and price ticker, the module API playground and a self-payment transaction type.",
  ui: "example",
  chains: "all",
  permissions: ["wallet:read", "wallet:receive", "wallet:send"],
  hosts: ["mempool.space"],
  views: [
    { id: "ticker", slot: "dashboard", title: "Ticker", icon: "blocks" },
    { id: "playground", slot: "page", title: "Example", icon: "flask-conical" },
    { id: "self", slot: "send", title: "To myself", icon: "sparkles" },
  ],
  config: { priceApi: "https://mempool.space/api/v1/prices" },
}
