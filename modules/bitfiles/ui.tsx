"use client"

import { useEffect, useRef, useState } from "react"
import { bytesToHex, hexToBytes } from "@bitfiles/bpub"
import {
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  FileIcon,
  FileUpIcon,
  HistoryIcon,
  Loader2Icon,
  RotateCcwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { http, storage, ui, useModule, wallet } from "@/lib/modules/sdk"
import type { ModuleInit } from "@/lib/modules/types"
import { cn } from "@/lib/utils"
import type { BitfilesConfig } from "./manifest"
import { MAX_OUTPUTS, OWNER_SATS, costs, draft, firstOutputAddress, fundingOutputs, newKey, restore, reveal, type Draft } from "./inscribe"

/**
 * The upload in progress, saved before anything is paid so leaving the page never strands it: its throwaway key (all
 * that can spend the funding outputs) and its stream (saved in `stream.<i>` chunks) rebuild it when the page opens again.
 * funding: the wallet was asked to pay (maybe it did) · funded: paid by `fundingTxid` · revealing: reveal `revealTxid` signed and sent
 */
type Pending = {
  key: string
  ownerAddress: string
  feeRate: number
  chunks: number
  name: string
  stage: "funding" | "funded" | "revealing"
  fundingTxid?: string
  revealTxid?: string
  at: number
}
type Upload = { txid: string; name: string; mime: string; size: number; at: number }
type Picked = { preview: string | null; draft: Draft; ownerAddress: string }
type Step = "encoding" | "restoring" | "ready" | "funding" | "checking" | "revealing" | "done" | "failed"
type Speed = "economyFee" | "hourFee" | "halfHourFee" | "fastestFee"

const SPEEDS: { id: Speed; label: string }[] = [
  { id: "economyFee", label: "Economy" },
  { id: "hourFee", label: "1 hour" },
  { id: "halfHourFee", label: "30 min" },
  { id: "fastestFee", label: "Fastest" },
]
/** past this the stream can't fit even compressed, so don't spend seconds encoding it */
const MAX_FILE = 4 * 1024 * 1024
/** stream bytes per storage value: 60 KB of hex, under the 64 KB limit */
const CHUNK = 30_000
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`)
const sats = (n: number) => `${n.toLocaleString()} sats`
// event handlers stamp uploads with the time (a helper keeps the React compiler from reading it as render code)
const stamp = () => Date.now()
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
const range = (n: number) => Array.from({ length: n }, (_, i) => i)
const pickedOf = (d: Draft, ownerAddress: string): Picked => ({
  preview: d.mime.startsWith("image/") ? URL.createObjectURL(new Blob([d.content as Uint8Array<ArrayBuffer>], { type: d.mime })) : null,
  draft: d,
  ownerAddress,
})

export default function Bitfiles() {
  const m = useModule()
  return m && <Uploader m={m} />
}

function Uploader({ m }: { m: ModuleInit }) {
  const { api, viewer } = m.config as BitfilesConfig
  const [speed, setSpeed] = useState<Speed>("halfHourFee")
  const [picked, setPicked] = useState<Picked | null>(null)
  const [step, setStep] = useState<Step | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [txid, setTxid] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [uploads, setUploads] = useState<Upload[]>([])
  const [drag, setDrag] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const feeRate = Math.max(1, m.info.fees?.[speed] ?? 1)

  // revoke the preview's blob URL once it's replaced
  useEffect(() => () => void (picked?.preview && URL.revokeObjectURL(picked.preview)), [picked])

  const save = async (p: Pending | null) => {
    await storage.set("pending", p)
    setPending(p)
    return p!
  }
  const saveStream = async (stream: Uint8Array) => {
    const n = Math.ceil(stream.length / CHUNK)
    for (const i of range(n)) await storage.set(`stream.${i}`, bytesToHex(stream.subarray(i * CHUNK, (i + 1) * CHUNK)))
    return n
  }
  const loadStream = async (n: number) => {
    const parts = await Promise.all(range(n).map((i) => storage.get<string>(`stream.${i}`)))
    if (parts.some((x) => x === null)) throw new Error("The saved upload is incomplete")
    return hexToBytes(parts.join(""))
  }
  const forget = async (p: Pending) => {
    await Promise.all(range(p.chunks).map((i) => storage.set(`stream.${i}`, null)))
    await save(null)
  }

  const get = async (path: string) => {
    const r = await http.fetch(`${api}${path}`)
    if (r.status !== 200) throw new Error(`${new URL(api).host} answered ${r.status}: ${r.body.slice(0, 160)}`)
    return r.body.trim()
  }
  /** the wallet may broadcast through another server: wait for the funding tx to reach the one the reveal goes to */
  const fundingHex = async (id: string) => {
    for (let i = 0; ; i++) {
      try {
        return await get(`/api/tx/${id}/hex`)
      } catch (e) {
        if (i >= 23) throw e
        await pause(5000)
      }
    }
  }
  /** the tx paying the first data output, if any: a few tries, as a just-signed funding may still be propagating */
  const findFunding = async (d: Draft) => {
    const address = firstOutputAddress(d)
    for (let i = 0; i < 4; i++) {
      const txs = JSON.parse(await get(`/api/address/${address}/txs`)) as { txid: string; vout: { scriptpubkey_address?: string }[] }[]
      const hit = txs.find((t) => t.vout.some((o) => o.scriptpubkey_address === address))
      if (hit) return hit.txid
      await pause(4000)
    }
    return null
  }

  const complete = async (p: Pending, d: Draft, revealTxid: string) => {
    const prev = (await storage.get<Upload[]>("uploads")) ?? []
    const next = [{ txid: revealTxid, name: d.filename, mime: d.mime, size: d.content.length, at: stamp() }, ...prev.filter((u) => u.txid !== revealTxid)].slice(0, 50)
    await storage.set("uploads", next)
    setUploads(next)
    await forget(p)
    setTxid(revealTxid)
    setNote(null)
    setStep("done")
  }

  /** Take an upload from its saved stage to done: find its funding, sign and send the reveal. Safe to repeat. */
  const advance = async (start: Pending, d: Draft) => {
    let p = start
    setError(null)
    try {
      if (p.stage === "funding") {
        setStep("checking")
        setNote("Checking whether the funding transaction went out…")
        const funded = await findFunding(d)
        if (!funded) {
          // never paid: nothing to lose, the user funds it again from here
          setNote(null)
          return setStep("ready")
        }
        p = await save({ ...p, stage: "funded", fundingTxid: funded })
      }
      setStep("revealing")
      if (p.revealTxid && (await http.fetch(`${api}/api/tx/${p.revealTxid}/status`)).status === 200) return await complete(p, d, p.revealTxid)
      setNote("Waiting for the funding transaction to reach the explorer…")
      const hex = await fundingHex(p.fundingTxid!)
      setNote("Signing and broadcasting the reveal…")
      const signed = await reveal(d, hex, p.ownerAddress, p.feeRate)
      p = await save({ ...p, stage: "revealing", revealTxid: signed.txid })
      const r = await http.fetch(`${api}/api/tx`, { method: "POST", headers: { "content-type": "text/plain" }, body: signed.rawHex })
      // a repeated broadcast (resumed after the first one went out) is fine
      // Knots' default -rejectbpub filter: no relay through this server until a node without it is configured
      if (r.status !== 200 && /txn-datacarrier-nonstandard/.test(r.body))
        throw new Error(`${new URL(api).host} doesn't relay bpub reveals (its node filters them). Your upload is saved and finishes once a relay that accepts bpub is available.`)
      if (r.status !== 200 && !/already/i.test(r.body)) throw new Error(`Broadcast refused: ${r.body.slice(0, 200)}`)
      await complete(p, d, signed.txid)
    } catch (e) {
      setError((e as Error).message)
      setNote(null)
      setStep("failed")
    }
  }

  // opening the page picks up an interrupted upload where it stopped
  useEffect(() => {
    void (async () => {
      setUploads((await storage.get<Upload[]>("uploads")) ?? [])
      const p = await storage.get<Pending>("pending")
      if (!p) return
      // saved before uploads kept their stream (never funded): nothing to resume
      if (!p.chunks) return void storage.set("pending", null)
      setPending(p)
      setStep("restoring")
      setNote(`Restoring ${p.name}…`)
      try {
        const d = await restore(await loadStream(p.chunks), hexToBytes(p.key), p.ownerAddress)
        setPicked(pickedOf(d, p.ownerAddress))
        await advance(p, d)
      } catch (e) {
        setError((e as Error).message)
        setNote(null)
        setStep("failed")
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, [])

  const pick = async (file: File) => {
    if (pending) return ui.toast(`Finishing ${pending.name} first`)
    setTxid(null)
    setError(null)
    if (file.size > MAX_FILE) return ui.toast(`${file.name} is ${kb(file.size)}: bpub fits about ${kb(MAX_OUTPUTS * 434)} after compression`)
    setStep("encoding")
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const ownerAddress = (await wallet.receive()).address
      await pause(0) // let "Encoding…" paint: grinding the pubkeys blocks for a moment on big files
      const d = await draft(bytes, { mime: file.type || "application/octet-stream", filename: file.name, key: newKey(), ownerAddress })
      setPicked(pickedOf(d, ownerAddress))
      setStep("ready")
    } catch (e) {
      setPicked(null)
      setStep(null)
      ui.toast((e as Error).message)
    }
  }

  const upload = async () => {
    if (!picked) return
    const { draft: d, ownerAddress } = picked
    // one upload at a time: replacing a saved one would strand its outputs
    if (pending && pending.key !== bytesToHex(d.key)) return ui.toast(`Finish or forget ${pending.name} first`)
    setStep("funding")
    setNote("Review and sign the funding transaction in the wallet")
    // key and stream are saved before anything is paid to them
    const chunks = pending?.chunks ?? (await saveStream(d.stream))
    const p = await save({ key: bytesToHex(d.key), ownerAddress, feeRate, chunks, name: d.filename, stage: "funding", at: stamp() })
    let funded: string
    try {
      funded = (await wallet.send({ outputs: fundingOutputs(d, feeRate), feeRate, memo: `Store ${d.filename} (${kb(d.content.length)}) on Blake with bpub: ${d.scripts.length} data outputs and a ${OWNER_SATS.toLocaleString()} sat ownership output.` })).txid
    } catch (e) {
      // declined: nothing was paid
      await forget(p)
      setNote(null)
      setStep("ready")
      return ui.toast((e as Error).message)
    }
    await advance(await save({ ...p, stage: "funded", fundingTxid: funded }), d)
  }

  // the sandbox has no confirm(): a saved upload is forgotten after an inline "are you sure"
  const discard = () => (pending ? setForgetting(true) : reset())
  const forgetNow = async () => {
    if (pending) await forget(pending)
    reset()
  }

  const reset = () => {
    setForgetting(false)
    setPicked(null)
    setStep(null)
    setNote(null)
    setTxid(null)
    setError(null)
  }

  const busy = step === "encoding" || step === "restoring" || step === "funding" || step === "checking" || step === "revealing"
  const c = picked && costs(picked.draft.scripts.length, feeRate)
  const link = txid && `${viewer}/${txid}`

  return (
    <div className="flex flex-col gap-4 p-1">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileUpIcon className="size-5 text-violet-600 dark:text-violet-400" /> Store a file on Blake
          </CardTitle>
          <CardDescription>
            Written into Blake transactions with the <span className="font-medium text-foreground">bpub</span> protocol: permanent, uncensorable, and shown on{" "}
            <span className="font-medium text-foreground">bitfiles.io</span>. Up to about {kb(MAX_OUTPUTS * 434)} after compression.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {pending && step === "ready" && (
            <p className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />
              Restored your upload of {pending.name}: it was never funded, so nothing was paid. Fund it to continue.
            </p>
          )}

          {!picked || step === "encoding" || step === "restoring" ? (
            <label
              onDragOver={(e) => {
                e.preventDefault()
                setDrag(true)
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDrag(false)
                const f = e.dataTransfer.files[0]
                if (f && !busy) void pick(f)
              }}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
                drag ? "border-violet-500 bg-violet-500/10" : "border-muted-foreground/25 hover:border-violet-500/60 hover:bg-muted/40",
                busy && "pointer-events-none opacity-70",
              )}
            >
              {busy ? <Loader2Icon className="size-8 animate-spin text-violet-500" /> : <FileUpIcon className="size-8 text-muted-foreground" />}
              <span className="font-medium">{step === "encoding" ? "Encoding…" : step ? (note ?? "Working…") : "Drop a file here, or click to choose"}</span>
              <span className="text-xs text-muted-foreground">Images, text, audio… anything up to ~{kb(MAX_OUTPUTS * 434)} compressed</span>
            </label>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-4 rounded-xl border p-3">
                <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local blob preview */}
                  {picked.preview ? <img src={picked.preview} alt="" className="size-full object-cover" /> : <FileIcon className="size-8 text-muted-foreground" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{picked.draft.filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {picked.draft.mime} · {kb(picked.draft.content.length)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <Badge variant="secondary">{picked.draft.compressed ? `compressed to ${kb(picked.draft.streamBytes)}` : `${kb(picked.draft.streamBytes)} on chain`}</Badge>
                    <Badge variant="secondary">{picked.draft.scripts.length} outputs</Badge>
                  </div>
                </div>
                {!busy && step !== "done" && (
                  <Button size="icon" variant="ghost" aria-label="Remove file" onClick={discard}>
                    <XIcon />
                  </Button>
                )}
              </div>

              {forgetting && pending && (
                <div className="flex flex-col gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm">
                  <p>
                    {pending.stage === "funding"
                      ? `Forget ${pending.name}? Nothing was paid for it.`
                      : `Forget ${pending.name}? Its funding is already paid, and only this saved upload can spend it back: those sats are lost.`}
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="destructive" onClick={forgetNow}>
                      Forget it
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setForgetting(false)}>
                      Keep it
                    </Button>
                  </div>
                </div>
              )}

              {step === "ready" && c && (
                <>
                  <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium">Speed</span>
                    <div className="grid grid-cols-4 gap-1.5">
                      {SPEEDS.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => setSpeed(s.id)}
                          className={cn("rounded-lg border px-2 py-1.5 text-xs transition-colors", speed === s.id ? "border-violet-500 bg-violet-500/10 font-medium" : "hover:bg-muted")}
                        >
                          {s.label}
                          <span className="block font-mono text-[11px] text-muted-foreground">{Math.max(1, m.info.fees?.[s.id] ?? 1)} sat/vB</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <dl className="flex flex-col gap-1 rounded-lg bg-muted/50 p-3 text-sm">
                    <Row label="Funding fee (estimate)" value={`≈ ${sats(c.fundingFee)}`} />
                    <Row label="Reveal fee" value={sats(c.revealFee)} />
                    <Row label="Ownership output" value={sats(OWNER_SATS)} hint="v5 deed: proves this file is yours" />
                    <Row label="Refunded to your wallet" value={`+ ${sats(c.refund)}`} muted />
                    <div className="mt-1 flex justify-between border-t pt-2 font-medium">
                      <dt>Total cost</dt>
                      <dd className="font-mono">≈ {sats(c.fundingFee + c.revealFee + OWNER_SATS)}</dd>
                    </div>
                  </dl>
                  <Button size="lg" onClick={upload}>
                    <FileUpIcon /> {pending ? "Fund upload" : "Upload to Blake"}
                  </Button>
                </>
              )}

              {step && step !== "ready" && <Progress step={step} note={note} failedAt={!pending ? 0 : pending.stage === "funding" ? 1 : 2} />}

              {step === "failed" && (
                <div className="flex flex-col gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm">
                  <p className="break-words text-rose-700 dark:text-rose-300">{error}</p>
                  <p className="text-muted-foreground">The upload is saved: retry now, or open this page later and it carries on by itself.</p>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => pending && void advance(pending, picked.draft)}>
                      <RotateCcwIcon /> Retry
                    </Button>
                    <Button size="sm" variant="ghost" onClick={discard}>
                      Forget this upload
                    </Button>
                  </div>
                </div>
              )}

              {step === "done" && link && (
                <div className="flex flex-col gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4">
                  <p className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2Icon className="size-5" /> Your file is on Blake
                  </p>
                  <LinkBox link={link} />
                  <p className="text-xs text-muted-foreground">bitfiles.io shows it once its indexer sees the reveal (usually within a block).</p>
                  <Button variant="outline" className="self-start" onClick={reset}>
                    Upload another file
                  </Button>
                </div>
              )}
            </div>
          )}
          <input
            ref={input}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ""
              if (f) void pick(f)
            }}
          />
          {(!picked || step === "encoding") && !pending && (
            <Button variant="outline" className="self-center" disabled={busy} onClick={() => input.current?.click()}>
              Choose a file
            </Button>
          )}
        </CardContent>
      </Card>

      {uploads.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <HistoryIcon className="size-4" /> Your uploads
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y">
              {uploads.map((u) => (
                <li key={u.txid} className="flex items-center gap-3 py-2 text-sm">
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{u.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {kb(u.size)} · {new Date(u.at).toLocaleDateString()} · <span className="font-mono">{u.txid.slice(0, 10)}…</span>
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => window.open(`${viewer}/${u.txid}`, "_blank", "noopener")}>
                    <ExternalLinkIcon /> View
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function Row({ label, value, hint, muted }: { label: string; value: string; hint?: string; muted?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-3", muted && "text-muted-foreground")}>
      <dt>
        {label}
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </dt>
      <dd className="shrink-0 font-mono">{value}</dd>
    </div>
  )
}

const STEPS = ["Encode", "Fund", "Reveal", "Live"]
const STEP_AT: Record<Step, number> = { encoding: 0, restoring: 0, ready: 0, funding: 1, checking: 1, revealing: 2, done: 3, failed: 2 }

function Progress({ step, note, failedAt }: { step: Step; note: string | null; failedAt: number }) {
  const at = step === "failed" ? failedAt : STEP_AT[step]
  return (
    <div className="flex flex-col gap-2">
      <ol className="grid grid-cols-4 gap-1.5">
        {STEPS.map((label, i) => (
          <li key={label} className="flex flex-col gap-1">
            <span className={cn("h-1.5 rounded-full", i < at || step === "done" ? "bg-emerald-500" : i === at ? (step === "failed" ? "bg-rose-500" : "animate-pulse bg-violet-500") : "bg-muted")} />
            <span className={cn("text-xs", i === at ? "font-medium" : "text-muted-foreground")}>{label}</span>
          </li>
        ))}
      </ol>
      {note && step !== "failed" && step !== "done" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" /> {note}
        </p>
      )}
    </div>
  )
}

function LinkBox({ link }: { link: string }) {
  const field = useRef<HTMLInputElement>(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      ui.toast("Link copied")
    } catch {
      // the sandbox may refuse the clipboard: select it for the user instead
      field.current?.select()
      ui.toast("Press ⌘C / Ctrl+C to copy the selected link")
    }
  }
  return (
    <div className="flex gap-2">
      <Input ref={field} readOnly value={link} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
      <Button size="icon" variant="outline" aria-label="Copy link" onClick={copy}>
        <CopyIcon />
      </Button>
      <Button size="icon" aria-label="Open on bitfiles.io" onClick={() => window.open(link, "_blank", "noopener")}>
        <ExternalLinkIcon />
      </Button>
    </div>
  )
}
