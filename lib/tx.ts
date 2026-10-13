// Transaction planning + PSBT building, shared by the browser (builds) and the server (re-validates).
// All inputs are this wallet's P2WPKH coins, plus a sidechain's treasury on a BIP300 deposit.
// Chain differences come from lib/chains.ts (rules, sighash, addresses).
import { HDKey } from "@scure/bip32"
import { Address, OutScript, Script, SigHash, Transaction, bip32Path, p2pkh, p2wpkh } from "@scure/btc-signer"
import { secp256k1 } from "@noble/curves/secp256k1.js"
import { base64 } from "@scure/base"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { SIGHASH_ALL_UNIFIED, SIGHASH_UNIFIED, unifiedSighash } from "@/lib/unified-sighash"
import { CHAINS, REPLAY_LOCKTIME, dataCapPair, familyOf, minDataScript, networkOf, type Chain } from "@/lib/chains"

export type Coin = { txid: string; vout: number; value: number; address: string; change: 0 | 1; index: number; height: number }
/** An address, or a raw output script (module transactions). */
export type Recipient = { address?: string; script?: Uint8Array; amount: number }
export type PlannedOutput = { script: Uint8Array; amount: number; address?: string; kind: "recipient" | "change" | "data" }
/** A sidechain's treasury UTXO (BIP300 CTIP): anyone-can-spend, holding everything deposited to it. */
export type Ctip = { txid: string; vout: number; value: number }
/** A BIP300 M5 deposit: the recipient output is the new treasury (old treasury + amount), then the address OP_RETURN. */
export type Deposit = { slot: number; address: string; ctip: Ctip | null }
export type TxPlan = { inputs: Coin[]; outputs: PlannedOutput[]; fee: number; vsize: number; deposit?: Deposit }
/** Fee policy: total fee (sats) for a given vsize. */
export type FeePolicy = (vsize: number) => number

export const RBF_SEQUENCE = 0xfffffffd
export const OP_RETURN_MAX_DATA = 4000
/** Inputs cost this many vbytes (P2WPKH, 72-byte signature worst case). */
export const INPUT_VSIZE = 68

export class PlanError extends Error {}

/** Parse a raw tx (either chain: same serialization). */
export const parseTxHex = (hex: string) =>
  Transaction.fromRaw(hexToBytes(hex), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true })

export const feeAt =
  (rate: number): FeePolicy =>
  (v) =>
    Math.ceil(rate * v)
/** BIP125: pay at least `rate` and more than the replaced tx's fee plus its own relay cost (1 sat/vB). */
export const rbfFee =
  (rate: number, replacedFee: number): FeePolicy =>
  (v) =>
    Math.max(Math.ceil(rate * v), replacedFee + v)
/** CPFP: the child pays so (parentFee + childFee) / (parentVsize + childVsize) reaches `rate`. */
export const cpfpFee =
  (rate: number, parentFee: number, parentVsize: number): FeePolicy =>
  (v) =>
    Math.max(Math.ceil(rate * (parentVsize + v) - parentFee), v)

const varintLen = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5)

/**
 * vsize for `inputs` P2WPKH inputs and the given output scripts (signatures sized worst case), plus `bare` inputs
 * spent with an empty scriptSig and no witness (a BIP300 treasury: 41 bytes and its empty witness count).
 */
export function estimateVsize(inputs: number, scripts: Uint8Array[], bare = 0) {
  const outputs = scripts.reduce((s, sc) => s + 8 + varintLen(sc.length) + sc.length, 0)
  const base = 4 + varintLen(inputs + bare) + 41 * (inputs + bare) + varintLen(scripts.length) + outputs + 4
  return Math.ceil((base * 4 + 2 + 108 * inputs + bare) / 4)
}

/** vsize from the serialization: scure's tx.vsize refuses inputs it can't finalize, like a treasury's empty scriptSig. */
export const vsizeOf = (tx: Transaction) => Math.ceil((tx.toBytes(true, false).length * 3 + tx.toBytes(true, true).length) / 4)

/** Core's dust threshold at the default 3 sat/vB dust relay fee. */
export function dustLimit(script: Uint8Array) {
  const witness = script.length >= 4 && script.length <= 42 && (script[0] === 0 || (script[0] >= 0x51 && script[0] <= 0x60)) && script[1] === script.length - 2
  return 3 * (8 + 1 + script.length + (witness ? 67 : 148))
}

