"use client"

import { useRef, useState } from "react"
import { AlertTriangleIcon, ChevronLeftIcon, ChevronRightIcon, CopyIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { LabelEditor } from "@/components/label-editor"
import { QrImage } from "@/components/qr"
import { copy, shorten } from "@/components/site-header"
import { useWallet } from "@/components/wallet-provider"
import { CHAINS, hasData, nextUnused } from "@/lib/wallet"

export default function ReceivePage() {
  const { snapshots, path, settings, chains, chain, pair } = useWallet()
  const [offset, setOffset] = useState(0)
  /** address picked from the table; null = next unused (+ offset) */
  const [picked, setPicked] = useState<string | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const base = chains.map((c) => snapshots[c]).find(hasData)
  const first = nextUnused(snapshots, 0)
  if (!base || !first) return <Skeleton className="h-96 w-full rounded-xl" />

  const receive = base.addresses.filter((a) => a.change === 0)
  const usedAnywhere = new Set(chains.flatMap((c) => snapshots[c]?.addresses.filter((a) => a.used).map((a) => a.address) ?? []))
  // stay inside the gap limit: addresses past it would not be watched by other wallets restoring this seed
  const maxOffset = Math.max(0, Math.min(settings.gapReceive - 1, receive.length - 1 - first.index))
  const nextFree = receive.find((a) => a.index === first.index + Math.min(offset, maxOffset)) ?? first
  const current = (picked && base.addresses.find((a) => a.address === picked)) || nextFree
  const label = current.label
  const step = (delta: number) => {
    setOffset(picked ? 0 : offset + delta)
    setPicked(null)
  }
  const pick = (address: string) => {
    setPicked(address)
    // on narrow screens the QR card sits above the table: bring it into view
    if ((card.current?.getBoundingClientRect().top ?? 0) < 0) card.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <Card ref={card} className="scroll-mt-16 lg:sticky lg:top-20 lg:self-start">
        <CardHeader>
          <CardTitle>Receive</CardTitle>
          <CardDescription>
            A fresh address for every payment.{pair && ` The same address works on ${CHAINS[chain].label} and ${CHAINS[pair].label}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <QrImage value={`bitcoin:${current.address.toUpperCase()}${label ? `?label=${encodeURIComponent(label)}` : ""}`} />
          <code className="w-full rounded-lg bg-muted px-3 py-2 text-center font-mono text-xs break-all sm:text-sm">{current.address}</code>
          <div className="flex w-full items-center justify-between gap-2">
            <Button variant="ghost" size="icon" disabled={!picked && offset === 0} onClick={() => step(-1)} aria-label="Previous unused address">
              <ChevronLeftIcon />
            </Button>
            <div className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
              <span>
                {path}/{current.change}/{current.index}
              </span>
              <LabelEditor chain={chain} type="addr" target={current.address} value={label} />
            </div>
            <Button variant="ghost" size="icon" disabled={!picked && offset >= maxOffset} onClick={() => step(1)} aria-label="Next unused address">
              <ChevronRightIcon />
            </Button>
          </div>
          {(usedAnywhere.has(current.address) || current.change === 1) && (
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              {current.change === 1
                ? "Change address: meant for this wallet's own change. Prefer a receive address for incoming payments."
                : "Already used: reusing an address links your payments together. Prefer an unused one."}
            </p>
          )}
          <Button className="w-full" onClick={() => copy(current.address, "Address copied")}>
            <CopyIcon /> Copy address
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Addresses</CardTitle>
          <CardDescription>
            Receive and change addresses discovered with a gap limit of {settings.gapReceive} / {settings.gapChange}.
          </CardDescription>
        </CardHeader>
        <CardContent className="max-h-[560px] overflow-y-auto px-0 sm:px-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4 sm:pl-2">Path</TableHead>
                <TableHead>Address</TableHead>
                <TableHead className="pr-4 text-right sm:pr-2">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {base.addresses.map((a) => (
                <TableRow
                  key={a.address}
                  data-state={a.address === current.address ? "selected" : undefined}
                  className="data-[state=selected]:shadow-[inset_3px_0_0_var(--color-primary)]"
                >
                  <TableCell className="pl-4 font-mono text-xs text-muted-foreground sm:pl-2">
                    {a.change}/{a.index}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <button
                        className="text-left font-mono text-xs hover:underline"
                        aria-pressed={a.address === current.address}
                        title="Show QR"
                        onClick={() => pick(a.address)}
                      >
                        {shorten(a.address, 10)}
                      </button>
                      <LabelEditor chain={chain} type="addr" target={a.address} value={a.label} />
                    </div>
                  </TableCell>
                  <TableCell className="pr-4 text-right sm:pr-2">
                    {usedAnywhere.has(a.address) ? <Badge variant="secondary">Used</Badge> : <span className="text-xs text-muted-foreground">Unused</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
