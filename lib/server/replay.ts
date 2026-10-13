import "server-only"
import { bytesToHex } from "@noble/hashes/utils.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { CHAINS, REPLAY_LOCKTIME, replayPairs, type Chain } from "@/lib/chains"
import { db } from "@/lib/server/db"
import { chainFor, type ChainClient } from "@/lib/server/watcher"
import { addressFor, isDataScript, parseTxHex } from "@/lib/tx"
import { SIGHASH_UNIFIED } from "@/lib/unified-sighash"
import { addressScript, type Family, type Fees } from "@/lib/wallet"

export type Status = "pass" | "warn" | "fail"
export type ReplayInput = {
  txid: string
  vout: number
  value: number | null
  address: string | null
  ours: boolean
  onTarget: "unspent" | "spent" | "missing" | "unknown"
  sighash: number | null
  status: Status
  note: string
}
export type ReplayOutput = { address: string | null; amount: number; data: boolean; scriptSize: number; ours: boolean; status: Status; note: string }
export type ReplayCheck = { id: string; label: string; status: Status; detail: string }
export type ReplayAnalysis = {
  from: Chain
  to: Chain
  txid: string
  hex: string
  fee: number | null
  vsize: number
  feeRate: number | null
  targetHeight: number
  targetFees: Fees | null
  inputs: ReplayInput[]
  outputs: ReplayOutput[]
  checks: ReplayCheck[]
  replayable: boolean
}

const LOCKTIME_THRESHOLD = 500_000_000

/** Consensus validity of an output on the target chain (its OP_RETURN and script size limits). */
function outputOnTarget(to: Chain, script: Uint8Array): { status: Status; note: string } {
  const { label, maxDataScript, maxScript } = CHAINS[to]
  const data = isDataScript(script)
  const max = data ? maxDataScript : maxScript
  if (data && max === false) return { status: "fail", note: `OP_RETURN: ${label} allows none` }
  return typeof max === "number" && script.length > max
    ? { status: "fail", note: `${script.length}-byte ${data ? "OP_RETURN" : "script"}: ${label} allows ≤ ${max}` }
    : { status: "pass", note: `valid on ${label}` }
}

/** Is `txid:vout` (paying `script`) unspent on the target chain? Asked to its Electrum server, for anyone's coin. */
async function outpointOnTarget(dst: ChainClient, txid: string, vout: number, script: Uint8Array | null): Promise<ReplayInput["onTarget"]> {
  const exists = await dst.rawHex(txid).then(
    () => true,
    () => false,
  )
  if (!exists) return "missing"
  if (!script) return "unknown"
  try {
    const sh = bytesToHex(sha256(script).reverse())
    const unspent = await dst.client.request<{ tx_hash: string; tx_pos: number }[]>("blockchain.scripthash.listunspent", [sh])
    return unspent.some((u) => u.tx_hash === txid && u.tx_pos === vout) ? "unspent" : "spent"
  } catch {
    return "unknown" // e.g. a huge address the server won't list: the network decides on broadcast
  }
}

/**
 * Can `txid` (confirmed or pending on `from`) be rebroadcast as-is on a replay pair (Bitcoin ↔ Blake, eCash)?
 * Same bytes, same signatures: it is valid there only if every input's coin exists unspent there, the signatures
 * don't use SIGHASH_UNIFIED when the target lacks it, every output satisfies the target's consensus rules, and the
 * locktime is final there (eCash's REPLAY_LOCKTIME only on eCash). Anyone's transaction can be replayed: its coins
 * move on the target exactly as the signer sent them on the source (an incoming payment replayed pays you the forked
 * coins too).
 */
