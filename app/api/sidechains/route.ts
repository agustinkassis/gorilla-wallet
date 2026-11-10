import { authorizedJson, isChain } from "@/lib/server/auth"
import { EnforcerError, pegEvents, proposals, rules, sidechains } from "@/lib/server/enforcer"
import { CHAINS } from "@/lib/chains"

/**
 * POST {chain} → {sidechains, proposals, rules}: BIP300 sidechains active on `chain` (slot, title, description,
 * treasury), slot proposals still voting and the voting windows, from its enforcer.
 * POST {chain, slot} → {events}: that slot's deposits and withdrawal bundles, newest first.
 */
export async function POST(req: Request) {
  const body = await authorizedJson<{ chain?: unknown; slot?: unknown }>(req)
  if (body instanceof Response) return body
  if (!isChain(body.chain) || !CHAINS[body.chain].drivechain) return Response.json({ error: "No sidechains on this chain" }, { status: 400 })
  const chain = body.chain
  try {
    if (body.slot !== undefined) {
      if (!Number.isInteger(body.slot) || (body.slot as number) < 0 || (body.slot as number) > 255) return Response.json({ error: "Invalid slot" }, { status: 400 })
      return Response.json({ events: await pegEvents(chain, body.slot as number) })
    }
    const [active, pending, bip300] = await Promise.all([sidechains(chain), proposals(chain).catch(() => []), rules(chain).catch(() => null)])
    return Response.json({ sidechains: active, proposals: pending, rules: bip300 })
  } catch (e) {
    return Response.json({ error: e instanceof EnforcerError ? e.message : "Enforcer request failed" }, { status: 502 })
  }
}