export const isDataScript = (script: Uint8Array) => script[0] === 0x6a

/**
 * OP_RETURN script for a message on `chain`. With a replay pair that caps OP_RETURNs (Blake: ≤ 83 bytes), it is
 * zero-padded past that cap (Bitcoin: ≥ 84) so the transaction is invalid on the pair: it can't be replayed there.
 */
export function opReturnScript(message: Uint8Array, chain: Chain) {
  if (message.length > OP_RETURN_MAX_DATA) throw new PlanError(`OP_RETURN message is limited to ${OP_RETURN_MAX_DATA} bytes`)
  const min = minDataScript(chain)
  const data = new Uint8Array(Math.max(message.length, min - 3)) // 1 (OP_RETURN) + 2 (PUSHDATA1 n) + data
  data.set(message)
  const script = Script.encode(["RETURN", data])
  if (script.length < min) throw new PlanError("OP_RETURN script too small")
  return script
}

/** Per-chain consensus/safety rules for an output script. Returns an error message, or null when allowed. */
export function outputRuleError(chain: Chain, script: Uint8Array): string | null {
  const { label, maxDataScript, maxScript, noDataOutputs } = CHAINS[chain]
  if (isDataScript(script)) {
    if (maxDataScript === false || noDataOutputs) return `OP_RETURN outputs are not allowed on ${label}`
    if (typeof maxDataScript === "number" && script.length > maxDataScript) return `${label} rejects OP_RETURN scripts over ${maxDataScript} bytes`
    const min = minDataScript(chain)
    if (script.length < min) return `${label} OP_RETURN must be ≥ ${min} bytes so it can't be replayed on ${CHAINS[dataCapPair(chain) ?? chain].label}`
    return null
  }
  if (maxScript && script.length > maxScript) return `${label} rejects output scripts over ${maxScript} bytes`
  return null
}

/** BIP300 treasury script for sidechain `slot`: OP_DRIVECHAIN OP_PUSHBYTES_1 <slot> OP_TRUE. */
export function drivechainScript(chain: Chain, slot: number) {
  const dc = CHAINS[chain].drivechain
  if (!dc) throw new PlanError(`${CHAINS[chain].label} has no sidechains`)
  return Uint8Array.of(dc.opcode, 0x01, slot, 0x51)
}

/** The sidechain slot a treasury script locks to, or null for any other script. */
export function drivechainSlot(chain: Chain, script: Uint8Array) {
  const op = CHAINS[chain].drivechain?.opcode
  return op !== undefined && script.length === 4 && script[0] === op && script[1] === 0x01 && script[3] === 0x51 ? script[2] : null
}

/**
 * A sidechain deposit address, `s<slot>_<address>_<checksum>` (thunder, bitnames, bitassets, photon…): the checksum is
 * the first 3 bytes of sha256("s<slot>_<address>_") in hex. The sidechain reads `<address>` from the M5 OP_RETURN and
 * credits nobody when it's malformed, so only checksummed addresses are accepted.
 */
export function parseDepositAddress(text: string): { slot: number; address: string } {
  const m = /^s(\d{1,3})_(.+)_([0-9a-f]{6})$/i.exec(text.trim())
  if (!m || Number(m[1]) > 255) throw new PlanError("Enter a sidechain deposit address (s<slot>_<address>_<checksum>)")
  if (bytesToHex(sha256(utf8ToBytes(`s${m[1]}_${m[2]}_`)).slice(0, 3)) !== m[3].toLowerCase()) throw new PlanError("Deposit address checksum doesn't match: check it for typos")
  return { slot: Number(m[1]), address: m[2] }
}

/** BIP300 M5 output pair: the address OP_RETURN that must directly follow the new treasury output. */
export const depositDataScript = (address: string) => Script.encode(["RETURN", utf8ToBytes(address)])

/**
 * The M5 deposit in `tx`, or null: its single treasury output must be directly followed by a zero-value OP_RETURN
 * pushing the sidechain address (the enforcer ignores a deposit without it, and the coins are lost).
 */
