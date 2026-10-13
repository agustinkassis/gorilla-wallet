"use client"

import { useEffect, useState } from "react"
import { AlertTriangleIcon, ArrowRightIcon, CheckCircle2Icon, ExternalLinkIcon, Loader2Icon, RadioTowerIcon, XCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { shorten } from "@/components/site-header"
import { useWallet } from "@/components/wallet-provider"
import { api } from "@/lib/api"
import type { ReplayAnalysis, Status } from "@/lib/server/replay"
import { useUnit } from "@/components/units"
import { CHAINS, formatAmount, replayPairs, type Chain } from "@/lib/wallet"
import { cn } from "@/lib/utils"

const TONE: Record<Status, { box: string; edge: string; text: string; icon: typeof CheckCircle2Icon }> = {
  pass: { box: "fill-emerald-500/10 stroke-emerald-500", edge: "stroke-emerald-500", text: "fill-emerald-700 dark:fill-emerald-400", icon: CheckCircle2Icon },
  warn: { box: "fill-amber-500/10 stroke-amber-500", edge: "stroke-amber-500", text: "fill-amber-700 dark:fill-amber-400", icon: AlertTriangleIcon },
  fail: { box: "fill-rose-500/10 stroke-rose-500", edge: "stroke-rose-500", text: "fill-rose-700 dark:fill-rose-400", icon: XCircleIcon },
}
const ICON_TEXT: Record<Status, string> = {
  pass: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  fail: "text-rose-600 dark:text-rose-400",
}

/** Inputs → transaction → outputs, each node colored by whether it holds up on the target chain. */
function ReplayGraph({ a }: { a: ReplayAnalysis }) {
  const unit = useUnit()
  const ROW = 58
  const NODE_H = 46
  const rows = Math.max(a.inputs.length, a.outputs.length, 1)
  const H = rows * ROW + 12
  const W = 660
  const inX = 8
  const nodeW = 210
  const txW = 140
  const txX = (W - txW) / 2
  const outX = W - 8 - nodeW
  const yOf = (i: number, n: number) => 6 + (H - 12 - n * ROW) / 2 + i * ROW + (ROW - NODE_H) / 2
  const txY = H / 2 - 32
  const verdict: Status = a.replayable ? "pass" : "fail"
  const edge = (x1: number, y1: number, x2: number, y2: number) => `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`

  return (
    <div className="overflow-x-auto rounded-lg border bg-muted/20">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full min-w-[560px]" role="img" aria-label="Replay analysis graph">
        {a.inputs.map((inp, i) => {
          const y = yOf(i, a.inputs.length) + NODE_H / 2
          return <path key={`e${i}`} d={edge(inX + nodeW, y, txX, H / 2)} className={cn("fill-none stroke-[1.5]", TONE[inp.status].edge)} strokeDasharray={inp.status === "pass" ? undefined : "4 3"} />
        })}
        {a.outputs.map((out, i) => {
          const y = yOf(i, a.outputs.length) + NODE_H / 2
          return <path key={`o${i}`} d={edge(txX + txW, H / 2, outX, y)} className={cn("fill-none stroke-[1.5]", TONE[out.status].edge)} strokeDasharray={out.status === "pass" ? undefined : "4 3"} />
        })}

        {a.inputs.map((inp, i) => {
          const y = yOf(i, a.inputs.length)
          return (
            <g key={`in${i}`}>
              <rect x={inX} y={y} width={nodeW} height={NODE_H} rx={8} className={cn("stroke-[1.5]", TONE[inp.status].box)} />
              <text x={inX + 10} y={y + 18} className="fill-foreground font-mono text-[11px]">
                {shorten(inp.txid, 6)}:{inp.vout}
                {inp.value !== null && <tspan className="fill-muted-foreground"> · {formatAmount(inp.value, unit)}</tspan>}
              </text>
              <text x={inX + 10} y={y + 35} className={cn("text-[10.5px]", TONE[inp.status].text)}>
                {inp.note}
              </text>
            </g>
          )
        })}

        <g>
          <rect x={txX} y={txY} width={txW} height={64} rx={10} className={cn("stroke-2", TONE[verdict].box)} />
          <text x={txX + txW / 2} y={txY + 20} textAnchor="middle" className="fill-foreground text-[11px] font-semibold">
            {CHAINS[a.from].unit} → {CHAINS[a.to].unit}
          </text>
          <text x={txX + txW / 2} y={txY + 37} textAnchor="middle" className="fill-muted-foreground font-mono text-[10.5px]">
            {shorten(a.txid, 5)}
          </text>
          <text x={txX + txW / 2} y={txY + 53} textAnchor="middle" className={cn("text-[10.5px]", TONE[verdict].text)}>
            {a.replayable ? "replayable" : "not replayable"}
          </text>
        </g>

        {a.outputs.map((out, i) => {
          const y = yOf(i, a.outputs.length)
          return (
            <g key={`out${i}`}>
              <rect x={outX} y={y} width={nodeW} height={NODE_H} rx={8} className={cn("stroke-[1.5]", TONE[out.status].box)} />
              <text x={outX + 10} y={y + 18} className="fill-foreground font-mono text-[11px]">
                {out.data ? `OP_RETURN · ${out.scriptSize} B` : shorten(out.address ?? "unknown script", 7)}
                {!out.data && <tspan className="fill-muted-foreground"> · {formatAmount(out.amount, unit)}</tspan>}
              </text>
              <text x={outX + 10} y={y + 35} className={cn("text-[10.5px]", TONE[out.status].text)}>
                {out.note}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/** Analyze rebroadcasting a transaction on a replay pair, explain why it works or not, and replay it. */
export function ReplayDialog({ target, onClose }: { target: { chain: Chain; txid: string } | null; onClose: () => void }) {
  const { snapshots, wallet, watchOnly } = useWallet()
  const [analysis, setAnalysis] = useState<ReplayAnalysis | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [picked, setPicked] = useState<Chain | null>(null)

  const from = target?.chain ?? "btc"
  // Bitcoin replays onto Blake or eCash: pick one
  const pairs = replayPairs(from)
  const to: Chain = picked && pairs.includes(picked) ? picked : (pairs[0] ?? from)
  const explorer = snapshots[to]?.explorer

  useEffect(() => {
    if (!target) return
    let live = true
    api<ReplayAnalysis>("/api/replay", { ...target, to, walletId: wallet?.id })
      .then((a) => live && setAnalysis(a))
      .catch((e) => live && setError((e as Error).message))
    return () => {
      live = false
      setAnalysis(null)
      setError(null)
      setSent(null)
    }
  }, [target, to, wallet?.id])

  const replay = async () => {
    if (!target) return
    setBusy(true)
    try {
      const { txid } = await api<{ txid: string }>("/api/replay/broadcast", { ...target, to, walletId: wallet?.id })
      setSent(txid)
      toast.success(`Replayed on ${CHAINS[to].label}`, { description: shorten(txid) })
    } catch (e) {
      toast.error("Replay failed", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className={cn("size-2 rounded-full", CHAINS[from].bg)} />
            {CHAINS[from].label}
            <ArrowRightIcon className="size-4 text-muted-foreground" />
            <span className={cn("size-2 rounded-full", CHAINS[to].bg)} />
            Replay on {CHAINS[to].label}
          </DialogTitle>
          <DialogDescription>
            Rebroadcasts the exact same signed transaction on {CHAINS[to].label}. It only works when the coins exist there too and nothing in the
            transaction is invalid on that chain.
          </DialogDescription>
          {pairs.length > 1 && !sent && (
            <div className="flex gap-1">
              {pairs.map((p) => (
                <Button key={p} size="sm" variant={p === to ? "secondary" : "ghost"} disabled={busy} onClick={() => setPicked(p)}>
                  <span className={cn("size-2 rounded-full", CHAINS[p].bg)} /> {CHAINS[p].label}
                </Button>
              ))}
            </div>
          )}
        </DialogHeader>

        {error ? (
          <p className="rounded-lg border border-rose-500/40 p-3 text-sm text-rose-600 dark:text-rose-400">{error}</p>
        ) : !analysis ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : sent ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <CheckCircle2Icon className="size-12 text-emerald-600 dark:text-emerald-400" />
            <div className="font-semibold">Broadcast to {CHAINS[to].label}</div>
            <code className="max-w-full font-mono text-xs break-all text-muted-foreground">{sent}</code>
          </div>
        ) : (
          <>
            <div
              className={cn(
                "flex items-start gap-2 rounded-lg border p-3 text-sm",
                analysis.replayable ? "border-emerald-500/40 bg-emerald-500/5" : "border-rose-500/40 bg-rose-500/5",
              )}
            >
              {analysis.replayable ? (
                <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <XCircleIcon className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" />
              )}
              <div>
                <div className="font-medium">
                  {analysis.replayable ? `Replayable on ${CHAINS[to].label}` : `Can't be replayed on ${CHAINS[to].label}`}
                </div>
                <div className="text-muted-foreground">
                  {analysis.replayable
                    ? `Broadcasting it moves the same coins on ${CHAINS[to].label} to the same recipients.`
                    : analysis.checks.find((c) => c.status === "fail")?.detail}
                </div>
              </div>
            </div>

            <ReplayGraph a={analysis} />

            <ul className="flex flex-col gap-2">
              {analysis.checks.map((c) => {
                const Icon = TONE[c.status].icon
                return (
                  <li key={c.id} className="flex items-start gap-2 text-sm">
                    <Icon className={cn("mt-0.5 size-4 shrink-0", ICON_TEXT[c.status])} />
                    <div className="min-w-0">
                      <div className="font-medium">{c.label}</div>
                      <div className="text-xs text-muted-foreground">{c.detail}</div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        <DialogFooter className="flex-row gap-2">
          {sent && explorer ? (
            <Button asChild variant="outline" className="flex-1">
              <a href={`${explorer}/tx/${sent}`} target="_blank" rel="noreferrer">
                {new URL(explorer).host} <ExternalLinkIcon />
              </a>
            </Button>
          ) : (
            <Button variant="outline" className="flex-1" disabled={busy} onClick={onClose}>
              Close
            </Button>
          )}
          {sent ? (
            <Button className="flex-1" onClick={onClose}>
              Done
            </Button>
          ) : (
            <Button
              className="flex-1"
              disabled={!analysis?.replayable || busy || watchOnly}
              title={watchOnly ? "Watch-only wallet" : undefined}
              onClick={replay}
            >
              {busy ? <Loader2Icon className="animate-spin" /> : <RadioTowerIcon />} Broadcast on {CHAINS[to].label}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
