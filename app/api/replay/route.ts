import { authorizedJson, isChain } from "@/lib/server/auth"
import type { Chain } from "@/lib/chains"
import { analyzeReplay } from "@/lib/server/replay"
import { ChainInactiveError } from "@/lib/server/watcher"

/** POST {walletId, chain, txid, to?} → replay analysis of that tx onto a replay pair (default the first: Bitcoin → Blake). */
export async function POST(req: Request) {
  const body = await authorizedJson<{ walletId?: unknown; chain?: unknown; txid?: unknown; to?: unknown }>(req)
  if (body instanceof Response) return body
  if (typeof body.walletId !== "string" || !isChain(body.chain) || typeof body.txid !== "string" || !/^[0-9a-f]{64}$/.test(body.txid) || (body.to !== undefined && !isChain(body.to)))
    return Response.json({ error: "Invalid request" }, { status: 400 })
  try {
    return Response.json(await analyzeReplay(body.walletId, body.chain, body.txid, body.to as Chain | undefined))
  } catch (e) {
    if (e instanceof ChainInactiveError) return Response.json({ error: e.message }, { status: 409 })
    return Response.json({ error: "Transaction not found" }, { status: 404 })
  }
}
