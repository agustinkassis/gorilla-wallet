"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { RocketIcon, SendIcon, SnowflakeIcon, SunIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { LabelEditor } from "@/components/label-editor"
import { shorten } from "@/components/site-header"
import { useWallet } from "@/components/wallet-provider"
import { api } from "@/lib/api"
import { INPUT_VSIZE } from "@/lib/tx"
import { UnitLabel, useUnit } from "@/components/units"
import { CHAINS, formatAmount, hasData, sharedOutpoints, type Chain } from "@/lib/wallet"
import { cn } from "@/lib/utils"

type Filter = Chain | "all"

export default function UtxosPage() {
  const unit = useUnit()
  const { snapshots, chains, chain: active, wallet } = useWallet()
  const router = useRouter()
  const [filter, setFilter] = useState<Filter>("all")
  const [selected, setSelected] = useState<{ chain: Chain; ops: Set<string> } | null>(null)
  const shared = useMemo(() => sharedOutpoints(snapshots, active), [snapshots, active])

  if (!chains.some((c) => hasData(snapshots[c]))) return <Skeleton className="h-96 w-full rounded-xl" />

  const rows = chains.filter((c) => filter === "all" || filter === c).flatMap((chain) => {
    const s = snapshots[chain]
    const pos = new Map((s?.addresses ?? []).map((a) => [a.address, a]))
    return (s?.utxos ?? []).map((u) => ({ ...u, chain, tip: s!.height, explorer: s!.explorer, rate: s!.fees?.halfHourFee ?? 0, addr: pos.get(u.address) }))
  })

  const toggle = (chain: Chain, op: string) => {
    if (selected && selected.chain !== chain) return toast.info("Select coins from one chain at a time")
    const ops = new Set(selected?.ops)
    if (ops.has(op)) ops.delete(op)
    else ops.add(op)
    setSelected(ops.size ? { chain, ops } : null)
  }

  const freeze = async (chain: Chain, op: string, frozen: boolean) => {
    try {
      await api("/api/labels", { walletId: wallet!.id, chain, type: "output", ref: op, spendable: !frozen })
      toast.success(frozen ? "Coin frozen: it won't be spent" : "Coin unfrozen")
    } catch (e) {
      toast.error("Couldn't update coin", { description: (e as Error).message })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className={cn("grid gap-4", chains.length > 1 && "sm:grid-cols-2")}>
        {chains.map((chain) => {
          const utxos = snapshots[chain]?.utxos ?? []
          const spendable = utxos.filter((u) => !u.frozen).reduce((s, u) => s + u.value, 0)
          const frozen = utxos.filter((u) => u.frozen).reduce((s, u) => s + u.value, 0)
          return (
            <Card key={chain}>
              <CardHeader>
                <CardDescription className="flex items-center gap-2">
                  <span className={cn("size-2 rounded-full", CHAINS[chain].bg)} />
                  {CHAINS[chain].label} · {utxos.length} coin{utxos.length === 1 ? "" : "s"}
                </CardDescription>
                <CardTitle className="font-mono text-2xl tabular-nums">
                  {formatAmount(spendable, unit)} <UnitLabel chain={chain} className={cn("text-sm", CHAINS[chain].text)} />
                </CardTitle>
                <CardDescription>{frozen > 0 ? `${formatAmount(frozen, unit)} frozen` : "Nothing frozen"}</CardDescription>
              </CardHeader>
            </Card>
          )
        })}
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <CardTitle>Unspent outputs</CardTitle>
            <CardDescription>Freeze coins to keep them out of every transaction. Label them by source for clean coin selection.</CardDescription>
          </div>
          <div className="inline-flex rounded-lg border p-0.5" role="tablist" aria-label="Chain filter">
            {(chains.length > 1 ? (["all", ...chains] as Filter[]) : []).map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={cn("rounded-md px-3 py-1 text-xs font-medium", filter === f ? "bg-secondary" : "text-muted-foreground hover:text-foreground")}
              >
                {f === "all" ? "All" : CHAINS[f].unit}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          {selected && (
            <div className="mx-4 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm sm:mx-0">
              <span>
                {selected.ops.size} {CHAINS[selected.chain].unit} coin{selected.ops.size === 1 ? "" : "s"} selected
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                  Clear
                </Button>
                <Button
                  size="sm"
                  onClick={() => router.push(`/send?chain=${selected.chain}&utxos=${[...selected.ops].join(",")}`)}
                >
                  <SendIcon /> Send selected
                </Button>
              </div>
            </div>
          )}
          {rows.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">No unspent coins.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8 pl-4 sm:pl-2" />
                  <TableHead>Coin</TableHead>
                  <TableHead className="hidden md:table-cell">Label</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Confs</TableHead>
                  <TableHead className="pr-4 text-right sm:pr-2">
                    <span className="sr-only sm:not-sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((u) => {
                  const op = `${u.txid}:${u.vout}`
                  const confs = u.height > 0 ? u.tip - u.height + 1 : 0
                  const uneconomical = u.rate > 0 && u.value <= u.rate * INPUT_VSIZE
                  return (
                    <TableRow key={`${u.chain}:${op}`} className={cn(u.frozen && "opacity-60")}>
                      <TableCell className="pl-4 sm:pl-2">
                        <Checkbox
                          checked={selected?.chain === u.chain && selected.ops.has(op)}
                          disabled={u.frozen}
                          onCheckedChange={() => toggle(u.chain, op)}
                          aria-label={`Select ${op}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={cn("size-1.5 rounded-full", CHAINS[u.chain].bg)} />
                            <a href={`${u.explorer}/tx/${u.txid}`} target="_blank" rel="noreferrer" className="font-mono text-xs hover:underline">
                              {shorten(u.txid, 6)}:{u.vout}
                            </a>
                            {u.frozen && (
                              <Badge variant="outline" className="gap-1 text-sky-600 dark:text-sky-400">
                                <SnowflakeIcon /> Frozen
                              </Badge>
                            )}
                            {u.height <= 0 && <Badge variant="outline" className="text-amber-600 dark:text-amber-400">Unconfirmed</Badge>}
                            {shared.has(op) && <Badge variant="outline">Both chains</Badge>}
                            {uneconomical && <Badge variant="outline" className="text-rose-600 dark:text-rose-400">Uneconomical</Badge>}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {u.addr ? `${u.addr.change ? "change" : "receive"} #${u.addr.index}` : ""}
                            <span className="hidden sm:inline"> · {shorten(u.address, 6)}</span>
                          </span>
                          <LabelEditor chain={u.chain} type="output" target={op} value={u.label} className="md:hidden" />
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <LabelEditor chain={u.chain} type="output" target={op} value={u.label} />
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums sm:text-sm">{formatAmount(u.value, unit)}</TableCell>
                      <TableCell className="hidden text-right font-mono text-xs sm:table-cell">{confs || "—"}</TableCell>
                      <TableCell className="pr-4 text-right sm:pr-2">
                        <div className="flex justify-end gap-0.5 sm:gap-1">
                          {u.height <= 0 && !u.frozen && (
                            <Button size="icon-sm" variant="ghost" title="Accelerate (CPFP)" onClick={() => router.push(`/send?chain=${u.chain}&cpfp=${op}`)}>
                              <RocketIcon />
                            </Button>
                          )}
                          <Button size="icon-sm" variant="ghost" title={u.frozen ? "Unfreeze" : "Freeze"} onClick={() => freeze(u.chain, op, !u.frozen)}>
                            {u.frozen ? <SunIcon /> : <SnowflakeIcon />}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
