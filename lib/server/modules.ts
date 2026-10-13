import "server-only"
// The server half of the module API: each module's own storage and its allowlisted HTTPS requests. Nothing here
// reaches wallets, keys or other modules' data.
import { db } from "@/lib/server/db"
import { getSettings } from "@/lib/server/settings"
import { STORAGE_KEY, STORAGE_MAX, type HttpRequest, type HttpResponse, type ModuleManifest } from "@/lib/modules/types"
import { isEnabled, moduleById } from "@/modules"

export class ModuleError extends Error {}

/** The module, if it exists and is enabled. */
export async function enabledModule(id: unknown) {
  const m = typeof id === "string" ? moduleById(id) : undefined
  if (!m || !isEnabled(m, (await getSettings()).modules)) throw new ModuleError("Unknown or disabled module")
  return m
}

const MAX_KEYS = 500
// Rows of the settings table under a per-module prefix: getSettings only reads its own keys.
const prefix = (m: ModuleManifest) => `module:${m.id}:`
function rowKey(m: ModuleManifest, key: unknown) {
  if (typeof key !== "string" || !STORAGE_KEY.test(key)) throw new ModuleError("Storage keys are 1-64 letters, digits, _ . -")
  return prefix(m) + key
}

export async function storageGet(m: ModuleManifest, key: unknown) {
  const row = await db.setting.findUnique({ where: { key: rowKey(m, key) } })
  return row ? JSON.parse(row.value) : null
}

/** null/undefined deletes the key. */
export async function storageSet(m: ModuleManifest, key: unknown, value: unknown) {
  const k = rowKey(m, key)
  if (value === null || value === undefined) return void (await db.setting.deleteMany({ where: { key: k } }))
  const json = JSON.stringify(value)
  if (json.length > STORAGE_MAX) throw new ModuleError("Values are limited to 64 KB")
  const exists = await db.setting.count({ where: { key: k } })
  if (!exists && (await db.setting.count({ where: { key: { startsWith: prefix(m) } } })) >= MAX_KEYS) throw new ModuleError(`Up to ${MAX_KEYS} keys per module`)
  await db.setting.upsert({ where: { key: k }, create: { key: k, value: json }, update: { value: json } })
}

const METHODS = ["GET", "POST", "PUT", "DELETE"]
const HEADER = /^[a-z0-9-]{1,64}$/i
// the server sets these itself, and cookies/origin would speak for the wallet
const BLOCKED = new Set(["host", "cookie", "origin", "referer", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer"])
const MAX_REQUEST = 1024 * 1024
const MAX_RESPONSE = 2 * 1024 * 1024

/** HTTPS to a host the manifest lists (port 443, no redirects followed), text in and out, bounded in size and time. */
export async function moduleFetch(m: ModuleManifest, req: HttpRequest): Promise<HttpResponse> {
  const url = URL.parse(typeof req?.url === "string" ? req.url : "")
  if (!url || url.protocol !== "https:" || url.port || url.username || url.password || !m.hosts?.includes(url.hostname))
    throw new ModuleError(`${url?.host ?? "That URL"} isn't one of ${m.name}'s hosts (https only)`)
  const method = req.method ?? "GET"
  if (!METHODS.includes(method)) throw new ModuleError(`Method ${method} not allowed`)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (!HEADER.test(k) || typeof v !== "string" || BLOCKED.has(k.toLowerCase())) throw new ModuleError(`Header not allowed: ${k}`)
    headers.set(k, v)
  }
  if (req.body !== undefined && (typeof req.body !== "string" || req.body.length > MAX_REQUEST)) throw new ModuleError("Body must be text up to 1 MB")

  let res: Response
  try {
    res = await fetch(url, { method, headers, body: method === "GET" ? undefined : req.body, redirect: "manual", signal: AbortSignal.timeout(15_000) })
  } catch (e) {
    throw new ModuleError(`Couldn't reach ${url.host}: ${(e as Error).message}`)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = res.body?.getReader()
  for (let r = await reader?.read(); r && !r.done; r = await reader!.read()) {
    size += r.value.byteLength
    if (size > MAX_RESPONSE) {
      await reader!.cancel()
      throw new ModuleError("Response over 2 MB")
    }
    chunks.push(r.value)
  }
  return { status: res.status, contentType: res.headers.get("content-type"), body: Buffer.concat(chunks).toString("utf8") }
}
