"use client"

import { useState } from "react"
import Link from "next/link"
import { ExternalLinkIcon, InboxIcon, Repeat2Icon, RocketIcon, ZapIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { LabelEditor } from "@/components/label-editor"
import { ReplayDialog } from "@/components/replay-dialog"
import { shorten } from "@/components/site-header"
import { useWallet } from "@/components/wallet-provider"
import { useUnit } from "@/components/units"
import { CHAINS, formatAmount, hasData, type Chain } from "@/lib/wallet"
import { cn } from "@/lib/utils"

// mempool first, then newest first. Sort by block time: heights aren't comparable across chains.
const sortKey = (tx: { height: number; time: number | null }) => (tx.height <= 0 ? Infinity : (tx.time ?? 0))
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

export default function Transactions() {
  const unit = useUnit()
  const { snapshots, chains, pair } = useWallet()
  // replay needs the chain's pair synced alongside (Bitcoin ↔ Blake)
  const canReplay = !!pair
  const [replay, setReplay] = useState<{ chain: Chain; txid: string } | null>(null)
  const loading = !hasData(snapshots.btc) && !hasData(snapshots.xbt)

  const rows = chains.flatMap((chain) => {
    const s = snapshots[chain]
    return (s?.txs ?? []).map((tx) => ({
      ...tx,
      chain,
      tip: s!.height,
      explorer: s!.explorer,
      // our coin created by this tx, if still unspent: what CPFP spends
      ownCoin: s!.utxos.find((u) => u.txid === tx.txid && !u.frozen),
    }))
  }).sort((a, b) => sortKey(b) - sortKey(a) || b.height - a.height)

  return (
    <Card>
      <ReplayDialog target={replay} onClose={() => setReplay(null)} />
      <CardHeader>
        <CardTitle>Transactions</CardTitle>
        <CardDescription>Activity across Bitcoin and Blake. Bump a stuck send with RBF, or accelerate a stuck receive with CPFP.</CardDescription>
      </CardHeader>
      <CardContent className="px-0 sm:px-6">
        {loading ? (
          <div className="space-y-2 px-6 sm:px-0">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
            <InboxIcon className="size-8" />
            No transactions yet
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4 sm:pl-2">Chain</TableHead>
                <TableHead>Transaction</TableHead>
                <TableHead className="hidden md:table-cell">Date</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Fee</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Confirmations</TableHead>
                <TableHead className="pr-4 sm:pr-2" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((tx) => {
                const meta = CHAINS[tx.chain]
                const confs = tx.height > 0 && tx.tip ? tx.tip - tx.height + 1 : 0
                const pending = tx.height <= 0
                return (
                  <TableRow key={`${tx.chain}:${tx.txid}`}>
                    <TableCell className="pl-4 sm:pl-2">
                      <Badge variant="outline" className="gap-1.5">
                        <span className={cn("size-1.5 rounded-full", meta.bg)} />
                        {meta.unit}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <a
                          href={`${tx.explorer}/tx/${tx.txid}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-xs hover:underline sm:text-sm"
                        >
                          {shorten(tx.txid)} <ExternalLinkIcon className="size-3 text-muted-foreground" />
                        </a>
                        <LabelEditor chain={tx.chain} type="tx" target={tx.txid} value={tx.label} />
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">{tx.time ? dateFmt.format(tx.time * 1000) : "—"}</TableCell>
                    <TableCell
                      className={cn(
                        "text-right font-mono text-xs tabular-nums sm:text-sm",
                        tx.amount > 0 ? "text-emerald-600 dark:text-emerald-400" : tx.amount < 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground",
                      )}
                    >
                      {tx.amount > 0 && "+"}
                      {formatAmount(tx.amount, unit)}
                    </TableCell>
                    <TableCell className="hidden text-right font-mono text-xs text-muted-foreground lg:table-cell">
                      {tx.fee != null && tx.vsize ? `${tx.fee.toLocaleString()} · ${(tx.fee / tx.vsize).toFixed(1)}/vB` : "—"}
                    </TableCell>
                    <TableCell className="hidden text-right sm:table-cell">
                      {confs > 0 ? (
                        <span className="font-mono tabular-nums">{confs.toLocaleString()}</span>
                      ) : (
                        <Badge variant="secondary" className="bg-amber-500/15 text-amber-600 dark:text-amber-400">
                          Pending
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="pr-4 text-right sm:pr-2">
                      <div className="flex justify-end gap-1">
                      {canReplay && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title={`Replay on ${CHAINS[tx.chain === "btc" ? "xbt" : "btc"].label}`}
                          onClick={() => setReplay({ chain: tx.chain, txid: tx.txid })}
                        >
                          <Repeat2Icon /> <span className="hidden xl:inline">Replay</span>
                        </Button>
                      )}
                      {pending && tx.amount < 0 && (
                        <Button asChild size="sm" variant="outline" title="Replace by fee">
                          <Link href={`/send?chain=${tx.chain}&bump=${tx.txid}`}>
                            <ZapIcon /> <span className="hidden sm:inline">Bump</span>
                          </Link>
                        </Button>
                      )}
                      {pending && tx.amount > 0 && tx.ownCoin && (
                        <Button asChild size="sm" variant="outline" title="Child pays for parent">
                          <Link href={`/send?chain=${tx.chain}&cpfp=${tx.txid}:${tx.ownCoin.vout}`}>
                            <RocketIcon /> <span className="hidden sm:inline">CPFP</span>
                          </Link>
                        </Button>
                      )}
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
  )
}
