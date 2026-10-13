"use client"

import { useEffect, useState } from "react"
import { CheckCircle2Icon, CopyIcon, ExternalLinkIcon, Loader2Icon, MousePointerClickIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { http, storage, ui, useModule, wallet } from "@/lib/modules/sdk"
import type { ModuleInit } from "@/lib/modules/types"
import type { Faucet, FaucetConfig } from "./manifest"

/** sent: paid through its API (txid known) · opened: its site was opened, watching the balance · arrived: the balance grew */
type Claim = { faucet: string; at: number; address: string; status: "sent" | "opened" | "arrived"; txid?: string; amount?: number; before?: number }
type Info = { payout_amount: string; claim_window_hours: number; available: boolean; balance: string }

const WATCH_MS = 30 * 60_000 // how long an opened site is watched for its payment
const sats = (coins: string) => Math.round(Number(coins) * 1e8)
const ago = (ms: number) => (ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)} h ago` : `${Math.round(ms / 86_400_000)} d ago`)
const waitFor = (ms: number) => (ms < 3_600_000 ? `${Math.ceil(ms / 60_000)} min` : `${Math.ceil(ms / 3_600_000)} h`)
const host = (url: string) => new URL(url).host
// event handlers stamp claims with the time (a helper keeps the React compiler from reading it as render code)
const stamp = () => Date.now()

export default function FaucetModule() {
  const m = useModule()
  return m && <Faucets m={m} />
}

function Faucets({ m }: { m: ModuleInit }) {
  const { faucets, notice } = m.config as FaucetConfig
  const unit = m.info.unit
  const [address, setAddress] = useState<string | null>(null)
  const [history, setHistory] = useState<Claim[] | null>(null)
  const [info, setInfo] = useState<Record<string, Info>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const note = (name: string, text: string) => setNotes((n) => ({ ...n, [name]: text }))

  // the next unused address moves on once a payment lands: refresh it every block
  useEffect(() => void wallet.receive().then((r) => setAddress(r.address), (e: Error) => ui.toast(e.message)), [m.info.height])
  useEffect(() => void storage.get<Claim[]>("history").then((h) => setHistory(h ?? [])), [])
  useEffect(() => {
    for (const f of faucets)
      if (f.api)
        http.fetch(f.api.info).then(
          (r) => {
            const i = (JSON.parse(r.body).faucets as (Info & { network: string })[] | undefined)?.find((x) => x.network === f.api!.network)
            if (i) setInfo((all) => ({ ...all, [f.name]: i }))
          },
          () => {},
        )
  }, [faucets])

  const save = (next: Claim[]) => {
    const kept = next.slice(0, 30)
    setNow(stamp()) // cooldowns count from the claim just made
    setHistory(kept)
    void storage.set("history", kept)
  }

  // an opened site pays whenever the user finishes there: watch the balance for a while
  const watching = history?.find((c) => c.status === "opened" && now - c.at < WATCH_MS)
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(tick)
  }, [])
  useEffect(() => {
    if (!watching || !history) return
    wallet.balance().then(({ confirmed, unconfirmed }) => {
      const total = confirmed + unconfirmed
      if (total <= (watching.before ?? total)) return
      save(history.map((c) => (c === watching ? { ...c, status: "arrived", amount: total - c.before! } : c)))
      ui.toast(`${watching.faucet}: payment arrived`)
    }, () => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-checked every tick and every block
  }, [now, m.info.height, watching?.at])

  const claim = async (f: Faucet) => {
    if (!address || !f.api || !history) return
    setBusy(f.name)
    try {
      const res = await http.fetch(f.api.claim, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ network: f.api.network, address }) })
      const body = JSON.parse(res.body) as { ok: boolean; txid?: string; amount?: string; message?: string; retry_after?: number }
      if (body.ok) {
        save([{ faucet: f.name, at: stamp(), address, status: "sent", txid: body.txid, amount: body.amount ? sats(body.amount) : undefined }, ...history])
        note(f.name, `Sent ${body.amount ?? ""} ${unit}`)
      } else {
        const why = body.retry_after ? ` Try again in ${waitFor(body.retry_after * 1000)}.` : res.status >= 500 ? ` ${f.name} is failing on its side right now: try another faucet.` : ""
        note(f.name, `${body.message ?? `Error ${res.status}`}${why}`)
      }
    } catch (e) {
      note(f.name, (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // copy first: opening the site moves the focus away, and the clipboard needs it
  const open = async (f: Faucet) => {
    if (!address || !history) return
    await ui.copy(address).catch(() => {})
    window.open(f.url.replace("{address}", encodeURIComponent(address)), "_blank", "noopener")
    const { confirmed, unconfirmed } = await wallet.balance()
    save([{ faucet: f.name, at: stamp(), address, status: "opened", before: confirmed + unconfirmed }, ...history])
    note(f.name, f.url.includes("{address}") ? "Opened with your address filled in: finish there." : "Opened, your address is copied: paste it there and finish.")
  }

  const lastPaid = (f: Faucet) => history?.find((c) => c.faucet === f.name && c.status === "sent")
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{m.info.label} faucets</CardTitle>
          <CardDescription>
            Free {unit} for testing, paid to your next receive address. Faucets with an API pay in one click; the others open their site, where you
            solve its captcha (or log in).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {notice && <p className="rounded-lg border border-amber-500/40 p-3 text-sm text-amber-700 dark:text-amber-400">{notice}</p>}
          <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs sm:text-sm">{address ?? "…"}</code>
            <Button size="sm" variant="ghost" disabled={!address} onClick={() => address && ui.copy(address).catch((e: Error) => ui.toast(e.message))}>
              <CopyIcon /> Copy
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        {faucets.map((f) => {
          const i = info[f.name]
          const paid = lastPaid(f)
          const wait = paid && i ? paid.at + i.claim_window_hours * 3_600_000 - now : 0
          return (
            <Card key={f.name}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {f.name}
                  {f.api ? (
                    <Badge variant="outline" className="gap-1 text-emerald-600 dark:text-emerald-400">
                      <MousePointerClickIcon /> One click
                    </Badge>
                  ) : (
                    <Badge variant="outline">{f.gate === "login" ? "Login on its site" : "Captcha on its site"}</Badge>
                  )}
                </CardTitle>
                <CardDescription>
                  {host(f.url)}
                  {i && ` · ${i.payout_amount} ${unit} every ${i.claim_window_hours} h · ${i.available ? `holds ${Number(i.balance).toLocaleString()} ${unit}` : "empty or paused"}`}
                  {f.note && ` · ${f.note}`}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {notes[f.name] && <p className="text-sm text-muted-foreground">{notes[f.name]}</p>}
                <div className="flex flex-wrap gap-2">
                  {f.api && (
                    <Button disabled={!address || busy === f.name || wait > 0 || i?.available === false} onClick={() => claim(f)}>
                      {busy === f.name && <Loader2Icon className="animate-spin" />}
                      {wait > 0 ? `Next claim in ${waitFor(wait)}` : "Claim"}
                    </Button>
                  )}
                  <Button variant={f.api ? "outline" : "default"} disabled={!address} onClick={() => open(f)}>
                    <ExternalLinkIcon /> {f.api ? "Open site" : "Open faucet"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {!!history?.length && (
        <Card>
          <CardHeader>
            <CardTitle>Claims</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              {history.map((c) => {
                const waiting = c.status === "opened" && now - c.at < WATCH_MS
                return (
                  <li key={c.at} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      {c.status === "opened" ? (
                        waiting ? <Loader2Icon className="size-4 animate-spin text-muted-foreground" /> : <span className="size-4" />
                      ) : (
                        <CheckCircle2Icon className="size-4 text-emerald-600 dark:text-emerald-400" />
                      )}
                      {c.faucet}
                      <span className="text-muted-foreground">{ago(now - c.at)}</span>
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {c.status === "opened"
                        ? waiting
                          ? "waiting for the payment…"
                          : "no payment seen"
                        : `${c.amount ? `+${(c.amount / 1e8).toFixed(8)} ${unit}` : c.status}`}
                      {c.txid && (
                        <a className="ml-2 underline" href={`${m.info.explorer}/tx/${c.txid}`} target="_blank" rel="noreferrer">
                          tx
                        </a>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
