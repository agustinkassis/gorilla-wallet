"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useNostr } from "@/components/nostr-provider"
import { readUnit } from "@/components/units"
import { authHeaders } from "@/lib/api"
import { playChime, systemNotify } from "@/lib/notify"
import {
  CHAINS,
  DEFAULT_SETTINGS,
  amountText,
  deriveAddresses,
  hasData,
  familyOf,
  syncedChains,
  txEvents,
  type Account,
  type Chain,
  type Family,
  type Settings,
  type Snapshot,
  type StreamMessage,
  type TxEvent,
  type WalletInfo,
} from "@/lib/wallet"

type ChainSnapshots = Partial<Record<Chain, Snapshot>>
type StreamState = {
  /** null until the server sent the list */
  wallets: WalletInfo[] | null
  /** walletId → chain → snapshot */
  all: Record<string, ChainSnapshots>
  settings: Settings
  /** true while the SSE stream is open */
  live: boolean
  error?: string
  /** last incoming payment, drives the balance-card animation (id changes per event) */
  flash?: { id: string; walletId: string; chain: Chain; amount: number }
}

const EMPTY: StreamState = { wallets: null, all: {}, settings: DEFAULT_SETTINGS, live: false }

// Selected wallet lives in localStorage (per browser), shared across tabs like the login.
const SELECTED_KEY = "gorilla-wallet:wallet"
const subscribeSelected = (cb: () => void) => (window.addEventListener("storage", cb), () => window.removeEventListener("storage", cb))
const readSelected = () => localStorage.getItem(SELECTED_KEY)

type WalletContext = {
  /** the wallet list has arrived (an empty list means: show the create/import flow) */
  ready: boolean
  wallets: WalletInfo[]
  /** the selected wallet */
  wallet?: WalletInfo
  selectWallet: (id: string) => void
  watchOnly: boolean
  /** the selected network (navbar) */
  chain: Chain
  family: Family
  /** its replay pair while synced along (Bitcoin ↔ Blake): replay tools and the OP_RETURN guard */
  pair?: Chain
  /** the selected wallet's account on the network's family; undefined until enabled (see Gate) */
  account?: Account
  xpub?: string
  path?: string
  /** master key fingerprint, for PSBT bip32Derivation */
  fingerprint?: number
  /** first receive addresses, derived in the browser from the xpub */
  addresses: string[]
  /** the selected wallet's snapshots: the selected network and its replay pair */
  snapshots: ChainSnapshots
  /** every wallet's snapshots (wallet switcher balances) */
  allSnapshots: Record<string, ChainSnapshots>
  /** chains shown: the selected network */
  chains: Chain[]
  settings: Settings
  live: boolean
  error?: string
  flash?: StreamState["flash"]
  retry: () => void
}

