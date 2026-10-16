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
  /** the chain this fork split from: their shared coins can replay between them, so both sync together */
  replayPair?: Chain
  /** sends use nLockTime REPLAY_LOCKTIME: final here, never final on Bitcoin (eCash's opt-in replay protection) */
  replayLockTime?: boolean
  /** the block it forks from its replay pair at */
  forkHeight?: number
  /** not launched yet (no servers): selecting it shows the countdown to forkHeight and what the snapshot would credit */
  soon?: boolean
  /**
   * BIP300 sidechain deposits (M5): the byte this chain's build uses for OP_DRIVECHAIN, and default enforcers
   * (bip300301_enforcer's Connect/JSON API: active slots and their treasury UTXOs, which Electrum can't tell)
   */
  drivechain?: { opcode: number; enforcer: string[] }
}

export type Chain = "btc" | "xbt" | "ecx" | "pecx" | "tbtc4" | "tbtc3" | "signet" | "regtest"

/** LOCKTIME_THRESHOLD - 1: eCash treats it as final, Bitcoin as a height ~500M blocks away (never final). */
export const REPLAY_LOCKTIME = 499_999_999

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
  pecx: {
    label: "eCash Beta",
    unit: "pECX",
    text: "text-sky-600 dark:text-sky-400",
    bg: "bg-sky-500",
    family: "main",
    electrum: ["ssl://explorer.beta.ecash.ninja:50002"],
    mempool: ["https://explorer.beta.ecash.ninja"],
    // LayerTwo Labs' betanet: Bitcoin Core 31.1 + BIP300/301 drivechains (magic 0xeca5b104, P2P seed.beta.ecash.ninja:8533)
    replayPair: "btc",
    replayLockTime: true,
    forkHeight: 967_680,
    // betanet moved OP_DRIVECHAIN from BIP300's OP_NOP5 (0xb4) to OP_NOP8 (bip300301_enforcer NetworkParams::betanet)
    drivechain: { opcode: 0xb7, enforcer: ["https://enforcer.beta.ecash.ninja"] },
  },
  ecx: {
    label: "eCash",
    unit: "ECX",
    text: "text-blue-600 dark:text-blue-400",
    bg: "bg-blue-500",
    family: "main",
    // servers are announced at launch
    electrum: [],
    mempool: [],
    replayPair: "btc",
    replayLockTime: true,
    forkHeight: 973_728,
    soon: true,
    // drivechain: add at launch, once its build's OP_DRIVECHAIN byte and a public enforcer are known
  },
}
export const CHAIN_IDS = Object.keys(CHAINS) as Chain[]
export const WEB_CHAIN_IDS = CHAIN_IDS.filter((chain) => chain !== "regtest")

export const isChain = (c: unknown): c is Chain => typeof c === "string" && Object.hasOwn(CHAINS, c)
export const familyOf = (chain: Chain) => CHAINS[chain].family
export const networkOf = (family: Family) => FAMILIES[family].network

/** Chains `chain`'s coins replay with: a fork's parent, or a parent's launched forks (Bitcoin: Blake, eCash Beta). */
export const replayPairs = (chain: Chain): Chain[] => {
  const parent = CHAINS[chain].replayPair
  return parent ? [parent] : CHAIN_IDS.filter((c) => CHAINS[c].replayPair === chain && !CHAINS[c].soon)
}

/** The selected chain and its replay pairs: they sync together (replay checks need both sides). */
export const syncedChains = (chain: Chain): Chain[] => [chain, ...replayPairs(chain)]

/** The same account on another family: m/84'/0'/0' → m/84'/1'/0' (BIP44 coin type). */
export const familyPath = (path: string, family: Family) => path.replace(/^m\/(\d+'?)\/\d+'/, `m/$1/${FAMILIES[family].coinType}'`)

/** The replay pair that caps OP_RETURNs, so a bigger one pins a tx to `chain` (Bitcoin vs Blake). */
export const dataCapPair = (chain: Chain) => replayPairs(chain).find((c) => typeof CHAINS[c].maxDataScript === "number")

/** The smallest OP_RETURN script `chain` accepts so its replay pair rejects it (Bitcoin: 84, Blake allows ≤ 83). */
export function minDataScript(chain: Chain) {
  if (chain === "regtest") return 84
  const pair = dataCapPair(chain)
  return pair ? (CHAINS[pair].maxDataScript as number) + 1 : 0
}
