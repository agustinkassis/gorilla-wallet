// bpub (github.com/bitfiles-io/bpub) v5 uploads, the way bitfiles.io makes them:
// 1. funding tx (the wallet's): one P2WSH 1-of-N multisig output per ≤14 fake pubkeys carrying the file, plus the
//    v5 ownership output (the owner's address committed with the file's bpub id);
// 2. reveal tx (signed here with a throwaway control key): spends those outputs, putting the redeem scripts (the
//    data) in the witness, and refunds what's left to the wallet. Its txid is the file's link.
import {
  DUST,
  buildMultisigScript,
  buildOwnerRedeemScript,
  buildStreamV5,
  bytesToHex,
  chunkDataPubkeys,
  computeBpubV5Id,
  decodeStream,
  encodeStreamToPubkeys,
  deserializeTransaction,
  estimateFeeReveal,
  hexToBytes,
  ownerH160FromAddress,
  p2wshScriptPubKey,
  rawDeflate,
  recoverFromRawTransaction,
  scriptPubKeyToAddress,
  signRevealTransaction,
  transactionId,
} from "@bitfiles/bpub"
import { secp256k1 } from "@noble/curves/secp256k1.js"

/** the wallet takes up to this many outputs from a module: 500 × 14 pubkeys × 31 bytes ≈ 212 KB of stream */
export const MAX_OUTPUTS = 500
/** v5 ownership output, as bitfiles.io funds it */
export const OWNER_SATS = 1000
/** what the reveal refunds at least (the rest of the data outputs' value pays its fee) */
const REFUND_SATS = 1000

export type Draft = {
  key: Uint8Array
  /** the encoded file: all an interrupted upload needs (with the key and owner) to pick up where it stopped */
  stream: Uint8Array
  /** the file back out of the stream */
  content: Uint8Array
  mime: string
  filename: string
  /** data outputs' scriptPubKeys and their redeem scripts, in order */
  scripts: Uint8Array[]
  redeem: Uint8Array[]
  owner: Uint8Array
  compressed: boolean
  streamBytes: number
  sha: string
}

export const newKey = () => secp256k1.utils.randomSecretKey()

/** Encode `file` into a v5 inscription for `key`. */
export async function draft(file: Uint8Array, o: { mime: string; filename: string; key: Uint8Array; ownerAddress: string }): Promise<Draft> {
  const compress = (await rawDeflate(file)).length < file.length
  return restore(await buildStreamV5(file, { mime: o.mime, filename: o.filename, compress }), o.key, o.ownerAddress)
}

/** A draft from its stream (what buildInscription does for v5). Deterministic: the same stream and key give the same outputs. */
export async function restore(stream: Uint8Array, key: Uint8Array, ownerAddress: string): Promise<Draft> {
  if (stream.length > MAX_OUTPUTS * 14 * 31) throw new Error(`Too big: about ${Math.floor((MAX_OUTPUTS * 434) / 1000)} KB fits after compression, this is ${Math.ceil(stream.length / 1000)} KB`)
  const { meta, content } = await decodeStream(stream)
  const controlPubkey = secp256k1.getPublicKey(key, true)
  const redeem = chunkDataPubkeys(encodeStreamToPubkeys(stream)).map((chunk) => buildMultisigScript(chunk, controlPubkey))
  return {
    key,
    stream,
    content,
    mime: meta.mime ?? "application/octet-stream",
    filename: meta.filename ?? "file",
    scripts: await Promise.all(redeem.map(p2wshScriptPubKey)),
    redeem,
    owner: await p2wshScriptPubKey(buildOwnerRedeemScript(await computeBpubV5Id(content), ownerH160FromAddress(ownerAddress))),
    compressed: stream.length < content.length,
    streamBytes: stream.length,
    sha: bytesToHex(meta.sha),
  }
}

/** What `n` data outputs cost at `feeRate`: each output's value (covering the reveal's fee and a refund), the reveal fee and an estimate of the funding fee. */
export function costs(n: number, feeRate: number) {
  const revealFee = estimateFeeReveal(n, 1, feeRate)
  const perOutput = Math.max(DUST, Math.ceil((revealFee + REFUND_SATS) / n))
  // ~2 P2WPKH inputs, n + 1 P2WSH outputs, change
  const fundingFee = Math.ceil((11 + 2 * 68 + (n + 1) * 43 + 31) * feeRate)
  return { perOutput, revealFee, fundingFee, refund: n * perOutput - revealFee }
}

/** The funding outputs the wallet is asked to pay. */
export const fundingOutputs = (d: Draft, feeRate: number) => [
  ...d.scripts.map((s) => ({ script: bytesToHex(s), amount: costs(d.scripts.length, feeRate).perOutput })),
  { script: bytesToHex(d.owner), amount: OWNER_SATS },
]

/** An address paying the first data output: finds the funding tx on an explorer when its txid was lost. */
export const firstOutputAddress = (d: Draft) => scriptPubKeyToAddress(d.scripts[0])

/** Sign the reveal of `d` from its funding tx (raw hex; the wallet shuffles outputs) and check it decodes back to the file. */
export async function reveal(d: Draft, fundingHex: string, refundAddress: string, feeRate: number) {
  const funding = deserializeTransaction(hexToBytes(fundingHex))
  const txid = await transactionId(funding)
  const used = new Set<number>()
  const inputs = d.redeem.map((redeemScript, i) => {
    const want = bytesToHex(d.scripts[i])
    const vout = funding.outputs.findIndex((o, j) => !used.has(j) && bytesToHex(o.scriptPubKey) === want)
    if (vout < 0) throw new Error(`Funding tx ${txid} doesn't pay this file's outputs`)
    used.add(vout)
    return { txid, vout, valueSats: funding.outputs[vout].value, redeemScript }
  })
  const signed = await signRevealTransaction({ inputs, destinationAddress: refundAddress, controlPrivateKey: d.key, feerate: feeRate })
  const { meta } = await recoverFromRawTransaction(signed.rawHex)
  if (bytesToHex(meta.sha) !== d.sha) throw new Error("The reveal doesn't decode back to this file")
  return { fundingTxid: txid, ...signed }
}
