import "server-only"
import { secp256k1 } from "@noble/curves/secp256k1.js"
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js"
import { SigHash, Transaction, bip32Path, p2pkh, p2wpkh } from "@scure/btc-signer"
import { outputRuleError } from "@/lib/tx"
import { SIGHASH_ALL_UNIFIED, unifiedSighash } from "@/lib/unified-sighash"
import { CHAINS, type Chain } from "@/lib/chains"

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
  /** Optional execution fence, checked after asynchronous validation and before generating any signature. */
  beforeSign?: () => Promise<void>
}

/**
 * Signs a PSBT built by lib/tx.ts. Every input must be this wallet's P2WPKH coin on `chain`
 * (checked against the real parent tx, not the PSBT's claims) and not frozen.
 * BIP143 SIGHASH_ALL, or SIGHASH_UNIFIED (0x21) on chains that use it (Blake): chains without it reject those
 * signatures (replay protection).
 */
export async function signWith(chain: Chain, psbt: Uint8Array, ctx: SignContext) {
  let tx: Transaction
  try {
    tx = Transaction.fromPSBT(psbt, { allowUnknownOutputs: true, allowUnknownInputs: true })
  } catch {
    throw new SignError("Invalid PSBT")
  }
  if (!tx.inputsLength || !tx.outputsLength) throw new SignError("PSBT has no inputs or outputs")

  let outSum = 0n
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i)
    if (!out.script || out.amount === undefined) throw new SignError("Malformed output")
    const err = outputRuleError(chain, out.script)
    if (err) throw new SignError(err)
    outSum += out.amount
  }

  const { fingerprint, frozen } = ctx
  const prefix = bip32Path(ctx.accountPath)

  const keys: { privateKey: Uint8Array; publicKey: Uint8Array }[] = []
  const spent: { amount: bigint; script: Uint8Array }[] = []
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i)
    if (!input.txid || input.index === undefined) throw new SignError("Malformed input")
    const txid = bytesToHex(input.txid)
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
    keys.push(key)
    spent.push({ amount: prev.amount, script })
  }

  const fee = spent.reduce((s, o) => s + o.amount, 0n) - outSum
  if (fee <= 0n) throw new SignError("Outputs exceed inputs")
  await ctx.beforeSign?.()

  if (!CHAINS[chain].unifiedSighash) {
    for (let i = 0; i < keys.length; i++) {
      const declared = tx.getInput(i).sighashType
      if (declared !== undefined && declared !== SigHash.ALL) throw new SignError(`${CHAINS[chain].label} inputs must use SIGHASH_ALL`)
      tx.signIdx(keys[i].privateKey, i, [SigHash.ALL])
    }
    tx.finalize()
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
    for (let i = 0; i < keys.length; i++) {
      const { privateKey, publicKey } = keys[i]
      const hash = unifiedSighash(unsigned, i, spent, SIGHASH_ALL_UNIFIED, 1, p2pkh(publicKey).script)
      const der = secp256k1.sign(hash, privateKey, { prehash: false, lowS: true, format: "der" })
      if (!secp256k1.verify(der, hash, publicKey, { prehash: false, format: "der" })) throw new SignError("Signature self-check failed")
      tx.updateInput(i, { finalScriptWitness: [concatBytes(der, Uint8Array.of(SIGHASH_ALL_UNIFIED)), publicKey] }, true)
    }
  }

  const vsize = tx.vsize
  if (Number(fee) / vsize > MAX_FEE_RATE) throw new SignError(`Fee rate above ${MAX_FEE_RATE} sat/vB refused`)
  return { hex: tx.hex, txid: tx.id, fee: Number(fee), vsize }
}