export async function analyzeReplay(walletId: string, from: Chain, txid: string, target?: Chain): Promise<ReplayAnalysis> {
  const to = target ?? replayPairs(from)[0]
  if (!to || !replayPairs(from).includes(to)) throw new Error(`${CHAINS[from].label} doesn't replay onto ${to ? CHAINS[to].label : "another chain"}`)
  const [src, dst] = await Promise.all([chainFor(from), chainFor(to)])
  const hex = await src.rawHex(txid)
  const tx = parseTxHex(hex)
  const T = CHAINS[to].label

  const ours = await db.address
    .findMany({ where: { walletId }, select: { address: true, family: true } })
    .then((rows) => new Set(rows.map((r) => bytesToHex(addressScript(r.address, r.family as Family)))))
  const existsOnTarget = (id: string) =>
    dst.rawHex(id).then(
      () => true,
      () => false,
    )

  let totalIn: number | null = 0
  const inputs: ReplayInput[] = []
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i)
    const prevId = bytesToHex(inp.txid!)
    const vout = inp.index!
    const prev = await src
      .getTx(prevId)
      .then((p) => p.getOutput(vout))
      .catch(() => null)
    const script = prev?.script ?? null
    const value = prev?.amount !== undefined ? Number(prev.amount) : null
    if (value === null) totalIn = null
    else if (totalIn !== null) totalIn += value
    const isOurs = !!script && ours.has(bytesToHex(script))
    // hashtype: a DER (ECDSA) signature's last byte, or a 65-byte Schnorr one's; 64-byte Schnorr has none (SIGHASH_DEFAULT)
    const sig = inp.finalScriptWitness?.[0]
    const sighash = !sig?.length ? null : sig[0] === 0x30 ? sig[sig.length - 1] : sig.length === 65 ? sig[64] : null
    const onTarget = await outpointOnTarget(dst, prevId, vout, script)

    let status: Status = "pass"
    let note = `unspent on ${T}${isOurs ? "" : " · someone else's coin"}`
    if (onTarget === "spent") [status, note] = ["fail", `already spent on ${T}`]
    else if (onTarget === "missing") [status, note] = ["fail", `doesn't exist on ${T} (post-fork coin)`]
    else if (!CHAINS[to].unifiedSighash && sighash !== null && sighash & SIGHASH_UNIFIED) [status, note] = ["fail", `SIGHASH_UNIFIED: ${T} rejects it`]
    else if (onTarget === "unknown") [status, note] = ["warn", `couldn't check on ${T}: the network decides`]
    inputs.push({ txid: prevId, vout, value, address: script ? (addressFor(script, from) ?? null) : null, ours: isOurs, onTarget, sighash, status, note })
  }

  let totalOut = 0
  const outputs: ReplayOutput[] = Array.from({ length: tx.outputsLength }, (_, i) => {
    const o = tx.getOutput(i)
    totalOut += Number(o.amount ?? 0n)
    const rule = outputOnTarget(to, o.script!)
    const mine = ours.has(bytesToHex(o.script!))
    return {
      address: addressFor(o.script!, from) ?? null,
      amount: Number(o.amount ?? 0n),
      data: isDataScript(o.script!),
      scriptSize: o.script!.length,
      ours: mine,
      status: rule.status,
      note: mine ? `${rule.note} · to you` : rule.note,
    }
  })

  const fee = totalIn === null ? null : totalIn - totalOut
  const vsize = tx.vsize
  const feeRate = fee === null ? null : fee / vsize
  const targetHeight = dst.height
  const targetFees = dst.fees
  const alreadyThere = await existsOnTarget(txid)

  // nLockTime only binds when some input's nSequence isn't final
  const lockTime = tx.lockTime
  const lockActive = lockTime > 0 && inputs.length > 0 && Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i).sequence ?? 0xffffffff).some((s) => s !== 0xffffffff)
  const replayLock = lockActive && lockTime === REPLAY_LOCKTIME
  const lockFinal = !lockActive || (replayLock ? !!CHAINS[to].replayLockTime : lockTime < LOCKTIME_THRESHOLD ? lockTime <= targetHeight : lockTime <= Date.now() / 1000)

  const all = (s: { status: Status }[]) => (s.every((x) => x.status === "pass") ? "pass" : "fail")
  const sigProtected = !CHAINS[to].unifiedSighash && inputs.some((i) => i.sighash !== null && i.sighash & SIGHASH_UNIFIED)
  const foreign = inputs.filter((i) => !i.ours).length
  const toYou = outputs.filter((o) => o.ours).reduce((s, o) => s + o.amount, 0)
  const blocked = inputs.filter((i) => i.onTarget === "spent" || i.onTarget === "missing").length
  const unknown = inputs.filter((i) => i.onTarget === "unknown").length
  const checks: ReplayCheck[] = [
    {
      id: "ours",
      label: "Whose coins move",
      status: foreign ? "warn" : "pass",
      detail: !foreign
        ? "Every input spends one of your coins."
        : `${foreign} of ${inputs.length} inputs are someone else's: replaying moves their ${T} coins to the same recipients as on ${CHAINS[from].label}${toYou ? `, ${toYou.toLocaleString()} sats of them to you` : ""}.`,
    },
    {
      id: "coins",
      label: `Coins exist unspent on ${T}`,
      status: blocked ? "fail" : unknown ? "warn" : "pass",
      detail: blocked
        ? `${blocked} of ${inputs.length} inputs are spent or missing on ${T}.`
        : unknown
          ? `${unknown} of ${inputs.length} inputs couldn't be checked on ${T}; the rest are unspent there.`
          : `These are pre-fork coins still unspent on ${T}.`,
    },
    {
      id: "signatures",
      label: "Signatures are valid there",
      status: sigProtected ? "fail" : "pass",
      detail: sigProtected
        ? `Signed with SIGHASH_UNIFIED (0x21): replay-protected, ${T} computes a different message and rejects it.`
        : CHAINS[to].unifiedSighash
          ? `Ordinary signatures (no SIGHASH_UNIFIED) are valid on ${T}.`
          : `Legacy-signed (no SIGHASH_UNIFIED), so ${T} accepts the signatures.`,
    },
    {
      id: "outputs",
      label: `Outputs follow ${T} consensus`,
      status: all(outputs),
      detail:
        all(outputs) === "pass"
          ? CHAINS[to].maxScript
            ? `Every output fits ${T}'s size limits (OP_RETURN ≤ ${CHAINS[to].maxDataScript} bytes, scripts ≤ ${CHAINS[to].maxScript} bytes).`
            : `${T} accepts every output.`
          : outputs.find((o) => o.status === "fail")!.note,
    },
    {
      id: "locktime",
      label: "Locktime is final",
      status: lockFinal ? "pass" : "fail",
      detail: !lockActive
        ? "No locktime."
        : replayLock
          ? lockFinal
            ? `nLockTime ${REPLAY_LOCKTIME.toLocaleString()} is final on ${T}.`
            : `nLockTime ${REPLAY_LOCKTIME.toLocaleString()} is eCash's replay protection: ${T} reads it as a block ~500M blocks away and never accepts it.`
          : lockFinal
          ? `nLockTime ${lockTime.toLocaleString()} is already final on ${T} (tip ${targetHeight.toLocaleString()}).`
          : `nLockTime ${lockTime.toLocaleString()} is in the future on ${T} (tip ${targetHeight.toLocaleString()}): it can't confirm yet.`,
    },
    {
      id: "fresh",
      label: `Not already on ${T}`,
      status: alreadyThere ? "fail" : "pass",
      detail: alreadyThere ? `This exact transaction is already on ${T}.` : `${T} hasn't seen this transaction.`,
    },
    {
      id: "fee",
      label: "Fee is enough there",
      status:
        feeRate === null || !targetFees ? "warn" : feeRate < targetFees.minimumFee ? "fail" : feeRate < targetFees.hourFee ? "warn" : "pass",
      detail:
        feeRate === null
          ? "Fee unknown."
          : !targetFees
            ? `${feeRate.toFixed(1)} sat/vB; no ${T} estimate available.`
            : `${feeRate.toFixed(1)} sat/vB vs ${T} estimates: 1 h ${targetFees.hourFee}, minimum ${targetFees.minimumFee} sat/vB. The fee can't change: it's the same signed bytes.`,
    },
  ]

  return {
    from,
    to,
    txid,
    hex,
    fee,
    vsize,
    feeRate,
    targetHeight,
    targetFees,
    inputs,
    outputs,
    checks,
    replayable: checks.every((c) => c.status !== "fail"),
  }
}
