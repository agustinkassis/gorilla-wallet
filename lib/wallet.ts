import { HDKey } from "@scure/bip32"
import { Address, OutScript, p2wpkh } from "@scure/btc-signer"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js"
import { createBase58check } from "@scure/base"
import { CHAINS, networkOf, type Chain, type Family } from "@/lib/chains"

export { CHAINS, CHAIN_IDS, WEB_CHAIN_IDS, FAMILIES, familyOf, isChain, syncedChains, type Chain, type Family } from "@/lib/chains"

/** Addresses shown on the dashboard (receive chain). Discovery goes further, up to the gap limit. */
export const ADDRESS_COUNT = 10

export type AddressInfo = {
  address: string
  change: 0 | 1
  index: number
  used: boolean
  confirmed: number
  unconfirmed: number
  label?: string
}
export type Utxo = { txid: string; vout: number; address: string; value: number; height: number; frozen: boolean; label?: string }
export type Tx = { txid: string; height: number; time: number | null; amount: number; fee?: number | null; vsize?: number | null; label?: string }
export type Fees = { fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number; minimumFee: number }

/** env: the .env seed · seed: software wallet (encrypted with its password, if it has one) · watch: xpub only */
export type WalletKind = "env" | "seed" | "watch"
/** A wallet's account key on one family of chains (xpub stored with mainnet version bytes). */
export type Account = { xpub: string; path: string; fingerprint: number }
export type WalletInfo = {
  id: string
  name: string
  kind: WalletKind
  /** per family; a missing one is enabled from the seed (password if any), watch-only wallets have just one */
  accounts: Partial<Record<Family, Account>>
  watchOnly: boolean
  /** signing asks for this wallet's password */
  needsPassword: boolean
  passphrase: boolean
}

export type Snapshot = {
  walletId: string
  chain: Chain
  connected: boolean
  /** true once balances come from a completed sync (now or a previous run, via the local DB) */
  synced: boolean
  /** host:port of the Electrum server in use */
  server: string | null
  height: number
  /** mempool explorer base URL for this chain */
  explorer: string
  fees: Fees | null
  addresses: AddressInfo[]
  utxos: Utxo[]
  txs: Tx[]
}

export type FeePreset = keyof Fees
/** Where a chain's data comes from; an empty or missing list means the built-in defaults. */
export type ChainSources = { electrum?: string[]; mempool?: string[] }
export type Settings = {
  /** the selected network (navbar); its replay pair, if any, syncs along */
  chain: Chain
  /** networks left out of the navbar switcher (the selected one always shows) */
  hidden: Chain[]
  sources: Partial<Record<Chain, ChainSources>>
  sound: boolean
  notifications: boolean
  feePreset: FeePreset
  /** BTC sends: OP_RETURN replay guard on by default */
  replayGuard: boolean
  gapReceive: number
  gapChange: number
}
export const DEFAULT_SETTINGS: Settings = {
  chain: "btc",
  hidden: [],
  sources: {},
  sound: true,
  notifications: true,
  feePreset: "halfHourFee",
  replayGuard: false,
  gapReceive: 20,
  gapChange: 10,
}

export type StreamMessage =
  | { type: "wallets"; wallets: WalletInfo[] }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "settings"; settings: Settings }

const base58check = createBase58check(sha256)
const XPUB = Uint8Array.of(0x04, 0x88, 0xb2, 0x1e)
const TPUB = Uint8Array.of(0x04, 0x35, 0x87, 0xcf)
/** version bytes → family: xpub/zpub (BIP84) on mainnet, tpub/vpub on testnets */
const VERSIONS: [Uint8Array, Family][] = [
  [XPUB, "main"],
  [Uint8Array.of(0x04, 0xb2, 0x47, 0x46), "main"],
  [TPUB, "test"],
  [Uint8Array.of(0x04, 0x5f, 0x1c, 0xf6), "test"],
]

/**
 * Accept an account-level xpub/zpub (mainnet) or tpub/vpub (testnets, signet) and return it with xpub version bytes
 * (how accounts are stored and derived) plus its family. Throws on anything else (private keys, bad checksum).
 */
export function normalizeXpub(input: string): { xpub: string; family: Family } {
  const raw = base58check.decode(input.trim())
  if (raw.length !== 78) throw new Error("Not an extended public key")
  const family = VERSIONS.find(([v]) => v.every((x, i) => x === raw[i]))?.[1]
  if (!family) throw new Error("Use an xpub/zpub (mainnet) or tpub/vpub (testnet, signet)")
  const xpub = base58check.encode(concatBytes(XPUB, raw.slice(4)))
  HDKey.fromExtendedKey(xpub) // validates the key itself
  return { xpub, family }
}

/**
 * An account key as wallets export it: a bare xpub/zpub/tpub/vpub, a key with origin `[73c5da0a/84h/0h/0h]xpub…`, or an
 * output descriptor `wpkh([73c5da0a/84'/0'/0']xpub…/0/*)#checksum` (Sparrow, Coldcard, Jade, Bitcoin Core). Only the
 * origin carries the master fingerprint and path: an account xpub alone can't give them.
 */
