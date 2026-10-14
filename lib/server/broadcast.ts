import "server-only"
import type { ChainClient } from "@/lib/server/watcher"
import { CHAINS, type Chain } from "@/lib/chains"
import { parseTxHex, outputRuleError } from "@/lib/tx"
import { SIGHASH_UNIFIED } from "@/lib/unified-sighash"

export class BroadcastError extends Error {}

export function validateBroadcast(chain: Chain, hex: string) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) throw new BroadcastError("Invalid transaction")
  const tx = parseTxHex(hex)
  if (!tx.inputsLength || !tx.outputsLength) throw new BroadcastError("Transaction has no inputs or outputs")
  for (let i = 0; i < tx.inputsLength; i++) {
    const sig = tx.getInput(i).finalScriptWitness?.[0]
    const unified = !!sig && (sig[sig.length - 1] & SIGHASH_UNIFIED) !== 0
    const { label, unifiedSighash } = CHAINS[chain]
    if (unifiedSighash && !unified) throw new BroadcastError(`${label} transactions must be SIGHASH_UNIFIED-signed (replay protection)`)
    if (!unifiedSighash && unified) throw new BroadcastError(`This transaction is SIGHASH_UNIFIED-signed: ${label} rejects it`)
  }
  for (let i = 0; i < tx.outputsLength; i++) {
    const script = tx.getOutput(i).script
    if (!script) throw new BroadcastError("Malformed output")
    const error = outputRuleError(chain, script)
    if (error) throw new BroadcastError(error)
  }
  return tx
}

/** Push a raw tx to the watcher's own chain: its mempool sources in order, then Electrum. Returns the txid. */
export async function broadcastHex(watcher: ChainClient, hex: string, beforeAttempt?: () => Promise<void>) {
  const expected = parseTxHex(hex).id
  for (const base of watcher.mempool) {
    // A forward may lose its lease while an endpoint times out; fence every fallback, not only the first attempt.
    await beforeAttempt?.()
    try {
      const res = await fetch(`${base}/api/tx`, {
        method: "POST",
        body: hex,
        headers: { "Content-Type": "text/plain" },
        signal: AbortSignal.timeout(20_000),
      })
      const text = (await res.text()).trim()
      if (res.ok) {
        if (text !== expected) throw new BroadcastError("Server returned a different transaction ID")
        return text
      }
      if (res.status >= 400 && res.status < 500) throw new BroadcastError(text || "Rejected by the network")
    } catch (e) {
      if (e instanceof BroadcastError) throw e
    }
  }
  await beforeAttempt?.()
  try {
    const txid = await watcher.client.request<string>("blockchain.transaction.broadcast", [hex])
    if (txid !== expected) throw new BroadcastError("Server returned a different transaction ID")
    return txid
  } catch (e) {
    throw new BroadcastError((e as Error).message || "Broadcast failed")
  }
}
