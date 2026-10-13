import "server-only"
import { secp256k1 } from "@noble/curves/secp256k1.js"
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js"
import { SigHash, Transaction, bip32Path, p2pkh, p2wpkh } from "@scure/btc-signer"
import { PlanError, depositOf, drivechainScript, hasReplayLockTime, outputRuleError, vsizeOf, type Ctip } from "@/lib/tx"
import { SIGHASH_ALL_UNIFIED, unifiedSighash } from "@/lib/unified-sighash"
import { CHAINS, REPLAY_LOCKTIME, type Chain } from "@/lib/chains"

export class SignError extends Error {}

const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])
const MAX_FEE_RATE = 1000 // sat/vB: anything above is almost certainly a mistake

export type SignContext = {
  fingerprint: number
  accountPath: string
  keyFor: (change: number, index: number) => { privateKey: Uint8Array; publicKey: Uint8Array }
  /** the real spent output on `chain` (from the chain, never from the PSBT) */
  prevOut: (txid: string, vout: number) => Promise<{ script?: Uint8Array; amount?: bigint }>
  frozen: Set<string>
  /** BIP300 sidechain `slot` from the enforcer: null when it isn't active, `ctip` null before its first deposit */
  sidechain?: (slot: number) => Promise<{ ctip: Ctip | null } | null>
}

/**
 * Signs a PSBT built by lib/tx.ts. Every input must be this wallet's P2WPKH coin on `chain`
 * (checked against the real parent tx, not the PSBT's claims) and not frozen.
 * BIP143 SIGHASH_ALL, or SIGHASH_UNIFIED (0x21) on chains that use it (Blake): chains without it reject those
 * signatures (replay protection). eCash transactions must carry its replay-protection nLockTime.
 * A BIP300 deposit (M5) may also spend its sidechain's current treasury, unsigned: the slot must be active (an inactive
 * slot's OP_DRIVECHAIN output is anyone-can-spend), and the new treasury must hold the old one plus the deposit.
 */
