import "server-only"
import { config } from "@/lib/server/config"
import { CHAINS, type Chain } from "@/lib/chains"
import type { Ctip } from "@/lib/tx"

export class EnforcerError extends Error {}

export type Sidechain = { slot: number; title: string; ctip: Ctip | null }

/** A bip300301_enforcer ValidatorService call over Connect (JSON POST), each configured enforcer in turn. */
async function validator<T>(chain: Chain, method: string, body: object): Promise<T> {
  const enforcer = config.enforcers(chain)
  if (!enforcer.length) throw new EnforcerError(`No BIP300 enforcer for ${CHAINS[chain].label}: set ${chain.toUpperCase()}_ENFORCER`)
  for (const base of enforcer) {
    try {
      const res = await fetch(`${base}/cusf.mainchain.v1.ValidatorService/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) return (await res.json()) as T
    } catch {}
  }
  throw new EnforcerError(`Couldn't reach the ${CHAINS[chain].label} enforcer`)
}

type CtipJson = { ctip?: { txid?: { hex?: string }; vout?: number; value?: string } }
type SidechainsJson = { sidechains?: { sidechainNumber?: number; declaration?: { v0?: { title?: string } } }[] }

/** Active sidechains (slot, title) and each one's current treasury UTXO (proto3 JSON leaves out zeros: vout 0). */
export async function sidechains(chain: Chain): Promise<Sidechain[]> {
  const { sidechains = [] } = await validator<SidechainsJson>(chain, "GetSidechains", {})
  return Promise.all(
    sidechains.map(async ({ sidechainNumber: slot = 0, declaration }) => {
      const { ctip } = await validator<CtipJson>(chain, "GetCtip", { sidechainNumber: slot })
      const value = Number(ctip?.value)
      if (ctip && (!/^[0-9a-f]{64}$/.test(ctip.txid?.hex ?? "") || !Number.isSafeInteger(value) || value <= 0))
        throw new EnforcerError(`The enforcer sent a malformed treasury for slot ${slot}`)
      return { slot, title: declaration?.v0?.title?.slice(0, 64) || `Slot ${slot}`, ctip: ctip ? { txid: ctip.txid!.hex!, vout: ctip.vout ?? 0, value } : null }
    }),
  )
}
