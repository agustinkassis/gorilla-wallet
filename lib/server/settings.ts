import "server-only"
import { db } from "@/lib/server/db"
import { DEFAULT_SETTINGS, isChain, type ChainSources, type FeePreset, type Settings } from "@/lib/wallet"

const listeners = new Set<(s: Settings) => void>()
export const onSettings = (l: (s: Settings) => void) => (listeners.add(l), () => void listeners.delete(l))

export async function getSettings(): Promise<Settings> {
  const rows = await db.setting.findMany({ where: { key: { in: Object.keys(DEFAULT_SETTINGS) } } })
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])) }
}

const PRESETS: FeePreset[] = ["fastestFee", "halfHourFee", "hourFee", "economyFee", "minimumFee"]
const isGap = (v: unknown) => Number.isInteger(v) && (v as number) >= 5 && (v as number) <= 200
const ELECTRUM_URL = /^(tcp|ssl|tls):\/\/[a-z0-9.-]+:\d{1,5}$/i
const MEMPOOL_URL = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[\w.~-]+)*\/?$/i

/** Per-chain source lists: known chains only, valid URLs, up to 10 each (empty = defaults). */
function parseSources(v: unknown): Settings["sources"] {
  if (!v || typeof v !== "object") throw new Error("Invalid sources")
  const urls = (list: unknown, re: RegExp, what: string) => {
    if (list === undefined) return undefined
    if (!Array.isArray(list) || list.length > 10) throw new Error(`Invalid ${what} list`)
    return list.map((u) => {
      if (typeof u !== "string" || !re.test(u.trim())) throw new Error(`Invalid ${what} URL: ${String(u)}`)
      return u.trim()
    })
  }
  const out: Settings["sources"] = {}
  for (const [chain, s] of Object.entries(v)) {
    if (!isChain(chain) || !s || typeof s !== "object") throw new Error(`Unknown chain: ${chain}`)
    const { electrum, mempool } = s as ChainSources
    out[chain] = { electrum: urls(electrum, ELECTRUM_URL, "Electrum"), mempool: urls(mempool, MEMPOOL_URL, "mempool") }
  }
  return out
}

/** Validates every key at the trust boundary; unknown keys or wrong types are rejected. */
export function parseSettings(input: unknown): Partial<Settings> {
  if (!input || typeof input !== "object") throw new Error("Invalid settings")
  const out: Partial<Settings> = {}
  for (const [k, v] of Object.entries(input)) {
    if ((k === "sound" || k === "notifications" || k === "replayGuard") && typeof v === "boolean") out[k] = v
    else if (k === "chain" && isChain(v) && v !== "regtest") out.chain = v // regtest is CLI-only: it has no default servers
    else if (k === "hidden" && Array.isArray(v) && v.every(isChain)) out.hidden = [...new Set(v)]
    else if (k === "sources") out.sources = parseSources(v)
    else if (k === "feePreset" && PRESETS.includes(v as FeePreset)) out.feePreset = v as FeePreset
    else if ((k === "gapReceive" || k === "gapChange") && isGap(v)) out[k] = v as number
    else throw new Error(`Invalid setting: ${k}`)
  }
  return out
}

export async function saveSettings(patch: Partial<Settings>) {
  await db.$transaction(
    Object.entries(patch).map(([key, v]) =>
      db.setting.upsert({ where: { key }, create: { key, value: JSON.stringify(v) }, update: { value: JSON.stringify(v) } }),
    ),
  )
  const settings = await getSettings()
  for (const l of listeners) l(settings)
  return settings
}
