"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { SimplePool, type Event, type EventTemplate } from "nostr-tools"
import { toast } from "sonner"
import { loginRequired } from "@/lib/api"
import { requestNotifications } from "@/lib/notify"

declare global {
  interface Window {
    nostr?: { getPublicKey(): Promise<string>; signEvent(e: EventTemplate): Promise<Event> }
  }
}

export type Profile = { name?: string; display_name?: string; picture?: string }

const STORAGE_KEY = "gorilla-wallet:pubkey"
const RELAYS = ["wss://purplepag.es", "wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"]

// Profile cache (localStorage, per pubkey): the navbar shows it instantly; relays refresh it in the background.
type CachedProfile = { createdAt: number; data: Profile }
const profileKey = (pubkey: string) => `gorilla-wallet:profile:${pubkey}`
function readProfile(pubkey: string): CachedProfile | null {
  try {
    return JSON.parse(localStorage.getItem(profileKey(pubkey)) ?? "null")
  } catch {
    return null
  }
}
/** Only the fields we show, as strings (kind-0 content is untrusted JSON). */
function pickProfile(content: string): Profile | null {
  try {
    const p = JSON.parse(content) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
    return { name: str(p.name), display_name: str(p.display_name) ?? str(p.displayName), picture: str(p.picture) }
  } catch {
    return null
  }
}

// localStorage as an external store: no hydration mismatch, and logout in one tab logs out the others.
const subscribe = (cb: () => void) => (window.addEventListener("storage", cb), () => window.removeEventListener("storage", cb))
const readPubkey = () => localStorage.getItem(STORAGE_KEY)
function writePubkey(pubkey: string | null) {
  if (pubkey) localStorage.setItem(STORAGE_KEY, pubkey)
  else localStorage.removeItem(STORAGE_KEY)
  window.dispatchEvent(new StorageEvent("storage"))
}

/** NIP-07 extensions inject window.nostr shortly after load. */
export async function waitForNostr(timeoutMs = 3000) {
  for (let t = 0; !window.nostr && t < timeoutMs; t += 100) await new Promise((r) => setTimeout(r, 100))
  if (!window.nostr) throw new Error("No NIP-07 extension found")
  return window.nostr
}

type NostrContext = {
  /** undefined while hydrating, null when logged out */
  pubkey: string | null | undefined
  /** the app asks for a login (ALLOWED_PUBKEYS is set); undefined until the server answers */
  required: boolean | undefined
  profile: Profile | null
  login: () => Promise<void>
  logout: () => void
}

const Ctx = createContext<NostrContext | null>(null)

export function NostrProvider({ children }: { children: React.ReactNode }) {
  const pubkey = useSyncExternalStore(subscribe, readPubkey, () => undefined)
  const [required, setRequired] = useState<boolean>()
  useEffect(() => void loginRequired().then(setRequired, () => {}), [])
  const [fetched, setFetched] = useState<{ pubkey: string; data: Profile } | null>(null)
  const cached = useMemo(() => (pubkey ? readProfile(pubkey) : null), [pubkey])

  useEffect(() => {
    if (!pubkey) return
    const pool = new SimplePool()
    // every relay's answer, newest kind 0 wins (pool.get would take whichever relay answers first)
    pool
      .querySync(RELAYS, { kinds: [0], authors: [pubkey] }, { maxWait: 5000 })
      .then((events) => {
        const e = events.sort((a, b) => b.created_at - a.created_at)[0]
        const data = e && pickProfile(e.content)
        if (!data || (readProfile(pubkey)?.createdAt ?? 0) > e.created_at) return
        localStorage.setItem(profileKey(pubkey), JSON.stringify({ createdAt: e.created_at, data } satisfies CachedProfile))
        setFetched({ pubkey, data })
      })
      .catch(() => {})
    return () => pool.close(RELAYS)
  }, [pubkey])
  const profile = (fetched && fetched.pubkey === pubkey ? fetched.data : null) ?? cached?.data ?? null

  const login = useCallback(async () => {
    try {
      const nostr = await waitForNostr(500)
      writePubkey(await nostr.getPublicKey())
      requestNotifications()
    } catch {
      toast.error("No Nostr extension found", { description: "Install a NIP-07 extension like Alby or nos2x, then try again." })
    }
  }, [])

  const logout = useCallback(() => writePubkey(null), [])

  return (
    <Ctx.Provider value={{ pubkey, required, profile, login, logout }}>
      {children}
    </Ctx.Provider>
  )
}

export function useNostr() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useNostr must be used inside NostrProvider")
  return ctx
}
