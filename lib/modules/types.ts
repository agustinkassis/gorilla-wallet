// Module system: shared types for the host (the wallet) and modules (sandboxed frames). See docs/MODULES.md.
import type { IconName } from "lucide-react/dynamic"
import type { Chain, Family } from "@/lib/chains"
import type { Fees } from "@/lib/wallet"

/**
 * What a module may ask the wallet for, granted when the user enables it (shown in Settings → Modules).
 * Network info (chain, height, fees), its own storage and `ui.*` need none.
 */
export type Permission =
  /** balance of the selected wallet on the selected chain */
  | "wallet:read"
  /** the next unused receive address */
  | "wallet:receive"
  /** propose transactions; the user reviews, signs and broadcasts each one in the wallet's own dialog */
  | "wallet:send"
  /** open popups outside the sandbox (e.g. a faucet's site to solve its captcha) */
  | "ui:popups"

export const PERMISSIONS: Record<Permission, string> = {
  "wallet:read": "See the wallet's balance",
  "wallet:receive": "Get receive addresses",
  "wallet:send": "Propose transactions (you review and sign each one)",
  "ui:popups": "Open websites in new windows",
}

/** Where a view shows: its own page in the sidebar, a dashboard card, or a transaction type on the Send page. */
export type Slot = "page" | "dashboard" | "send"

/** `icon`: a lucide icon name (lucide.dev/icons), e.g. "droplet" */
export type ModuleView = { id: string; slot: Slot; title: string; icon?: IconName }

/**
 * A module instance. Several instances can share one UI (`ui`) with different `config`, e.g. a faucet per testnet:
 * `{ ...faucet, id: "faucet-signet", chains: ["signet"], config: { faucets: [...] } }`.
 * Manifests are data: they run in the wallet (sidebar, settings, server checks); module code only runs in the sandbox.
 */
export type ModuleManifest = {
  /** instance id: [a-z0-9-], unique */
  id: string
  name: string
  description: string
  /** key of its UI in modules/ui.ts */
  ui: string
  /** chains it works on; its views only show while one of them is selected */
  chains: Chain[] | "all"
  permissions: Permission[]
  /** https hosts its `http.fetch` may reach (exact hostnames, port 443), through the wallet's server */
  hosts?: string[]
  views: ModuleView[]
  /** handed to the module as is: per-instance settings (never secrets of the wallet) */
  config?: Record<string, unknown>
  /** on until the user turns it off */
  enabled?: boolean
}

/** What every module can read: the selected network. */
export type ModuleInfo = {
  chain: Chain
  label: string
  unit: string
  family: Family
  height: number
  explorer: string
  fees: Fees | null
  watchOnly: boolean
}

export type ModuleInit = {
  module: { id: string; name: string }
  view: string
  config: Record<string, unknown>
  permissions: Permission[]
  info: ModuleInfo
  theme: "light" | "dark"
}

/** A transaction a module proposes. Amounts in sats; `script` and `data` in hex. The wallet picks coins and change. */
export type SendRequest = {
  outputs: ({ address: string; amount: number } | { script: string; amount: number })[]
  /** OP_RETURN payload (padded on Bitcoin so Blake rejects it) */
  data?: string
  /** sat/vB; defaults to the wallet's preset */
  feeRate?: number
  /** shown to the user while reviewing */
  memo?: string
}

export type HttpRequest = { url: string; method?: "GET" | "POST" | "PUT" | "DELETE"; headers?: Record<string, string>; body?: string }
export type HttpResponse = { status: number; contentType: string | null; body: string }

/** RPC over postMessage. `token` (from the frame URL's fragment) ties a message to the document the wallet loaded. */
export type RpcRequest = { gorilla: 1; token: string; id: number; method: string; params?: unknown }
export type RpcResponse = { gorilla: 1; id: number; result?: unknown; error?: string }
export type RpcEvent = { gorilla: 1; event: "info"; data: ModuleInfo }

export const MODULE_ID = /^[a-z0-9-]{1,40}$/
export const STORAGE_KEY = /^[\w.-]{1,64}$/
export const STORAGE_MAX = 64 * 1024
