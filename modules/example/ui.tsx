"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { http, storage, ui, useModule, wallet } from "@/lib/modules/sdk"
import type { ModuleInit } from "@/lib/modules/types"

const hex = (text: string) => Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("")
const failed = (e: unknown) => ui.toast((e as Error).message)

export default function Example({ view }: { view: string }) {
  const m = useModule()
  if (!m) return null
  if (view === "ticker") return <Ticker m={m} />
  if (view === "self") return <SelfPayment m={m} />
  return <Playground m={m} />
}

/** Dashboard card: the tip (the wallet pushes every block) and the BTC price, fetched through the wallet's server. */
function Ticker({ m }: { m: ModuleInit }) {
  const [usd, setUsd] = useState<number | null>(null)
  useEffect(() => {
    http
      .fetch(String(m.config.priceApi))
      .then((r) => setUsd(JSON.parse(r.body).USD ?? null))
      .catch(() => setUsd(null))
  }, [m.config.priceApi, m.info.height])
  return (
    <Card>
      <CardHeader>
        <CardDescription>{m.info.label} tip</CardDescription>
        <CardTitle className="font-mono text-2xl tabular-nums">#{m.info.height.toLocaleString()}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        BTC {usd ? `$${usd.toLocaleString()}` : "—"} · {m.info.fees ? `${m.info.fees.halfHourFee} sat/vB` : "no fee estimates"}
      </CardContent>
    </Card>
  )
}

/** Every call of the module API, one button each. */
function Playground({ m }: { m: ModuleInit }) {
  const [out, setOut] = useState<unknown>(m.info)
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => void storage.get<number>("count").then((c) => setCount(c ?? 0)), [])
  const show = (p: Promise<unknown>) => p.then(setOut, failed)
  const bump = async () => {
    const next = (count ?? 0) + 1
    await storage.set("count", next)
    setCount(next)
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Module API playground</CardTitle>
        <CardDescription>
          {m.module.name} on {m.info.label} · permissions: {m.permissions.join(", ")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => show(wallet.info())}>wallet.info</Button>
          <Button variant="outline" onClick={() => show(wallet.balance())}>wallet.balance</Button>
          <Button variant="outline" onClick={() => show(wallet.receive())}>wallet.receive</Button>
          <Button variant="outline" onClick={() => show(http.fetch("https://mempool.space/api/blocks/tip/height"))}>http.fetch</Button>
          <Button variant="outline" onClick={() => show(http.fetch("https://example.com/"))}>http.fetch (not allowed)</Button>
          <Button variant="outline" onClick={bump}>storage: {count ?? "…"}</Button>
          <Button variant="outline" onClick={() => ui.toast("Hello from a module")}>ui.toast</Button>
        </div>
        <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">{JSON.stringify(out, null, 2)}</pre>
      </CardContent>
    </Card>
  )
}

/** A transaction type on the Send page: pay yourself, with an optional OP_RETURN message. */
function SelfPayment({ m }: { m: ModuleInit }) {
  const [amount, setAmount] = useState("1000")
  const [message, setMessage] = useState("")
  const [txid, setTxid] = useState<string | null>(null)
  const send = async () => {
    try {
      const { address } = await wallet.receive()
      const res = await wallet.send({
        outputs: [{ address, amount: Number(amount) }],
        ...(message && { data: hex(message) }),
        memo: "Payment to your own next receive address",
      })
      setTxid(res.txid)
    } catch (e) {
      failed(e)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pay yourself</CardTitle>
        <CardDescription>Sends {m.info.unit} to your next receive address, optionally with an on-chain message.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (sats)" />
        <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message (optional, OP_RETURN)" />
        <Button onClick={send} disabled={!/^\d+$/.test(amount)}>
          Review in the wallet
        </Button>
        {txid && <p className="font-mono text-xs break-all text-muted-foreground">Sent: {txid}</p>}
      </CardContent>
    </Card>
  )
}