export async function signWith(chain: Chain, psbt: Uint8Array, ctx: SignContext) {
  let tx: Transaction
  try {
    tx = Transaction.fromPSBT(psbt, { allowUnknownOutputs: true, allowUnknownInputs: true })
  } catch {
    throw new SignError("Invalid PSBT")
  }
  if (!tx.inputsLength || !tx.outputsLength) throw new SignError("PSBT has no inputs or outputs")
  if (CHAINS[chain].replayLockTime && !hasReplayLockTime(tx))
    throw new SignError(`${CHAINS[chain].label} transactions must use nLockTime ${REPLAY_LOCKTIME} with RBF/non-final inputs (replay protection)`)

  let outSum = 0n
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i)
    if (!out.script || out.amount === undefined) throw new SignError("Malformed output")
    const err = outputRuleError(chain, out.script)
    if (err) throw new SignError(err)
    outSum += out.amount
  }

  let deposit: ReturnType<typeof depositOf>
  try {
    deposit = depositOf(chain, tx)
  } catch (e) {
    throw new SignError((e as PlanError).message)
  }
  let ctip: Ctip | null = null
  if (deposit) {
    if (!ctx.sidechain) throw new SignError(`${CHAINS[chain].label} deposits need a BIP300 enforcer`)
    const sidechain = await ctx.sidechain(deposit.slot)
    if (!sidechain) throw new SignError(`Sidechain slot ${deposit.slot} isn't active on ${CHAINS[chain].label}: the deposit would be lost`)
    ctip = sidechain.ctip
  }
  let treasury: bigint | null = null

  const { fingerprint, frozen } = ctx
  const prefix = bip32Path(ctx.accountPath)

  const keys: { i: number; privateKey: Uint8Array; publicKey: Uint8Array }[] = []
  const spent: { amount: bigint; script: Uint8Array }[] = []
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i)
    if (!input.txid || input.index === undefined) throw new SignError("Malformed input")
    const txid = bytesToHex(input.txid)
    if (deposit && ctip && txid === ctip.txid && input.index === ctip.vout) {
      // the sidechain's treasury: nobody signs it, its value and script come from the chain
      const prev = await ctx.prevOut(txid, input.index).catch(() => ({}) as { script?: Uint8Array; amount?: bigint })
      if (!prev.script || !equalBytes(prev.script, drivechainScript(chain, deposit.slot)) || prev.amount !== BigInt(ctip.value))
        throw new SignError(`Sidechain ${deposit.slot}'s treasury doesn't match ${CHAINS[chain].label}`)
      if (input.finalScriptSig?.length || input.finalScriptWitness?.length) throw new SignError("The sidechain treasury is spent with an empty scriptSig")
      if (!input.nonWitnessUtxo) throw new SignError("The sidechain treasury input needs its parent transaction")
      treasury = prev.amount
      continue
    }
    if (frozen.has(`${txid}:${input.index}`)) throw new SignError(`Coin ${txid.slice(0, 8)}…:${input.index} is frozen`)
    const derivation = input.bip32Derivation?.find(([, d]) => d.fingerprint === fingerprint)?.[1].path
    const ok =
      derivation?.length === prefix.length + 2 &&
      prefix.every((x, j) => derivation[j] === x) &&
      derivation[prefix.length] <= 1 &&
      derivation[prefix.length + 1] < 0x80000000
    if (!ok) throw new SignError("Input is not from this wallet")
    const key = ctx.keyFor(derivation[prefix.length], derivation[prefix.length + 1])
    const script = p2wpkh(key.publicKey).script
    let prev
    try {
      prev = await ctx.prevOut(txid, input.index)
    } catch {
      throw new SignError(`Unknown parent transaction ${txid.slice(0, 8)}… on ${CHAINS[chain].label}`)
    }
    if (!prev.script || prev.amount === undefined || !equalBytes(prev.script, script)) throw new SignError("Input does not belong to this wallet")
    if (!input.witnessUtxo || input.witnessUtxo.amount !== prev.amount || !equalBytes(input.witnessUtxo.script, script))
      throw new SignError("Input amount or script does not match the chain")
    keys.push({ i, ...key })
    spent.push({ amount: prev.amount, script })
  }
  if (deposit) {
    if (ctip && treasury === null) throw new SignError(`A deposit must spend sidechain ${deposit.slot}'s current treasury (${ctip.txid.slice(0, 8)}…:${ctip.vout})`)
    if (deposit.value <= (treasury ?? 0n)) throw new SignError("A deposit must add to the sidechain's treasury")
  }

  const fee = spent.reduce((s, o) => s + o.amount, treasury ?? 0n) - outSum
  if (fee <= 0n) throw new SignError("Outputs exceed inputs")

  if (!CHAINS[chain].unifiedSighash) {
    for (const { i, privateKey } of keys) {
      const declared = tx.getInput(i).sighashType
      if (declared !== undefined && declared !== SigHash.ALL) throw new SignError(`${CHAINS[chain].label} inputs must use SIGHASH_ALL`)
      tx.signIdx(privateKey, i, [SigHash.ALL])
      tx.finalizeIdx(i) // ours only: the treasury stays as it is
    }
  } else {
    const unsigned = {
      version: tx.version,
      lockTime: tx.lockTime,
      inputs: Array.from({ length: tx.inputsLength }, (_, i) => {
        const inp = tx.getInput(i)
        return { txid: inp.txid!, index: inp.index!, sequence: inp.sequence ?? 0xffffffff }
      }),
      outputs: Array.from({ length: tx.outputsLength }, (_, i) => ({ amount: tx.getOutput(i).amount!, script: tx.getOutput(i).script! })),
    }
    for (const { i, privateKey, publicKey } of keys) {
      const hash = unifiedSighash(unsigned, i, spent, SIGHASH_ALL_UNIFIED, 1, p2pkh(publicKey).script)
      const der = secp256k1.sign(hash, privateKey, { prehash: false, lowS: true, format: "der" })
      if (!secp256k1.verify(der, hash, publicKey, { prehash: false, format: "der" })) throw new SignError("Signature self-check failed")
      tx.updateInput(i, { finalScriptWitness: [concatBytes(der, Uint8Array.of(SIGHASH_ALL_UNIFIED)), publicKey] }, true)
    }
  }

  const vsize = vsizeOf(tx)
  if (Number(fee) / vsize > MAX_FEE_RATE) throw new SignError(`Fee rate above ${MAX_FEE_RATE} sat/vB refused`)
  return { hex: tx.hex, txid: tx.id, fee: Number(fee), vsize }
}
