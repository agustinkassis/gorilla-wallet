import "server-only"
import { db } from "@/lib/server/db"
import { signWith } from "@/lib/server/sign-core"
import { chainFor, type ChainClient } from "@/lib/server/watcher"
import { signingAccount } from "@/lib/server/wallets"
import { familyOf, type Chain } from "@/lib/chains"

export { SignError } from "@/lib/server/sign-core"

/**
 * Sign with a wallet's keys (env seed, or a software seed unlocked by its password, if any, for this call only).
 * Prevouts come from the chain (SQLite raw-tx cache / Electrum), frozen coins from the wallet's labels.
 */
export async function signPsbt(walletId: string, chain: Chain, psbt: Uint8Array, password?: unknown, sessionClient?: ChainClient) {
  if (sessionClient && sessionClient.chain !== chain) throw new Error("Signing client is on another chain")
  const [acct, client] = await Promise.all([signingAccount(walletId, familyOf(chain), password), sessionClient ?? chainFor(chain)])
  const frozen = await db.label.findMany({ where: { walletId, chain, type: "output", spendable: false }, select: { ref: true } })
  return signWith(chain, psbt, {
    ...acct,
    prevOut: async (txid, vout) => (await client.getTx(txid)).getOutput(vout),
    frozen: new Set(frozen.map((l) => l.ref)),
  })
}
