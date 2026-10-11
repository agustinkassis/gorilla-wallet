// Chain registry: everything chain-specific is data here. To add a chain, add its id to `Chain` and an entry to CHAINS.
import { NETWORK, TEST_NETWORK } from "@scure/btc-signer"

/** Chains of one family share keys and address encoding: a wallet has one account per family. */
export type Family = "main" | "test" | "regtest"
type Network = typeof NETWORK

export const FAMILIES: Record<Family, { label: string; network: Network; coinType: number }> = {
  main: { label: "Mainnet", network: NETWORK, coinType: 0 },
  regtest: { label: "Regtest", network: { ...TEST_NETWORK, bech32: "bcrt" }, coinType: 1 },
  test: { label: "Testnet", network: TEST_NETWORK, coinType: 1 },
}

export type ChainDef = {
  label: string
  unit: string
  /** Tailwind classes for the chain's color */
  text: string
  bg: string
  family: Family
  /** default Electrum/Fulcrum servers (tcp:// or ssl://), tried in order */
  electrum: string[]
  /** default mempool.space-compatible APIs (fees, broadcast; the first one is the explorer), tried in order */
  mempool: string[]
  /** signatures commit to SIGHASH_UNIFIED (0x21): chains without it reject them (replay protection) */
  unifiedSighash?: boolean
  /** consensus limits in bytes: OP_RETURN scripts (false = none allowed) and every other output script */
  maxDataScript?: number | false
  maxScript?: number
  /** this app's sends never carry OP_RETURN outputs here (policy; replay checks still use the consensus limit) */
  noDataOutputs?: boolean
  /** a fork sharing history with this chain: coins can replay between them, so both sync together */
  replayPair?: Chain
}

export type Chain = "btc" | "xbt" | "tbtc4" | "tbtc3" | "signet" | "regtest"

export const CHAINS: Record<Chain, ChainDef> = {
  regtest: {
    label: "Regtest",
    unit: "BTC",
    text: "text-gray-600 dark:text-gray-400",
    bg: "bg-gray-500",
    family: "regtest",
    electrum: [],
    mempool: [],
  },
  btc: {
    label: "Bitcoin",
    unit: "BTC",
    text: "text-orange-600 dark:text-orange-400",
    bg: "bg-orange-500",
    family: "main",
    electrum: ["ssl://electrum.blockstream.info:50002"],
    mempool: ["https://mempool.space"],
    replayPair: "xbt",
  },
  xbt: {
    label: "Blake",
    unit: "XBT",
    text: "text-violet-600 dark:text-violet-400",
    bg: "bg-violet-500",
    family: "main",
    electrum: ["tcp://fulcrum.kilombino.com:17717", "tcp://electrum.marcanotrades.com:4142"],
    mempool: ["https://mempool.kilombino.com"],
    // Bitcoin Knots v29.4.1+ BLAKE2b fork: SIGHASH_UNIFIED and reduced_data (until 2027-09-01)
    unifiedSighash: true,
    maxDataScript: 83,
    maxScript: 34,
    noDataOutputs: true,
    replayPair: "btc",
  },
  tbtc4: {
    label: "Testnet4",
    unit: "tBTC",
    text: "text-teal-600 dark:text-teal-400",
    bg: "bg-teal-500",
    family: "test",
    electrum: ["ssl://mempool.space:40002", "ssl://blackie.c3-soft.com:57010"],
    mempool: ["https://mempool.space/testnet4"],
  },
  tbtc3: {
    label: "Testnet3",
    unit: "tBTC",
    text: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-500",
    family: "test",
    electrum: ["ssl://electrum.blockstream.info:60002", "ssl://blockstream.info:993"],
    mempool: ["https://mempool.space/testnet"],
  },
  signet: {
    label: "Signet",
    unit: "sBTC",
    text: "text-pink-600 dark:text-pink-400",
    bg: "bg-pink-500",
    family: "test",
    electrum: ["ssl://mempool.space:60602"],
    mempool: ["https://mempool.space/signet"],
  },
}
export const CHAIN_IDS = Object.keys(CHAINS) as Chain[]
export const WEB_CHAIN_IDS = CHAIN_IDS.filter((chain) => chain !== "regtest")

export const isChain = (c: unknown): c is Chain => typeof c === "string" && Object.hasOwn(CHAINS, c)
export const familyOf = (chain: Chain) => CHAINS[chain].family
export const networkOf = (family: Family) => FAMILIES[family].network

/** The selected chain and, for a fork, its replay pair: they sync together (replay checks need both). */
export const syncedChains = (chain: Chain): Chain[] => [chain, ...(CHAINS[chain].replayPair ? [CHAINS[chain].replayPair!] : [])]

/** The same account on another family: m/84'/0'/0' → m/84'/1'/0' (BIP44 coin type). */
export const familyPath = (path: string, family: Family) => path.replace(/^m\/(\d+'?)\/\d+'/, `m/$1/${FAMILIES[family].coinType}'`)

/** The smallest OP_RETURN script `chain` accepts so its replay pair rejects it (Bitcoin: 84, Blake allows ≤ 83). */
export function minDataScript(chain: Chain) {
  if (chain === "regtest") return 84
  const pair = CHAINS[chain].replayPair
  const max = pair ? CHAINS[pair].maxDataScript : undefined
  return typeof max === "number" ? max + 1 : 0
}
