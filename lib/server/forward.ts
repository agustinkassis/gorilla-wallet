import "server-only"
import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { bytesToHex } from "@noble/hashes/utils.js"
import { db } from "@/lib/server/db"
import { getWallet } from "@/lib/server/wallets"
import { openSyncSession } from "@/lib/server/watcher"
import { signPsbt } from "@/lib/server/signer"
import { broadcastHex, validateBroadcast } from "@/lib/server/broadcast"
import { acquireForwardLease } from "@/lib/server/forward-lease"
import { deriveAddress, type Snapshot } from "@/lib/wallet"
import { familyOf, syncedChains, type Chain } from "@/lib/chains"
import { buildPsbt, feeAt, planTx, PlanError, scriptFor, type Coin } from "@/lib/tx"

/** Size of the random OP_RETURN payload when a rule has no message. */
export const RANDOM_DATA_BYTES = 90

export class ForwardError extends Error {}

type Input = { txid: string; vout: number; value: number }
type Outcome = { status: "sent" | "skipped" | "error"; reason?: string; txid?: string; amount?: number; fee?: number; feeRate?: number; inputs?: Input[]; dataHex?: string; observedBalance?: number }
type ForwardResult = Omit<Outcome, "status"> & {
  ruleId: string; status: Outcome["status"] | "busy" | "idle" | "dry-run"; chain?: Chain; from?: string | null; to?: string
  source?: "wallet" | "address"; mode?: "sweep" | "fixed"; amountSats?: number | null; balanceAboveSats?: number | null
  vsize?: number; change?: { address: string; amount: number } | null
}

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
 * One forward cycle: a fixed payment or sweep from an address or the wallet, gated by eligible wallet balance.
 * The shared wallet/chain lease serializes all its rules; simulations neither acquire leases nor record runs.
 */
