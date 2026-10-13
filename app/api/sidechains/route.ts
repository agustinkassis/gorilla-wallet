import { authorizedJson, isChain } from "@/lib/server/auth"
import { EnforcerError, sidechains } from "@/lib/server/enforcer"
import { CHAINS } from "@/lib/chains"

/** POST {chain} → {sidechains: [{slot, title, ctip}]}: BIP300 sidechains active on `chain`, from its enforcer. */
export async function POST(req: Request) {
  const body = await authorizedJson<{ chain?: unknown }>(req)
  if (body instanceof Response) return body
  if (!isChain(body.chain) || !CHAINS[body.chain].drivechain) return Response.json({ error: "No sidechains on this chain" }, { status: 400 })
  try {
    return Response.json({ sidechains: await sidechains(body.chain) })
  } catch (e) {
    return Response.json({ error: e instanceof EnforcerError ? e.message : "Enforcer request failed" }, { status: 502 })
  }
}
