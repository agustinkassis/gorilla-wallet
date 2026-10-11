import { connection } from "next/server"
import { allowedPubkeys } from "@/lib/server/auth"

/** GET → {login}: whether the app asks for a Nostr login (ALLOWED_PUBKEYS is set). Public, read at request time. */
export async function GET() {
  await connection()
  return Response.json({ login: allowedPubkeys().size > 0 })
}