export function depositOf(chain: Chain, tx: Transaction) {
  const outs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i))
  const at = outs.flatMap((o, i) => (o.script && drivechainSlot(chain, o.script) !== null ? [i] : []))
  if (!at.length) return null
  if (at.length > 1) throw new PlanError("Only one sidechain deposit per transaction")
  const [vout] = at
  const next = outs[vout + 1]
  const push = next?.script && isDataScript(next.script) ? Script.decode(next.script) : []
  if (next?.amount !== 0n || push.length !== 2 || !(push[1] instanceof Uint8Array) || !push[1].length)
    throw new PlanError("A sidechain deposit must be followed by an OP_RETURN with the sidechain address")
  return { slot: drivechainSlot(chain, outs[vout].script!)!, vout, value: outs[vout].amount!, address: push[1] as Uint8Array }
}

/** What a plan pays out: recipients, minus the old treasury a deposit just carries over. */
export const sentBy = (plan: TxPlan) => plan.outputs.filter((o) => o.kind === "recipient").reduce((s, o) => s + o.amount, 0) - (plan.deposit?.ctip?.value ?? 0)

export function scriptFor(address: string, chain: Chain) {
  try {
    return OutScript.encode(Address(networkOf(familyOf(chain))).decode(address.trim()))
  } catch {
    throw new PlanError(`Invalid ${CHAINS[chain].label} address: ${address || "(empty)"}`)
  }
}

export const addressFor = (script: Uint8Array, chain: Chain) => {
  try {
    return Address(networkOf(familyOf(chain))).encode(OutScript.decode(script))
  } catch {
    return undefined
  }
}

const sum = (coins: Coin[]) => coins.reduce((s, c) => s + c.value, 0)

/**
 * Coin selection + fee + change. Strategy (Core-like, simplified):
 * 1. `required` coins only (manual selection, RBF originals, CPFP parent output), topped up from candidates if short;
 * 2. else the single coin that fits best (changeless when the excess is below the cost of a change output);
 * 3. else largest-first accumulation.
 * `sendMax` sweeps everything selected (required, or all candidates) to the single recipient.
 * `guard`: replay guard for a pair with no marker to carry (eCash): spend one of `coins` (coins the pair lacks), adding
 * the smallest when the plan has none, so the pair rejects the whole transaction.
 * `deposit`: BIP300 M5 to the single recipient, a sidechain deposit address; `ctip` is that sidechain's current treasury
 * (null before its first deposit), spent here and carried over into the new one.
 */
