import "server-only"
import { CHAINS, type Chain } from "@/lib/chains"
import type { Settings } from "@/lib/wallet"

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean)

/** Runtime configuration, read from the environment on access. Every default mirrors .env.example, so the app runs with an empty .env. */
export const config = {
  /** optional: a default wallet from the environment (its seed is never written to the DB) */
  get seedPhrase() {
    return process.env.SEED_PHRASE?.trim() || null
  },
  get derivationPath() {
    return process.env.DERIVATION_PATH?.trim() || "m/84'/0'/0'"
  },
  /** optional: npub/hex allowlist; without it the first Nostr login claims the app */
  get allowedPubkeys() {
    return list(process.env.ALLOWED_PUBKEYS ?? "")
  },
  /** optional: Electrum hosts whose ssl:// certificate isn't verified (self-signed servers you trust) */
  get electrumSelfSigned() {
    return list(process.env.ELECTRUM_SELF_SIGNED?.toLowerCase() ?? "")
  },
  /**
   * A chain's sources, first non-empty list wins: Settings → Networks, then .env (BTC_ELECTRUM, MEMPOOL_BTC_URL,
   * TBTC4_ELECTRUM, … comma-separated), then the defaults in lib/chains.ts.
   */
  sources(chain: Chain, settings: Settings) {
    const env = (name: string) => list(process.env[name] ?? "")
    const id = chain.toUpperCase()
    const pick = (...lists: (string[] | undefined)[]) => lists.find((l) => l?.length) ?? []
    return {
      electrum: pick(settings.sources[chain]?.electrum, env(`${id}_ELECTRUM`), CHAINS[chain].electrum),
      mempool: pick(settings.sources[chain]?.mempool, env(`MEMPOOL_${id}_URL`), CHAINS[chain].mempool).map((u) => u.replace(/\/+$/, "")),
    }
  },
}
