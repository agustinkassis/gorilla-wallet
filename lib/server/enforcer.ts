import "server-only"
import { config } from "@/lib/server/config"
import { CHAINS, type Chain } from "@/lib/chains"
import { addressFor, parseTxHex, type Ctip } from "@/lib/tx"

export class EnforcerError extends Error {}

export type Sidechain = { slot: number; title: string; description: string; activationHeight: number | null; ctip: Ctip | null }
export type Proposal = { slot: number; title: string; description: string; votes: number; proposalHeight: number; age: number }
/** BIP300 voting windows: a slot activates, and a withdrawal bundle pays out, with `threshold` acks within `maxAge` blocks */
export type Bip300Rules = { bundleThreshold: number; bundleMaxAge: number; slotThreshold: number; slotMaxAge: number; unusedSlotThreshold: number }
export type PegEvent =
  | { kind: "deposit"; height: number; time: number; txid: string; vout: number; value: number; address: string }
  | {
      kind: "withdrawal"
      height: number
      time: number
      m6id: string
      status: "submitted" | "succeeded" | "failed"
      /** succeeded: the M6 payout and what it pays (the first output is the new treasury) */
      txid?: string
      payouts?: { address: string | null; value: number }[]
    }

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
type Declaration = { v0?: { title?: string; description?: string } }
type SidechainsJson = { sidechains?: { sidechainNumber?: number; activationHeight?: number; declaration?: Declaration }[] }
type ProposalsJson = {
  sidechainProposals?: { sidechainNumber?: number; voteCount?: number; proposalHeight?: number; proposalAge?: number; declaration?: Declaration }[]
}
type Hex = { hex?: string }
type PegJson = {
  blocks?: {
    blockHeaderInfo?: { height?: number; timestamp?: string }
    blockInfo?: {
      events?: {
        deposit?: { outpoint?: { txid?: Hex; vout?: number }; output?: { address?: Hex; valueSats?: string } }
        withdrawalBundle?: { m6id?: Hex; event?: { submitted?: object; failed?: object; succeeded?: { transaction?: Hex } } }
      }[]
    }
  }[]
}

const text = (s: unknown, max: number) => (typeof s === "string" ? s.slice(0, max) : "")
const decl = (d: Declaration | undefined, slot: number) => ({ title: text(d?.v0?.title, 64) || `Slot ${slot}`, description: text(d?.v0?.description, 280) })
const hex64 = (h: Hex | undefined) => (/^[0-9a-f]{64}$/.test(h?.hex ?? "") ? h!.hex! : null)

/** Active sidechains (slot, title) and each one's current treasury UTXO (proto3 JSON leaves out zeros: vout 0). */
export async function sidechains(chain: Chain): Promise<Sidechain[]> {
  const { sidechains = [] } = await validator<SidechainsJson>(chain, "GetSidechains", {})
  return Promise.all(
    sidechains.map(async ({ sidechainNumber: slot = 0, activationHeight, declaration }) => {
      const { ctip } = await validator<CtipJson>(chain, "GetCtip", { sidechainNumber: slot })
      const value = Number(ctip?.value)
      if (ctip && (!/^[0-9a-f]{64}$/.test(ctip.txid?.hex ?? "") || !Number.isSafeInteger(value) || value <= 0))
        throw new EnforcerError(`The enforcer sent a malformed treasury for slot ${slot}`)
      return { slot, ...decl(declaration, slot), activationHeight: activationHeight ?? null, ctip: ctip ? { txid: ctip.txid!.hex!, vout: ctip.vout ?? 0, value } : null }
    }),
  )
}

/** Sidechain slot proposals still collecting miner votes. */
export async function proposals(chain: Chain): Promise<Proposal[]> {
  const { sidechainProposals = [] } = await validator<ProposalsJson>(chain, "GetSidechainProposals", {})
  return sidechainProposals.map(({ sidechainNumber: slot = 0, voteCount, proposalHeight, proposalAge, declaration }) => ({
    slot,
    ...decl(declaration, slot),
    votes: voteCount ?? 0,
    proposalHeight: proposalHeight ?? 0,
    age: proposalAge ?? 0,
  }))
}

