import { authorizedJson, isChain } from "@/lib/server/auth"
import { republish, setLabel, validRef } from "@/lib/server/labels"
import { getWallet } from "@/lib/server/wallets"

/** POST {walletId, chain, jsonl} — import BIP-329 records (tx, addr, output; other types are skipped). */
export async function POST(req: Request) {
  const body = await authorizedJson<{ walletId?: unknown; chain?: unknown; jsonl?: unknown }>(req)
  if (body instanceof Response) return body
  const wallet = await getWallet(body.walletId).catch(() => null)
  if (!wallet) return Response.json({ error: "Unknown wallet" }, { status: 400 })
  if (!isChain(body.chain) || typeof body.jsonl !== "string" || body.jsonl.length > 5_000_000)
    return Response.json({ error: "Invalid request" }, { status: 400 })
  let imported = 0
  let skipped = 0
  for (const line of body.jsonl.split("\n")) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      const type = r.type
      const ref = String(r.ref ?? "")
      const label = typeof r.label === "string" && r.label.trim() ? r.label.trim().slice(0, 255) : null
      const spendable = type === "output" && typeof r.spendable === "boolean" ? r.spendable : null
      if (!validRef(type, ref, body.chain) || (label === null && spendable === null)) {
        skipped++
        continue
      }
      await setLabel(wallet.id, body.chain, type, ref, label, spendable)
      imported++
    } catch {
      skipped++
    }
  }
  await republish(wallet.id)
  return Response.json({ imported, skipped })
}
