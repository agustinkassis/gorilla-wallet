import type { ComponentType } from "react"

/** Module UIs by `ui` key. Imported only by the sandboxed frame route (app/(module)), never by the wallet itself. */
export const UIS: Record<string, () => Promise<{ default: ComponentType<{ view: string }> }>> = {
  example: () => import("./example/ui"),
  faucet: () => import("./faucet/ui"),
}