const Ctx = createContext<WalletContext | null>(null)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Fatal extends Error {}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const { pubkey, required } = useNostr()
  const [state, setState] = useState<StreamState & { owner?: string | null }>(EMPTY)
  const [attempt, setAttempt] = useState(0)
  const router = useRouter()
  // Latest loaded snapshot per wallet+chain, read outside setState so notifications fire exactly once per event.
  const latest = useRef<Record<string, Snapshot>>({})
  const settings = useRef(DEFAULT_SETTINGS)
  const walletNames = useRef<WalletInfo[]>([])

  useEffect(() => {
    if (required === undefined || (required && !pubkey)) return
    const ac = new AbortController()
    latest.current = {}
    const set = (patch: Partial<StreamState> | ((s: StreamState) => Partial<StreamState>)) =>
      !ac.signal.aborted && setState((s) => ({ ...s, owner: pubkey, ...(typeof patch === "function" ? patch(s) : patch) }))

    const notify = (walletId: string, { kind, chain, tx }: TxEvent) => {
      const many = walletNames.current.length > 1
      const name = walletNames.current.find((w) => w.id === walletId)?.name
      const amount = `+${amountText(tx.amount, chain, readUnit())}`
      const confirmed = tx.height > 0
      const what = kind === "confirmed" ? `${CHAINS[chain].label} payment confirmed` : `${CHAINS[chain].label} payment received`
      const title = many && name ? `${name}: ${what}` : what
      const body = kind === "confirmed" || !confirmed ? `${amount} · ${confirmed ? "1 confirmation" : "pending confirmation"}` : `${amount} · confirmed`
      const view = {
        label: "View",
        onClick: () => {
          localStorage.setItem(SELECTED_KEY, walletId)
          window.dispatchEvent(new StorageEvent("storage"))
          router.push("/transactions")
        },
      }
      if (kind === "received") {
        toast.success(title, { description: body, action: view })
        if (settings.current.sound) playChime()
        set({ flash: { id: `${walletId}:${chain}:${tx.txid}`, walletId, chain, amount: tx.amount } })
      } else {
        toast.info(title, { description: body, action: view })
      }
      if (settings.current.notifications) systemNotify(title, body)
    }

    const onMessage = (msg: StreamMessage) => {
      if (msg.type === "wallets") {
        walletNames.current = msg.wallets
        const ids = new Set(msg.wallets.map((w) => w.id))
        return set((s) => ({ wallets: msg.wallets, all: Object.fromEntries(Object.entries(s.all).filter(([id]) => ids.has(id))) }))
      }
      if (msg.type === "settings") {
        settings.current = msg.settings
        return set({ settings: msg.settings })
      }
      const { walletId, chain } = msg.snapshot
      const key = `${walletId}:${chain}`
      const events = txEvents(latest.current[key], msg.snapshot)
      // Keep the last loaded view as baseline (a restarted server first sends an empty snapshot).
      if (hasData(msg.snapshot)) latest.current[key] = msg.snapshot
      set((s) => ({ all: { ...s.all, [walletId]: { ...s.all[walletId], [chain]: msg.snapshot } } }))
      events.forEach((e) => notify(walletId, e))
    }

    ;(async () => {
      for (let delay = 2_000; !ac.signal.aborted; delay = Math.min(delay * 2, 60_000)) {
        try {
          const url = `${location.origin}/api/stream`
          let headers
          try {
            headers = await authHeaders(url, "GET")
          } catch {
            throw new Fatal("Couldn't sign the login request. Unlock your Nostr extension and retry.")
          }
          const res = await fetch(url, { headers, signal: ac.signal })
          if (res.status === 403) throw new Fatal(required ? "This Nostr account is not authorized to open this wallet." : (await res.json()).error)
          if (res.status === 401) throw new Fatal("Nostr authentication failed. Check your system clock and retry.")
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

          set({ live: true, error: undefined })
          delay = 2_000
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
          let buf = ""
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buf += value
            let end
            while ((end = buf.indexOf("\n\n")) >= 0) {
              const data = buf
                .slice(0, end)
                .split("\n")
                .filter((l) => l.startsWith("data: "))
                .map((l) => l.slice(6))
                .join("\n")
              buf = buf.slice(end + 2)
              if (data) onMessage(JSON.parse(data))
            }
          }
        } catch (e) {
          if (ac.signal.aborted) return
          if (e instanceof Fatal) return set({ live: false, error: e.message })
        }
        set({ live: false })
        await sleep(delay)
      }
    })()

    return () => ac.abort()
  }, [pubkey, required, attempt, router])

  const selectedId = useSyncExternalStore(subscribeSelected, readSelected, () => null)
  const selectWallet = useCallback((id: string) => {
    localStorage.setItem(SELECTED_KEY, id)
    window.dispatchEvent(new StorageEvent("storage"))
  }, [])

  const value = state.owner === pubkey ? state : EMPTY
  const wallets = value.wallets ?? []
  const wallet = wallets.find((w) => w.id === selectedId) ?? wallets[0]
  const chain = value.settings.chain
  const family = familyOf(chain)
  const synced = syncedChains(chain)
  const pair = synced[1]
  const account = wallet?.accounts[family]
  // switching networks hides the previous one at once, even before the server drops it
  const snapshots = Object.fromEntries(Object.entries(wallet ? (value.all[wallet.id] ?? {}) : {}).filter(([c]) => synced.includes(c as Chain)))
  const addresses = useMemo(() => (account ? deriveAddresses(account.xpub, family) : []), [account, family])

  return (
    <Ctx.Provider
      value={{
        ready: value.wallets !== null,
        wallets,
        wallet,
        selectWallet,
        watchOnly: !!wallet?.watchOnly,
        chain,
        family,
        pair,
        account,
        xpub: account?.xpub,
        path: account?.path,
        fingerprint: account?.fingerprint,
        addresses,
        snapshots,
        allSnapshots: value.all,
        chains: [chain],
        settings: value.settings,
        live: value.live,
        error: value.error,
        flash: value.flash && value.flash.walletId === wallet?.id ? value.flash : undefined,
        retry: () => (setState(EMPTY), setAttempt((a) => a + 1)),
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function useWallet() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider")
  return ctx
}