export function parseAccountKey(input: string): { xpub: string; family: Family; fingerprint?: string; path?: string } {
  const s = input.trim()
  if (/^(sh|pkh|tr|wsh|multi|sortedmulti)\(/i.test(s)) throw new Error("Only native SegWit (wpkh) accounts are supported")
  const origin = s.match(/\[([0-9a-fA-F]{8})((?:\/\d+['hH]?)*)\]/)
  const key = s.match(/[tuvxyzTUVXYZ]pub[1-9A-HJ-NP-Za-km-z]{100,112}/)?.[0] ?? s
  return {
    ...normalizeXpub(key),
    ...(origin && { fingerprint: origin[1].toLowerCase(), path: origin[2] ? `m${origin[2].replace(/[hH]/g, "'")}` : undefined }),
  }
}

/** An account xpub as other wallets show it on its family: xpub on mainnet, tpub on testnets. */
export const displayXpub = (xpub: string, family: Family) =>
  family === "main" ? xpub : base58check.encode(concatBytes(TPUB, base58check.decode(xpub).slice(4)))

export const DERIVATION_PATH = /^m(\/\d+'?)+$/

export function deriveAddress(xpub: string, change: 0 | 1, index: number, family: Family) {
  const key = HDKey.fromExtendedKey(xpub).deriveChild(change).deriveChild(index)
  return { address: p2wpkh(key.publicKey!, networkOf(family)).address!, publicKey: key.publicKey! }
}

export function deriveAddresses(xpub: string, family: Family, count = ADDRESS_COUNT, change: 0 | 1 = 0) {
  const branch = HDKey.fromExtendedKey(xpub).deriveChild(change)
  return Array.from({ length: count }, (_, i) => p2wpkh(branch.deriveChild(i).publicKey!, networkOf(family)).address!)
}

export const addressScript = (address: string, family: Family) => OutScript.encode(Address(networkOf(family)).decode(address))

// Electrum scripthash: sha256(scriptPubKey), byte-reversed hex.
export const scriptHash = (address: string, family: Family) => bytesToHex(sha256(addressScript(address, family)).reverse())

export const formatCoins = (sats: number) => (sats / 1e8).toFixed(8)

/** Display unit (header switch): the chain's coin, or sats. */
export type Unit = "btc" | "sats"

/** Number only, in the chosen unit: "0.00150000" or "150,000" (en-US grouping: a "." would read as a BTC decimal). */
export const formatAmount = (sats: number, unit: Unit) => (unit === "sats" ? sats.toLocaleString("en-US") : formatCoins(sats))

/** With its unit, for plain text (toasts, summaries): "0.00150000 XBT" or "150,000 sats". */
export const amountText = (sats: number, chain: Chain, unit: Unit) => `${formatAmount(sats, unit)} ${unit === "sats" ? "sats" : CHAINS[chain].unit}`

export const sumBalances = (s?: Snapshot) =>
  (s?.addresses ?? []).reduce(
    (acc, b) => ({ confirmed: acc.confirmed + b.confirmed, unconfirmed: acc.unconfirmed + b.unconfirmed }),
    { confirmed: 0, unconfirmed: 0 },
  )

/** Snapshot has real data (kept while reconnecting, so last known values stay visible). */
export const hasData = (s?: Snapshot): s is Snapshot => !!s?.synced

/** Outpoints unspent on a chain and on its replay pair: pre-fork coins whose spend can be replayed across. */
export function sharedOutpoints(snapshots: Partial<Record<Chain, Snapshot>>, chain: Chain) {
  const pair = CHAINS[chain].replayPair
  if (!pair) return new Set<string>()
  const other = new Set((snapshots[pair]?.utxos ?? []).map((u) => `${u.txid}:${u.vout}`))
  return new Set((snapshots[chain]?.utxos ?? []).map((u) => `${u.txid}:${u.vout}`).filter((o) => other.has(o)))
}

/** First address on a branch that is unused on every chain. */
export function nextUnused(snapshots: Partial<Record<Chain, Snapshot>>, change: 0 | 1) {
  const used = new Set(Object.values(snapshots).flatMap((s) => s?.addresses.filter((a) => a.used).map((a) => a.address) ?? []))
  const all = (snapshots.btc ?? snapshots.xbt)?.addresses.filter((a) => a.change === change) ?? []
  return all.sort((a, b) => a.index - b.index).find((a) => !used.has(a.address))
}

export type TxEvent = { kind: "received" | "confirmed"; chain: Chain; tx: Tx }

/** Incoming-funds events between two snapshots of one chain. The first load is a baseline and emits nothing. */
export function txEvents(prev: Snapshot | undefined, next: Snapshot): TxEvent[] {
  if (!hasData(prev) || !hasData(next)) return []
  const before = new Map(prev.txs.map((t) => [t.txid, t.height]))
  return next.txs
    .filter((tx) => tx.amount > 0)
    .flatMap((tx): TxEvent[] => {
      const height = before.get(tx.txid)
      if (height === undefined) return [{ kind: "received", chain: next.chain, tx }]
      if (height <= 0 && tx.height > 0) return [{ kind: "confirmed", chain: next.chain, tx }]
      return []
    })
}

/** Unconfirmed incoming txs across chains (drives the sidebar dot). */
export const pendingIncoming = (snapshots: Partial<Record<Chain, Snapshot>>) =>
  Object.values(snapshots).flatMap((s) => s?.txs.filter((t) => t.amount > 0 && t.height <= 0) ?? [])

/** "0.0015" → 150000 sats, exactly (no float rounding). null when not a valid amount. */
export function parseCoins(input: string): number | null {
  const m = /^\s*(\d*)(?:\.(\d{0,8}))?\s*$/.exec(input)
  if (!m || (!m[1] && !m[2])) return null
  const sats = Number(m[1] || "0") * 1e8 + Number((m[2] ?? "").padEnd(8, "0"))
  return Number.isSafeInteger(sats) ? sats : null
}

/** "150,000" → 150000. null unless a whole number of sats. */
export function parseSats(input: string): number | null {
  const s = input.replace(/[\s,_]/g, "")
  return /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null
}

/** Amount fields, typed in the chosen unit. */
export const parseAmount = (input: string, unit: Unit) => (unit === "sats" ? parseSats(input) : parseCoins(input))
export const amountInput = (sats: number, unit: Unit) => (unit === "sats" ? String(sats) : formatCoins(sats))