export function planTx(o: {
  chain: Chain
  recipients: Recipient[]
  sendMax?: boolean
  required?: Coin[]
  candidates?: Coin[]
  fee: FeePolicy
  changeAddress: string
  data?: Uint8Array
  guard?: { coins: Coin[]; pair: Chain }
  deposit?: { ctip: Ctip | null }
}): TxPlan {
  if (!o.recipients.length && !o.data) throw new PlanError("Add a recipient")
  if (o.data && (CHAINS[o.chain].maxDataScript === false || CHAINS[o.chain].noDataOutputs))
    throw new PlanError(`OP_RETURN outputs are not allowed on ${CHAINS[o.chain].label}`)
  const dest = o.deposit ? parseDepositAddress(o.recipients[0]?.address ?? "") : null
  if (dest && (o.recipients.length !== 1 || o.data)) throw new PlanError("A deposit goes to a single sidechain address")
  const deposit: Deposit | undefined = dest ? { ...dest, ctip: o.deposit!.ctip } : undefined
  const recipients = o.recipients.map((r) => {
    const script = dest ? drivechainScript(o.chain, dest.slot) : (r.script ?? scriptFor(r.address ?? "", o.chain))
    return { ...r, script, address: r.address ?? addressFor(script, o.chain) }
  })
  const dataScript = dest ? depositDataScript(dest.address) : o.data ? opReturnScript(o.data, o.chain) : null
  const vsizeFor = (inputs: number, scripts: Uint8Array[]) => estimateVsize(inputs, scripts, deposit?.ctip ? 1 : 0)
  for (const s of [...recipients.map((r) => r.script), ...(dataScript ? [dataScript] : [])]) {
    const err = outputRuleError(o.chain, s)
    if (err) throw new PlanError(err)
  }
  const changeScript = scriptFor(o.changeAddress, o.chain)
  const fixed = [...recipients.map((r) => r.script), ...(dataScript ? [dataScript] : [])]
  const required = o.required ?? []
  const key = (c: Coin) => `${c.txid}:${c.vout}`
  const requiredKeys = new Set(required.map(key))
  const pool = (o.candidates ?? []).filter((c) => !requiredKeys.has(key(c))).sort((a, b) => b.value - a.value)

  const outputs = (amounts: number[], change: number): PlannedOutput[] => [
    ...recipients.map((r, i) => ({ script: r.script, amount: amounts[i], address: r.address, kind: "recipient" as const })),
    ...(dataScript ? [{ script: dataScript, amount: 0, kind: "data" as const }] : []),
    ...(change > 0 ? [{ script: changeScript, amount: change, address: o.changeAddress, kind: "change" as const }] : []),
  ]
  const checkDust = (list: PlannedOutput[]) => {
    for (const out of list)
      if (out.kind !== "data" && out.amount < dustLimit(out.script)) throw new PlanError(`Amount below the dust limit (${dustLimit(out.script)} sats)`)
  }

  // deposit: the treasury input carries its value into the new treasury output (amounts above are just the deposit)
  const finish = (plan: TxPlan): TxPlan => {
    const ctip = deposit?.ctip
    if (!deposit) return guard(plan)
    const outputs = ctip ? plan.outputs.map((out) => (out.kind === "recipient" ? { ...out, amount: out.amount + ctip.value } : out)) : plan.outputs
    return guard({ ...plan, outputs, deposit })
  }

  // replay guard: no guarded coin in the plan → add the smallest one and plan again
  const guard = (plan: TxPlan): TxPlan => {
    if (!o.guard) return plan
    const guarded = new Set(o.guard.coins.map(key))
    if (plan.inputs.some((c) => guarded.has(key(c)))) return plan
    const extra = o.guard.coins.filter((c) => !requiredKeys.has(key(c))).sort((a, b) => a.value - b.value)[0]
    if (!extra) throw new PlanError(`Every spendable coin also exists on ${CHAINS[o.guard.pair].label}: split them there first, or turn off its replay protection`)
    return planTx({ ...o, guard: undefined, required: [...(o.sendMax && !required.length ? pool : required), extra] })
  }

  if (o.sendMax) {
    if (recipients.length !== 1) throw new PlanError("Send max works with a single recipient")
    const inputs = required.length ? required : pool
    if (!inputs.length) throw new PlanError("No spendable coins")
    const vsize = vsizeFor(inputs.length, fixed)
    const fee = o.fee(vsize)
    const plan = { inputs, outputs: outputs([sum(inputs) - fee], 0), fee, vsize }
    checkDust(plan.outputs)
    return finish(plan)
  }

  const target = recipients.reduce((s, r) => {
    if (!Number.isSafeInteger(r.amount) || r.amount <= 0) throw new PlanError("Enter an amount for every recipient")
    return s + r.amount
  }, 0)
  checkDust(outputs(recipients.map((r) => r.amount), 0))
  const changeCost = (v: number) => o.fee(v + 8 + 1 + changeScript.length) - o.fee(v) + o.fee(INPUT_VSIZE)

  const tryCoins = (inputs: Coin[]): (TxPlan & { excess: number }) | null => {
    const total = sum(inputs)
    const vNo = vsizeFor(inputs.length, fixed)
    const feeNo = o.fee(vNo)
    if (total < target + feeNo) return null
    const vCh = vsizeFor(inputs.length, [...fixed, changeScript])
    const feeCh = o.fee(vCh)
    const change = total - target - feeCh
    if (change >= dustLimit(changeScript) && total - target - feeNo > changeCost(vNo)) {
      return { inputs, outputs: outputs(recipients.map((r) => r.amount), change), fee: feeCh, vsize: vCh, excess: 0 }
    }
    // changeless: the remainder goes to fees
    return { inputs, outputs: outputs(recipients.map((r) => r.amount), 0), fee: total - target, vsize: vNo, excess: total - target - feeNo }
  }

  let plan: ReturnType<typeof tryCoins> = null
  if (required.length) {
    const inputs = [...required]
    plan = tryCoins(inputs)
    for (const c of pool) {
      if (plan) break
      inputs.push(c)
      plan = tryCoins(inputs)
    }
  } else {
    const singles = pool.map((c) => tryCoins([c])).filter((p) => p !== null)
    const changeless = singles.filter((p) => !p.outputs.some((x) => x.kind === "change")).sort((a, b) => a.excess - b.excess)[0]
    plan = changeless ?? singles.sort((a, b) => sum(a.inputs) - sum(b.inputs))[0] ?? null
    const inputs: Coin[] = []
    for (const c of pool) {
      if (plan) break
      inputs.push(c)
      plan = tryCoins([...inputs])
    }
  }
  if (!plan) throw new PlanError("Insufficient funds for amount + fee")
  const { excess: _excess, ...result } = plan
  void _excess
  return finish(result)
}