export async function runForward(id: string, o: { dryRun?: boolean; timeoutMs: number }): Promise<ForwardResult> {
  const rule = await db.forwardRule.findUnique({ where: { id } })
  if (!rule) throw new ForwardError(`Unknown forward rule: ${id}`)
  const dryRun = !!o.dryRun
  const start = new Date()
  const chain = rule.chain as Chain
  if (chain !== "btc" && chain !== "regtest") throw new ForwardError("Forward supports only BTC and regtest")
  const lease = dryRun ? null : await acquireForwardLease(rule.walletId, chain, o.timeoutMs + 60_000)
  if (!dryRun && !lease) return { ruleId: id, status: "busy" }
  const base = {
    ruleId: id, chain, from: rule.fromAddress, to: rule.toAddress,
    source: rule.fromAddress === null ? "wallet" as const : "address" as const, mode: rule.amountSats === null ? "sweep" as const : "fixed" as const,
    amountSats: rule.amountSats === null ? null : Number(rule.amountSats), balanceAboveSats: rule.balanceAboveSats === null ? null : Number(rule.balanceAboveSats),
  }
  let observedBalance: number | undefined
  const record = async (outcome: Outcome) => {
    if (dryRun) return
    const { inputs, amount, fee, observedBalance: balance = observedBalance, ...rest } = outcome
    await db.forwardRun.create({
      data: { ruleId: id, startedAt: start, ...rest, observedBalance: balance === undefined ? null : BigInt(balance), inputs: JSON.stringify(outcome.status === "sent" ? inputs ?? [] : []), amount: amount === undefined ? null : BigInt(amount), fee: fee === undefined ? null : BigInt(fee) },
    })
  }
  const skip = async (reason: string, details: Partial<Omit<Outcome, "status" | "reason">> = {}) => {
    const outcome: Outcome = { status: "skipped", reason, observedBalance, ...details }
    await record(outcome)
    return { ...base, ...outcome }
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
    await lease?.assertOwned()
    if (rule.fromAddress === null) {
      const destination = bytesToHex(scriptFor(rule.toAddress, chain))
      if (snapshot.addresses.some((a) => bytesToHex(scriptFor(a.address, chain)) === destination))
        throw new ForwardError("Forward destination belongs to this wallet; wallet forwarding requires an external destination")
    }

    const spentBy = new Map<string, string>()
    const rules = await db.forwardRule.findMany({ where: { walletId: wallet.id, chain }, select: { id: true } })
    for (const run of await db.forwardRun.findMany({ where: { status: "sent", ruleId: { in: rules.map((r) => r.id) } }, select: { txid: true, inputs: true } }))
      for (const input of JSON.parse(run.inputs) as Input[]) if (run.txid) spentBy.set(`${input.txid}:${input.vout}`, run.txid)
    const eligible: Coin[] = []
    const reservations = new Map<string, boolean>()
    for (const utxo of snapshot.utxos) {
      if (utxo.frozen || confirmations(utxo.height, snapshot.height) < rule.minConf) continue
      const previous = spentBy.get(`${utxo.txid}:${utxo.vout}`)
      if (previous) {
        if (!reservations.has(previous)) reservations.set(previous, await stillKnown(previous, snapshot, client.mempool, o.timeoutMs))
        if (reservations.get(previous)) continue
      }
      const address = snapshot.addresses.find((a) => a.address === utxo.address)
      if (!address) throw new ForwardError("UTXO address was not discovered")
      eligible.push({ txid: utxo.txid, vout: utxo.vout, value: utxo.value, address: utxo.address, change: address.change, index: address.index, height: utxo.height })
    }
    observedBalance = eligible.reduce((sum, coin) => sum + coin.value, 0)
    if (!Number.isSafeInteger(observedBalance)) throw new ForwardError("Eligible balance exceeds safe integer range")
    if (rule.balanceAboveSats !== null && BigInt(observedBalance) <= rule.balanceAboveSats)
      return skip(`eligible wallet balance ${observedBalance} sats is not strictly above threshold ${rule.balanceAboveSats} sats`)
    const coins = eligible.filter((coin) => rule.fromAddress === null || coin.address === rule.fromAddress)
    if (!coins.length) return rule.amountSats === null ? { ...base, observedBalance, status: "idle" } : skip("Insufficient funds for amount + fee at the selected source")

    try { await client.waitForFees(Math.min(o.timeoutMs, 20_000)) } catch {}
    if (!client.fees) throw new ForwardError("No fee estimate available")
    const rate = Math.max(client.fees.hourFee, client.fees.minimumFee)
    if (rate > rule.maxFeeRate) return skip(`fee above cap: estimate ${rate} sat/vB > max ${rule.maxFeeRate} sat/vB`, { feeRate: rate })

    let changeAddress = rule.fromAddress
    if (changeAddress === null) {
      const states = await db.addressState.findMany({ where: { walletId: wallet.id, chain: { in: syncedChains(chain) }, used: true }, select: { address: true } })
      const used = new Set(states.map((a) => a.address))
      let index = 0
      while (used.has(deriveAddress(account.xpub, 1, index, family).address)) index++
      changeAddress = deriveAddress(account.xpub, 1, index, family).address
    }

    const data = rule.message === null ? randomBytes(RANDOM_DATA_BYTES) : new TextEncoder().encode(rule.message)
    const dataHex = bytesToHex(data)
    let plan: ReturnType<typeof planTx>
    try {
      plan = planTx({ chain, recipients: [{ address: rule.toAddress, amount: rule.amountSats === null ? 1 : Number(rule.amountSats) }], ...(rule.amountSats === null ? { sendMax: true, required: coins } : { candidates: coins }), fee: feeAt(rate), changeAddress, data })
    } catch (error) {
      if (!(error instanceof PlanError)) throw error
      return skip(error.message, { feeRate: rate, dataHex })
    }
    const effectiveRate = plan.fee / plan.vsize
    if (effectiveRate > rule.maxFeeRate)
      return skip(`effective fee above cap: ${effectiveRate} sat/vB > max ${rule.maxFeeRate} sat/vB`, { feeRate: effectiveRate, fee: plan.fee, dataHex })
    const inputs = plan.inputs.map((c) => ({ txid: c.txid, vout: c.vout, value: c.value }))
    const amount = plan.outputs.find((out) => out.kind === "recipient")!.amount
    const change = plan.outputs.find((out) => out.kind === "change")
    const review = { ...base, observedBalance, amount, fee: plan.fee, feeRate: effectiveRate, vsize: plan.vsize, inputs, dataHex, change: change ? { address: change.address!, amount: change.amount } : null }
    if (dryRun) return { ...review, status: "dry-run" as const }

    const password = rule.passwordFile ? (await readFile(rule.passwordFile, "utf8")).replace(/\r?\n$/, "") : ""
    await lease?.assertOwned()
    const psbt = buildPsbt(plan, { chain, xpub: account.xpub, fingerprint: account.fingerprint, accountPath: account.path, tipHeight: snapshot.height }).toPSBT()
    const signed = await signPsbt(wallet.id, chain, psbt, password, client, lease?.assertOwned)
    validateBroadcast(chain, signed.hex)
    await lease?.assertOwned()
    const txid = await broadcastHex(client, signed.hex, lease?.assertOwned)
    await record({ status: "sent", txid, amount, fee: signed.fee, feeRate: effectiveRate, inputs, dataHex })
    return { ...review, status: "sent" as const, txid, fee: signed.fee, vsize: signed.vsize }
  } catch (error) {
    await record({ status: "error", reason: error instanceof Error ? error.message : String(error) }).catch(() => {})
    throw error
  } finally {
    try { await session?.close() }
    finally {
      await lease?.close().catch(() => {})
      if (!dryRun) await db.forwardRule.updateMany({ where: { id }, data: { lastCheckedAt: new Date() } }).catch(() => {})
    }
  }
}
