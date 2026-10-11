import "server-only"
import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { bytesToHex } from "@noble/hashes/utils.js"
import { db } from "@/lib/server/db"
import { getWallet } from "@/lib/server/wallets"
import { openSyncSession } from "@/lib/server/watcher"
import { signPsbt } from "@/lib/server/signer"
import { broadcastHex, validateBroadcast } from "@/lib/server/broadcast"
import { deriveAddress, type Snapshot } from "@/lib/wallet"
import { familyOf, type Chain } from "@/lib/chains"
import { buildPsbt, feeAt, planTx, PlanError, type Coin } from "@/lib/tx"

/** Size of the random OP_RETURN payload when a rule has no message. */
export const RANDOM_DATA_BYTES = 90

export class ForwardError extends Error {}

type Input = { txid: string; vout: number; value: number }
type Outcome = { status: "sent" | "skipped" | "error"; reason?: string; txid?: string; amount?: number; fee?: number; feeRate?: number; inputs?: Input[]; dataHex?: string }

const confirmations = (height: number, tip: number) => (height > 0 ? Math.max(0, tip - height + 1) : 0)

/**
 * Whether a previous forward transaction still exists: in the wallet's fresh history, or on a mempool API.
 * Only an explicit "not found" from every reachable source frees its coins; unreachable sources keep them reserved.
 */
async function stillKnown(txid: string, snapshot: Snapshot, mempool: string[], timeoutMs: number) {
  if (snapshot.txs.some((t) => t.txid === txid)) return true
  let missing = false
  for (const base of mempool) {
    try {
      const res = await fetch(`${base}/api/tx/${txid}/status`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)) })
      if (res.ok) return true
      if (res.status === 404) missing = true
    } catch {}
  }
  return !missing
}

/**
 * One forward run: sweep `fromAddress`'s confirmed coins to `toAddress` with an OP_RETURN, unless the fee estimate is
 * above the rule's cap. A lease on the rule makes overlapping runs exit ("busy"); dry runs neither lease nor record.
 */
export async function runForward(id: string, o: { dryRun?: boolean; timeoutMs: number }) {
  const rule = await db.forwardRule.findUnique({ where: { id } })
  if (!rule) throw new ForwardError(`Unknown forward rule: ${id}`)
  const dryRun = !!o.dryRun
  const start = new Date()
  const until = new Date(start.getTime() + o.timeoutMs + 60_000)
  if (!dryRun) {
    const lease = await db.forwardRule.updateMany({
      where: { id, OR: [{ runningUntil: null }, { runningUntil: { lt: start } }] },
      data: { runningUntil: until },
    })
    if (!lease.count) return { ruleId: id, status: "busy" as const }
  }
  const chain = rule.chain as Chain
  const base = { ruleId: id, chain, from: rule.fromAddress, to: rule.toAddress }
  const record = async (outcome: Outcome) => {
    if (dryRun) return
    const { inputs, amount, fee, ...rest } = outcome
    await db.forwardRun.create({
      data: { ruleId: id, startedAt: start, ...rest, inputs: JSON.stringify(inputs ?? []), amount: amount === undefined ? null : BigInt(amount), fee: fee === undefined ? null : BigInt(fee) },
    })
  }
  let session: Awaited<ReturnType<typeof openSyncSession>> | undefined
  try {
    const wallet = await getWallet(rule.walletId)
    const family = familyOf(chain)
    const account = wallet.accounts[family]
    if (!account) throw new ForwardError("Wallet has no account on this network")
    session = await openSyncSession([wallet], [chain], o.timeoutMs)
    const snapshot = session.snapshots()[0]
    const client = session.client(chain)

    const spentBy = new Map<string, string>()
    for (const run of await db.forwardRun.findMany({ where: { status: "sent" }, select: { txid: true, inputs: true } }))
      for (const input of JSON.parse(run.inputs) as Input[]) if (run.txid) spentBy.set(`${input.txid}:${input.vout}`, run.txid)
    const coins: Coin[] = []
    for (const utxo of snapshot.utxos) {
      if (utxo.address !== rule.fromAddress || utxo.frozen || confirmations(utxo.height, snapshot.height) < rule.minConf) continue
      const previous = spentBy.get(`${utxo.txid}:${utxo.vout}`)
      if (previous && (await stillKnown(previous, snapshot, client.mempool, o.timeoutMs))) continue
      const address = snapshot.addresses.find((a) => a.address === utxo.address)
      if (!address) throw new ForwardError("UTXO address was not discovered")
      coins.push({ txid: utxo.txid, vout: utxo.vout, value: utxo.value, address: utxo.address, change: address.change, index: address.index, height: utxo.height })
    }
    if (!coins.length) return { ...base, status: "idle" as const }
    const inputs = coins.map((c) => ({ txid: c.txid, vout: c.vout, value: c.value }))

    try { await client.waitForFees(Math.min(o.timeoutMs, 20_000)) } catch {}
    if (!client.fees) throw new ForwardError("No fee estimate available")
    const rate = Math.max(client.fees.hourFee, client.fees.minimumFee)
    if (rate > rule.maxFeeRate) {
      const outcome: Outcome = { status: "skipped", reason: `fee above cap: estimate ${rate} sat/vB > max ${rule.maxFeeRate} sat/vB`, feeRate: rate, inputs }
      await record(outcome)
      return { ...base, ...outcome }
    }

    const data = rule.message === null ? randomBytes(RANDOM_DATA_BYTES) : new TextEncoder().encode(rule.message)
    const dataHex = bytesToHex(data)
    let plan: ReturnType<typeof planTx>
    try {
      plan = planTx({ chain, recipients: [{ address: rule.toAddress, amount: 1 }], sendMax: true, required: coins, fee: feeAt(rate), changeAddress: deriveAddress(account.xpub, 1, 0, family).address, data })
    } catch (error) {
      if (!(error instanceof PlanError)) throw error
      const outcome: Outcome = { status: "skipped", reason: error.message, feeRate: rate, inputs, dataHex }
      await record(outcome)
      return { ...base, ...outcome }
    }
    const amount = plan.outputs.find((out) => out.kind === "recipient")!.amount
    const review = { ...base, amount, fee: plan.fee, feeRate: rate, vsize: plan.vsize, inputs, dataHex }
    if (dryRun) return { ...review, status: "dry-run" as const }

    const password = rule.passwordFile ? (await readFile(rule.passwordFile, "utf8")).replace(/\r?\n$/, "") : ""
    const psbt = buildPsbt(plan, { chain, xpub: account.xpub, fingerprint: account.fingerprint, accountPath: account.path, tipHeight: snapshot.height }).toPSBT()
    const signed = await signPsbt(wallet.id, chain, psbt, password, client)
    validateBroadcast(chain, signed.hex)
    const txid = await broadcastHex(client, signed.hex)
    await record({ status: "sent", txid, amount, fee: signed.fee, feeRate: rate, inputs, dataHex })
    return { ...review, status: "sent" as const, txid, fee: signed.fee, vsize: signed.vsize }
  } catch (error) {
    await record({ status: "error", reason: error instanceof Error ? error.message : String(error) }).catch(() => {})
    throw error
  } finally {
    await session?.close()
    // Release only our own lease: if it expired and another run took the rule, that run keeps it.
    if (!dryRun) await db.forwardRule.updateMany({ where: { id, runningUntil: until }, data: { runningUntil: null, lastCheckedAt: new Date() } }).catch(() => {})
  }
}
