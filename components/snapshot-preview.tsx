"use client"

import { useEffect, useState } from "react"
import { CameraIcon, HourglassIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { shorten } from "@/components/site-header"
import { UnitLabel, useUnit } from "@/components/units"
import { useWallet } from "@/components/wallet-provider"
import { CHAINS, formatAmount, hasData, type Chain } from "@/lib/wallet"
import { cn } from "@/lib/utils"

const BLOCK_MS = 600_000 // Bitcoin's 10-minute target: the ETA is an estimate
const pad = (n: number) => String(n).padStart(2, "0")

/**
 * A chain that hasn't launched (eCash mainnet): the countdown to its fork block, from Bitcoin's tip, and what its
 * snapshot would credit this wallet if it happened now (every Bitcoin address gets the same amount, confirmed coins).
 */
export function SnapshotPreview({ chain }: { chain: Chain }) {
  const { snapshots, wallet } = useWallet()
  const unit = useUnit()
  const meta = CHAINS[chain]
  const fork = meta.forkHeight!
  const parent = meta.replayPair!
  const s = snapshots[parent]
  const height = s?.height ?? 0
  const left = fork - height

  // a live clock, re-anchored on every new block
  const [now, setNow] = useState(() => Date.now())
  const [anchor, setAnchor] = useState({ height, at: now })
  if (anchor.height !== height) setAnchor({ height, at: now })
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const eta = anchor.at + left * BLOCK_MS
  const ms = Math.max(0, eta - now)
  const d = Math.floor(ms / 86_400_000)
  const clock = `${d ? `${d}d ` : ""}${pad(Math.floor(ms / 3_600_000) % 24)}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}`

  const funded = (s?.addresses ?? []).filter((a) => a.confirmed > 0 || a.unconfirmed !== 0).sort((a, b) => b.confirmed - a.confirmed)
  const confirmed = funded.reduce((n, a) => n + a.confirmed, 0)
  const pending = funded.reduce((n, a) => n + a.unconfirmed, 0)
  const loaded = hasData(s)

  return (
    <div className="flex flex-col gap-4">
      <Card className="relative overflow-hidden">
        <div className={cn("pointer-events-none absolute -top-16 -right-16 size-48 rounded-full opacity-20 blur-3xl", meta.bg)} />
        <CardHeader>
          <CardDescription className="flex items-center gap-2">
            <HourglassIcon className="size-4" /> {meta.label} snapshot at {CHAINS[parent].label} block {fork.toLocaleString()}
            <Badge variant="outline">Soon</Badge>
          </CardDescription>
          <CardTitle className="font-mono text-4xl font-semibold tabular-nums sm:text-5xl">
            {!height ? <Skeleton className="h-12 w-64" /> : left > 0 ? clock : "Forked"}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm text-muted-foreground">
          {height > 0 &&
            (left > 0 ? (
              <span>
                {left.toLocaleString()} block{left === 1 ? "" : "s"} to go · {CHAINS[parent].label} is at #{height.toLocaleString()} · around{" "}
                {new Date(eta).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} (10-minute blocks, an estimate)
              </span>
            ) : (
              <span>
                {CHAINS[parent].label} passed block {fork.toLocaleString()}: {meta.label} opens here once a release adds its servers.
              </span>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CameraIcon className="size-4" /> If the snapshot were now
          </CardTitle>
          <CardDescription>
            Every {CHAINS[parent].label} address holding coins at block {fork.toLocaleString()} gets the same amount of {meta.unit}: nothing to claim,
            just keep the keys. Only confirmed coins count. After the fork, {CHAINS[parent].label} transactions can be replayed on {meta.label}:
            split your coins there first.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-0 sm:px-6">
          <div className="flex flex-wrap items-baseline gap-x-2 px-6 sm:px-0">
            {loaded ? (
              <>
                <span className="font-mono text-3xl font-semibold tabular-nums">{formatAmount(confirmed, unit)}</span>
                <span className={cn("font-medium", meta.text)}>{unit === "sats" ? "sats" : meta.unit}</span>
                <span className="text-sm text-muted-foreground">
                  for {wallet?.name ?? "this wallet"}
                  {pending !== 0 && ` · ${pending > 0 ? "+" : ""}${formatAmount(pending, unit)} pending, counts once confirmed before the fork`}
                </span>
              </>
            ) : (
              <Skeleton className="h-9 w-64" />
            )}
          </div>
          {loaded && funded.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6 sm:pl-2">Address</TableHead>
                  <TableHead className="text-right">
                    <span className={CHAINS[parent].text}>{CHAINS[parent].unit}</span> now
                  </TableHead>
                  <TableHead className="pr-6 text-right sm:pr-2">
                    <span className={meta.text}>{meta.unit}</span> at the snapshot
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {funded.map((a) => (
                  <TableRow key={a.address}>
                    <TableCell className="pl-6 sm:pl-2">
                      <div className="font-mono text-xs sm:text-sm">
                        <span className="lg:hidden">{shorten(a.address, 6)}</span>
                        <span className="hidden lg:inline">{a.address}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">{a.label ?? `${a.change ? "change" : "receive"} #${a.index}`}</div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums sm:text-sm">
                      {formatAmount(a.confirmed, unit)}
                      {a.unconfirmed !== 0 && <div className="text-muted-foreground">{`${a.unconfirmed > 0 ? "+" : ""}${formatAmount(a.unconfirmed, unit)} pending`}</div>}
                    </TableCell>
                    <TableCell className={cn("pr-6 text-right font-mono text-xs tabular-nums sm:pr-2 sm:text-sm", meta.text)}>
                      {formatAmount(a.confirmed, unit)} <UnitLabel chain={chain} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {loaded && funded.length === 0 && (
            <p className="px-6 text-sm text-muted-foreground sm:px-0">
              No {CHAINS[parent].label} in this wallet yet: coins it holds at block {fork.toLocaleString()} will be on {meta.label} too.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