type ChainInfoJson = {
  bip300Constants?: Partial<Record<"withdrawalBundleInclusionThreshold" | "withdrawalBundleMaxAge" | "usedSidechainSlotActivationThreshold" | "usedSidechainSlotProposalMaxAge" | "unusedSidechainSlotActivationThreshold", number>>
}

export async function rules(chain: Chain): Promise<Bip300Rules> {
  const c = (await validator<ChainInfoJson>(chain, "GetChainInfo", {})).bip300Constants ?? {}
  return {
    bundleThreshold: c.withdrawalBundleInclusionThreshold ?? 13_150,
    bundleMaxAge: c.withdrawalBundleMaxAge ?? 26_300,
    slotThreshold: c.usedSidechainSlotActivationThreshold ?? 13_150,
    slotMaxAge: c.usedSidechainSlotProposalMaxAge ?? 26_300,
    unusedSlotThreshold: c.unusedSidechainSlotActivationThreshold ?? 1_008,
  }
}

// ponytail: per-process cache; the enforcer rescans from BIP300 activation each call (~6s), fine for one wallet's page
const pegCache = new Map<string, { at: number; events: Promise<PegEvent[]> }>()

/** A slot's deposits (M5) and withdrawal bundles (M3 submitted, M6 paid, or failed) since activation, newest first. */
export function pegEvents(chain: Chain, slot: number): Promise<PegEvent[]> {
  const key = `${chain}:${slot}`
  const hit = pegCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.events
  const events = loadPegEvents(chain, slot)
  pegCache.set(key, { at: Date.now(), events })
  events.catch(() => pegCache.delete(key))
  return events
}

async function loadPegEvents(chain: Chain, slot: number): Promise<PegEvent[]> {
  const tip = await validator<{ blockHeaderInfo?: { blockHash?: Hex } }>(chain, "GetChainTip", {})
  const end = hex64(tip.blockHeaderInfo?.blockHash)
  if (!end) throw new EnforcerError("The enforcer sent a malformed chain tip")
  const { blocks = [] } = await validator<PegJson>(chain, "GetTwoWayPegData", { sidechainId: slot, endBlockHash: { hex: end } })
  const out: PegEvent[] = []
  for (const b of blocks) {
    const height = b.blockHeaderInfo?.height ?? 0
    const time = Number(b.blockHeaderInfo?.timestamp ?? 0)
    for (const e of b.blockInfo?.events ?? []) {
      if (e.deposit) {
        const txid = hex64(e.deposit.outpoint?.txid)
        const value = Number(e.deposit.output?.valueSats)
        if (!txid || !Number.isSafeInteger(value)) continue
        const address = Buffer.from(e.deposit.output?.address?.hex ?? "", "hex").toString("utf8").slice(0, 128)
        out.push({ kind: "deposit", height, time, txid, vout: e.deposit.outpoint?.vout ?? 0, value, address })
      } else if (e.withdrawalBundle) {
        const m6id = hex64(e.withdrawalBundle.m6id)
        const ev = e.withdrawalBundle.event
        if (!m6id || !ev) continue
        const status = ev.succeeded ? "succeeded" : ev.failed ? "failed" : "submitted"
        let txid: string | undefined
        let payouts: { address: string | null; value: number }[] | undefined
        const raw = ev.succeeded?.transaction?.hex
        if (raw && /^[0-9a-f]+$/i.test(raw)) {
          try {
            const tx = parseTxHex(raw)
            txid = tx.id
            payouts = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i))
              .slice(1)
              .map((o) => ({ address: (o.script && addressFor(o.script, chain)) ?? null, value: Number(o.amount ?? 0n) }))
          } catch {}
        }
        out.push({ kind: "withdrawal", height, time, m6id, status, txid, payouts })
      }
    }
  }
  return out.reverse()
}