function shuffle<T>(list: T[]) {
  const a = [...list]
  const r = new Uint32Array(a.length)
  crypto.getRandomValues(r)
  for (let i = a.length - 1; i > 0; i--) {
    const j = r[i] % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** eCash replay protection: nLockTime REPLAY_LOCKTIME, binding (some nSequence isn't final), so Bitcoin never accepts it. */
export const hasReplayLockTime = (tx: Transaction) =>
  tx.lockTime === REPLAY_LOCKTIME && Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i).sequence ?? 0xffffffff).some((s) => s !== 0xffffffff)

/**
 * Unsigned PSBT for a plan. Inputs declare SIGHASH_ALL, or ALL|UNIFIED (0x21) on SIGHASH_UNIFIED chains (Blake).
 * nLockTime = tip (anti-fee-sniping), or REPLAY_LOCKTIME on eCash; nSequence signals RBF, output order is randomized.
 * A deposit spends the sidechain's treasury first (its parent from `parents`, empty scriptSig: nobody signs it) and
 * keeps the M5 order: new treasury, address OP_RETURN, change.
 */
export function buildPsbt(
  plan: TxPlan,
  ctx: { chain: Chain; xpub: string; fingerprint: number; accountPath: string; tipHeight: number; parents?: Record<string, string> },
) {
  const account = HDKey.fromExtendedKey(ctx.xpub)
  const sighashType = CHAINS[ctx.chain].unifiedSighash ? SIGHASH_ALL_UNIFIED : SigHash.ALL
  const tx = new Transaction({ version: 2, lockTime: CHAINS[ctx.chain].replayLockTime ? REPLAY_LOCKTIME : ctx.tipHeight, allowUnknownOutputs: true, allowUnknownInputs: true })
  const ctip = plan.deposit?.ctip
  if (ctip) {
    const parent = ctx.parents?.[ctip.txid]
    if (!parent) throw new PlanError("Couldn't load the sidechain treasury's transaction")
    tx.addInput({ txid: ctip.txid, index: ctip.vout, sequence: RBF_SEQUENCE, nonWitnessUtxo: hexToBytes(parent) })
  }
  for (const coin of plan.inputs) {
    const publicKey = account.deriveChild(coin.change).deriveChild(coin.index).publicKey!
    const parent = ctx.parents?.[coin.txid]
    tx.addInput({
      txid: coin.txid,
      index: coin.vout,
      sequence: RBF_SEQUENCE,
      witnessUtxo: { script: p2wpkh(publicKey).script, amount: BigInt(coin.value) },
      ...(parent ? { nonWitnessUtxo: hexToBytes(parent) } : {}),
      bip32Derivation: [[publicKey, { fingerprint: ctx.fingerprint, path: bip32Path(`${ctx.accountPath}/${coin.change}/${coin.index}`) }]],
      sighashType,
    })
  }
  for (const out of plan.deposit ? plan.outputs : shuffle(plan.outputs)) tx.addOutput({ script: out.script, amount: BigInt(out.amount) })
  return tx
}

const PSBT_MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff] // "psbt\xff"
const isPsbt = (b: Uint8Array) => PSBT_MAGIC.every((x, i) => b[i] === x)

/** Whatever a signer hands back: PSBT bytes, base64 PSBT, or a raw tx in hex. */
function decodeSigned(input: Uint8Array | string): Transaction {
  const opts = { allowUnknownOutputs: true, allowUnknownInputs: true }
  if (typeof input !== "string") return isPsbt(input) ? Transaction.fromPSBT(input, opts) : Transaction.fromRaw(input, { ...opts, disableScriptCheck: true })
  const text = input.trim()
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
    const bytes = hexToBytes(text)
    return isPsbt(bytes) ? Transaction.fromPSBT(bytes, opts) : Transaction.fromRaw(bytes, { ...opts, disableScriptCheck: true })
  }
  try {
    return Transaction.fromPSBT(base64.decode(text), opts)
  } catch {
    throw new PlanError("Not a PSBT (base64 / binary) or a raw transaction (hex)")
  }
}

