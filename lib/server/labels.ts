import "server-only"
import type { Chain } from "@/lib/chains"
import { db } from "@/lib/server/db"
import { scriptFor } from "@/lib/tx"
import { currentSyncs } from "@/lib/server/watcher"

export type LabelType = "tx" | "addr" | "output"

/** A label's ref on a chain: txid, "txid:vout", or an address of that chain's network. */
export function validRef(type: unknown, ref: string, chain: Chain): type is LabelType {
  if (type === "tx") return /^[0-9a-f]{64}$/.test(ref)
  if (type === "output") return /^[0-9a-f]{64}:\d{1,6}$/.test(ref)
  if (type !== "addr" || ref !== ref.trim()) return false
  try {
    return !!scriptFor(ref, chain)
  } catch {
    return false
  }
}

/** Upsert a BIP-329-style label for a wallet; clearing both label and spendable removes the row. */
export async function setLabel(walletId: string, chain: string, type: LabelType, ref: string, label: string | null, spendable: boolean | null) {
  if (label === null && spendable === null) await db.label.deleteMany({ where: { walletId, chain, type, ref } })
  else
    await db.label.upsert({
      where: { walletId_chain_type_ref: { walletId, chain, type, ref } },
      create: { walletId, chain, type, ref, label, spendable },
      update: { label, spendable },
    })
}

/** Labels/frozen flags are joined into snapshots: rebuild that wallet's. */
export const republish = (walletId: string) => Promise.all(currentSyncs().filter((s) => s.walletId === walletId).map((s) => s.publish()))
