"use client"

import Link from "next/link"
import { ArrowDownLeftIcon, ArrowUpRightIcon, CopyIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatusDot } from "@/components/app-sidebar"
import { copy, shorten } from "@/components/site-header"
import { LabelEditor } from "@/components/label-editor"
import { UnitLabel, useUnit } from "@/components/units"
import { useWallet } from "@/components/wallet-provider"
import { CHAINS, formatAmount, hasData, sumBalances, type Chain } from "@/lib/wallet"
import { cn } from "@/lib/utils"

function BalanceCard({ chain }: { chain: Chain }) {
  const { snapshots, live, flash } = useWallet()
  const unit = useUnit()
  const s = snapshots[chain]
  const received = flash?.chain === chain ? flash : undefined
  const meta = CHAINS[chain]
  const { confirmed, unconfirmed } = sumBalances(s)
  const on = live && !!s?.connected
  const loaded = hasData(s)

  return (
    <Card className="relative overflow-hidden">
      <div className={cn("pointer-events-none absolute -top-16 -right-16 size-48 rounded-full opacity-20 blur-3xl", meta.bg)} />
      {received && (
        // keyed by event id so every new payment replays the animation
        <div key={received.id} className="pointer-events-none absolute inset-0 z-10">
          <div className="absolute inset-0 rounded-[inherit] motion-safe:animate-receive-glow" />
          <span className="absolute top-14 right-6 rounded-full bg-emerald-500/15 px-2.5 py-1 font-mono text-sm font-semibold text-emerald-600 dark:text-emerald-400 opacity-0 motion-safe:animate-float-up">
            +{formatAmount(received.amount, unit)} <UnitLabel chain={chain} />
          </span>
        </div>
      )}
      <CardHeader>
        <CardDescription className="flex min-w-0 items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", meta.bg)} />
          {meta.label}
          {s?.server && <span className="truncate font-mono text-xs text-muted-foreground/70">· {s.server}</span>}
        </CardDescription>
        <CardAction>
          <Badge variant="outline" className="gap-1.5">
            <StatusDot on={on} />
            {on ? "Live" : "Connecting"}
          </Badge>
        </CardAction>
        <CardTitle className="flex flex-wrap items-baseline gap-x-2 pt-1 font-mono text-3xl font-semibold tabular-nums sm:text-4xl">
          {loaded ? (
            <>
              {formatAmount(confirmed, unit)}
              <UnitLabel chain={chain} className={cn("text-base font-medium", meta.text)} />
            </>
          ) : (
            <Skeleton className="h-10 w-full max-w-56" />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex gap-2">
        {loaded ? (
          <Button asChild variant="outline" size="sm" className="relative z-20">
            <Link href={`/send?chain=${chain}`}>
              <ArrowUpRightIcon /> Send {meta.unit}
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            <ArrowUpRightIcon /> Send {meta.unit}
          </Button>
        )}
        <Button asChild variant="outline" size="sm" className="relative z-20">
          <Link href="/receive">
            <ArrowDownLeftIcon /> Receive
          </Link>
        </Button>
      </CardContent>
      <CardFooter className="flex justify-between text-sm text-muted-foreground">
        <span>
          Pending:{" "}
          <span className={cn("font-mono tabular-nums", unconfirmed > 0 && "text-emerald-600 dark:text-emerald-400", unconfirmed < 0 && "text-rose-600 dark:text-rose-400")}>
            {unconfirmed > 0 && "+"}
            {loaded ? formatAmount(unconfirmed, unit) : "—"}
          </span>
        </span>
        <span className="font-mono tabular-nums">{loaded && s?.height ? `Block #${s.height.toLocaleString()}` : "—"}</span>
      </CardFooter>
    </Card>
  )
}

function Amount({ sats, loading }: { sats?: number; loading: boolean }) {
  const unit = useUnit()
  if (loading) return <Skeleton className="ml-auto h-4 w-24" />
  return <span className={cn("font-mono text-xs tabular-nums sm:text-sm", !sats && "text-muted-foreground/60")}>{formatAmount(sats ?? 0, unit)}</span>
}

export default function Dashboard() {
  const { addresses, path, snapshots, chains, chain } = useWallet()
  const infoOf = (addr: string) => snapshots[chain]?.addresses.find((a) => a.address === addr)
  const total = (chain: Chain, addr: string) => {
    const b = snapshots[chain]?.addresses.find((a) => a.address === addr)
    return b && b.confirmed + b.unconfirmed
  }

  return (
    <>
      <div className={cn("grid gap-4", chains.length > 1 && "md:grid-cols-2")}>
        {chains.map((c) => (
          <BalanceCard key={c} chain={c} />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Addresses</CardTitle>
          <CardDescription>First 10 receive addresses, derived in your browser from the account xpub. Balances above include change addresses.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 sm:px-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="hidden w-12 sm:table-cell sm:pl-2">#</TableHead>
                <TableHead className="pl-4 sm:pl-2">Address</TableHead>
                {chains.map((c, i) => (
                  <TableHead key={c} className={cn("text-right", i === chains.length - 1 && "pr-4 sm:pr-2")}>
                    <span className={CHAINS[c].text}>{CHAINS[c].unit}</span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {addresses.length === 0
                ? Array.from({ length: 10 }, (_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={2 + chains.length} className="px-4 sm:px-2">
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                : addresses.map((addr, i) => (
                    <TableRow key={addr}>
                      <TableCell className="hidden text-muted-foreground sm:table-cell sm:pl-2">
                        <span title={path ? `${path}/0/${i}` : undefined}>{i}</span>
                      </TableCell>
                      <TableCell className="pl-4 sm:pl-2">
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-xs sm:text-sm">
                            <span className="lg:hidden">{shorten(addr, 5)}</span>
                            <span className="hidden lg:inline">{addr}</span>
                          </span>
                          <Button variant="ghost" size="icon-xs" aria-label="Copy address" onClick={() => copy(addr, "Address copied")}>
                            <CopyIcon />
                          </Button>
                          {hasData(snapshots[chain]) && infoOf(addr)?.used === false && (
                            <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400" title={`Never used on ${CHAINS[chain].label}`}>
                              Virgin
                            </Badge>
                          )}
                        </div>
                        <LabelEditor chain={chain} type="addr" target={addr} value={infoOf(addr)?.label} />
                      </TableCell>
                      {chains.map((c, j) => (
                        <TableCell key={c} className={cn("text-right", j === chains.length - 1 && "pr-4 sm:pr-2")}>
                          <Amount sats={total(c, addr)} loading={!hasData(snapshots[c])} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  )
}