/**
 * Bring back a transaction signed elsewhere (hardware wallet, Sparrow, Knots…).
 * Finalizes P2WPKH inputs from partial signatures, then checks it is exactly the transaction we built
 * (same txid: same inputs, outputs, version, locktime) and that every signature is valid for this chain:
 * BIP143 SIGHASH_ALL, or SIGHASH_UNIFIED (0x21, required) on chains that use it (Blake). A deposit's treasury input
 * stays unsigned (empty scriptSig and witness).
 */
export function importSigned(chain: Chain, unsignedPsbt: Uint8Array, input: Uint8Array | string) {
  const expected = Transaction.fromPSBT(unsignedPsbt, { allowUnknownOutputs: true, allowUnknownInputs: true })
  let tx: Transaction
  try {
    tx = decodeSigned(input)
  } catch (e) {
    throw e instanceof PlanError ? e : new PlanError("Couldn't read the signed transaction")
  }
  if (tx.id !== expected.id) throw new PlanError("This is a different transaction than the one you reviewed")

  const spent = Array.from({ length: expected.inputsLength }, (_, i) => expected.getInput(i).witnessUtxo!)
  const unsigned = {
    version: expected.version,
    lockTime: expected.lockTime,
    inputs: Array.from({ length: expected.inputsLength }, (_, i) => {
      const inp = expected.getInput(i)
      return { txid: inp.txid!, index: inp.index!, sequence: inp.sequence ?? 0xffffffff }
    }),
    outputs: Array.from({ length: expected.outputsLength }, (_, i) => expected.getOutput(i) as { amount: bigint; script: Uint8Array }),
  }

  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i)
    const treasury = expected.getInput(i).nonWitnessUtxo?.outputs[expected.getInput(i).index!]
    if (!spent[i] && treasury && drivechainSlot(chain, treasury.script) !== null) {
      if (inp.finalScriptWitness?.length) throw new PlanError(`Input ${i + 1} is the sidechain treasury: it takes no witness`)
      continue // its empty scriptSig is part of the txid checked above
    }
    let witness = inp.finalScriptWitness
    if (!witness?.length && inp.partialSig?.length) {
      const [pub, sig] = inp.partialSig[0]
      witness = [sig, pub]
      tx.updateInput(i, { finalScriptWitness: witness }, true)
    }
    if (!witness || witness.length !== 2) throw new PlanError(`Input ${i + 1} isn't signed`)
    const [sig, pub] = witness
    if (!spent[i] || !p2wpkh(pub).script.every((b, j) => b === spent[i].script[j])) throw new PlanError(`Input ${i + 1} is signed by the wrong key`)
    const hashType = sig[sig.length - 1]
    let msg: Uint8Array
    const { label } = CHAINS[chain]
    if (CHAINS[chain].unifiedSighash) {
      if (hashType !== SIGHASH_ALL_UNIFIED) throw new PlanError(`${label} signatures must use SIGHASH_UNIFIED (0x21): this signer doesn't support ${label}`)
      msg = unifiedSighash(unsigned, i, spent, SIGHASH_ALL_UNIFIED, 1, p2pkh(pub).script)
    } else {
      if (hashType & SIGHASH_UNIFIED) throw new PlanError(`This is a SIGHASH_UNIFIED signature: ${label} rejects it`)
      if (hashType !== SigHash.ALL) throw new PlanError(`Input ${i + 1} uses an unexpected sighash (0x${hashType.toString(16)})`)
      msg = expected.preimageWitnessV0(i, p2pkh(pub).script, hashType, spent[i].amount)
    }
    if (!secp256k1.verify(sig.slice(0, -1), msg, pub, { prehash: false, format: "der" })) throw new PlanError(`Input ${i + 1} has an invalid signature`)
  }
  return { hex: tx.hex, txid: tx.id, vsize: vsizeOf(tx) }
}
