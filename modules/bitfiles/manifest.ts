import type { ModuleManifest } from "@/lib/modules/types"

export type BitfilesConfig = {
  /** mempool.space-compatible API on Blake: reads the funding tx, broadcasts the reveal */
  api: string
  /** where an uploaded file is shown: `${viewer}/${revealTxid}` */
  viewer: string
}

export const bitfiles: ModuleManifest = {
  id: "bitfiles",
  name: "Bitfiles",
  description: "Store files on Blake with the bpub protocol and share them on bitfiles.io.",
  ui: "bitfiles",
  chains: ["xbt"],
  permissions: ["wallet:receive", "wallet:send", "ui:popups"],
  hosts: ["mempool.kilombino.com"],
  views: [{ id: "upload", slot: "page", title: "Bitfiles", icon: "file-up" }],
  config: { api: "https://mempool.kilombino.com", viewer: "https://bitfiles.io/btcb2" } satisfies BitfilesConfig,
  enabled: true,
}
