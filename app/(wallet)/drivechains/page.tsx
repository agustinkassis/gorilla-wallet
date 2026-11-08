"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangleIcon,
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  CheckCircle2Icon,
  CopyIcon,
  HourglassIcon,
  LayersIcon,
  VoteIcon,
  XCircleIcon,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { copy, shorten } from "@/components/site-header"
import { UnitLabel, useUnit } from "@/components/units"
import { useWallet } from "@/components/wallet-provider"
import { api } from "@/lib/api"
import { parseDepositAddress } from "@/lib/tx"
import { CHAINS, formatAmount, nextUnused, type Chain } from "@/lib/wallet"
import { cn } from "@/lib/utils"

type Sidechain = { slot: number; title: string; description: string; activationHeight: number | null; ctip: { value: number } | null }
type Proposal = { slot: number; title: string; description: string; votes: number; proposalHeight: number; age: number }
type Rules = { bundleThreshold: number; bundleMaxAge: number; slotThreshold: number; slotMaxAge: number; unusedSlotThreshold: number }
type Overview = { sidechains: Sidechain[]; proposals: Proposal[]; rules: Rules | null }
type PegEvent =
  | { kind: "deposit"; height: number; time: number; txid: string; value: number; address: string }
  | { kind: "withdrawal"; height: number; time: number; m6id: string; status: "submitted" | "succeeded" | "failed"; txid?: string; payouts?: { address: string | null; value: number }[] }

/** BIP300 on eCash: the active sidechains, slot proposals, and guided peg-in (M5 deposit) and peg-out (M6 bundle). */
export default function DrivechainsPage() {
  const { chain } = useWallet()
  const meta = CHAINS[chain]
  const [data, setData] = useState<{ chain: Chain; overview?: Overview; error?: string } | null>(null)
  const [open, setOpen] = useState<{ sidechain: Sidechain; flow: "in" | "out" } | null>(null)

  useEffect(() => {
    if (!meta.drivechain) return
    let live = true
    api<Overview>("/api/sidechains", { chain })
      .then((overview) => live && setData({ chain, overview }))
      .catch((e) => live && setData({ chain, error: (e as Error).message }))
    return () => {
      live = false
    }
  }, [chain, meta.drivechain])

  if (!meta.drivechain)
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LayersIcon className="size-4" /> Drivechains
          </CardTitle>
          <CardDescription>
            {meta.label} has no BIP300 sidechains. Switch the network (top right) to <b>eCash</b> or <b>eCash Beta</b> to move coins into
            a drivechain and back.
          </CardDescription>
        </CardHeader>
      </Card>
    )

  const current = data?.chain === chain ? data : null
  const overview = current?.overview
  const sidechains = [...(overview?.sidechains ?? [])].sort((a, b) => a.slot - b.slot)
  const locked = sidechains.reduce((s, c) => s + (c.ctip?.value ?? 0), 0)
  const rules = overview?.rules

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LayersIcon className={cn("size-4", meta.text)} /> Drivechains on {meta.label}
          </CardTitle>
          <CardDescription>
            BIP300 sidechains hold {meta.unit} in a treasury on {meta.label}. <b>Peg in</b> by depositing to a sidechain address: it&apos;s
            credited there after one confirmation. <b>Peg out</b> from the sidechain&apos;s wallet: withdrawals are batched into a bundle that
            miners approve over many blocks, then pay out here.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <Stat label="Active sidechains" value={overview ? String(sidechains.length) : null} />
          <Stat label="In treasuries" value={overview ? <Amount sats={locked} chain={chain} /> : null} />
          <Stat
            label="Withdrawal approval"
            value={rules ? `${rules.bundleThreshold.toLocaleString()} acks / ${rules.bundleMaxAge.toLocaleString()} blocks` : overview ? "—" : null}
          />
        </CardContent>
      </Card>

      {current?.error && (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>Couldn&apos;t load {meta.label} sidechains</AlertTitle>
          <AlertDescription>
            {current.error}. The list comes from a bip300301_enforcer: set {chain.toUpperCase()}_ENFORCER to use another one.
          </AlertDescription>
        </Alert>
      )}

      {!current ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : (
        overview && (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sidechains.map((s) => (
              <Card key={s.slot} className="flex flex-col">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2">
                    <span className="truncate">{s.title}</span>
                    <Badge variant="outline" className="shrink-0 font-mono">
                      slot {s.slot}
                    </Badge>
                  </CardTitle>
                  <CardDescription className="line-clamp-3 min-h-[3lh]">{s.description || "No description."}</CardDescription>
                </CardHeader>
                <CardContent className="mt-auto flex flex-col gap-3">
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-muted-foreground">Treasury</span>
                    <Amount sats={s.ctip?.value ?? 0} chain={chain} />
                  </div>
                  {s.activationHeight !== null && (
                    <div className="flex items-baseline justify-between text-xs text-muted-foreground">
                      <span>Active since</span>
                      <span className="tabular-nums">block {s.activationHeight.toLocaleString()}</span>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <Button size="sm" onClick={() => setOpen({ sidechain: s, flow: "in" })}>
                      <ArrowDownToLineIcon /> Peg in
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setOpen({ sidechain: s, flow: "out" })}>
                      <ArrowUpFromLineIcon /> Peg out
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            {!sidechains.length && <p className="text-sm text-muted-foreground">No sidechain is active on {meta.label} yet.</p>}
          </div>
        )
      )}

      {overview && overview.proposals.length > 0 && <Proposals proposals={overview.proposals} rules={rules} used={new Set(sidechains.map((s) => s.slot))} />}

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          {open?.flow === "in" && <PegIn chain={chain} sidechain={open.sidechain} />}
          {open?.flow === "out" && <PegOut chain={chain} sidechain={open.sidechain} rules={rules} />}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode | null }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums">{value ?? <Skeleton className="mt-1 h-4 w-20" />}</div>
    </div>
  )
}

function Amount({ sats, chain, signed }: { sats: number; chain: Chain; signed?: boolean }) {
  const unit = useUnit()
  return (
    <span className="font-mono tabular-nums">
      {signed && sats > 0 ? "+" : ""}
      {formatAmount(sats, unit)} <UnitLabel chain={chain} />
    </span>
  )
}

function Steps({ steps, at }: { steps: string[]; at: number }) {
  return (
    <ol className="flex items-center gap-2 text-xs">
      {steps.map((s, i) => (
        <li key={s} className={cn("flex items-center gap-1.5", i > at && "text-muted-foreground")}>
          <span
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium",
              i < at && "border-primary bg-primary text-primary-foreground",
              i === at && "border-primary text-primary",
            )}
          >
            {i < at ? "✓" : i + 1}
          </span>
          <span className="hidden sm:inline">{s}</span>
          {i < steps.length - 1 && <span className="h-px w-4 bg-border" />}
        </li>
      ))}
    </ol>
  )
}

/** A slot's deposits and withdrawal bundles, from the enforcer (slow: it scans from activation). */
function usePegEvents(chain: Chain, slot: number) {
  const [state, setState] = useState<{ events?: PegEvent[]; error?: string } | null>(null)
  useEffect(() => {
    let live = true
    api<{ events: PegEvent[] }>("/api/sidechains", { chain, slot })
      .then((r) => live && setState({ events: r.events }))
      .catch((e) => live && setState({ error: (e as Error).message }))
    return () => {
      live = false
    }
  }, [chain, slot])
  return state
}

function PegIn({ chain, sidechain }: { chain: Chain; sidechain: Sidechain }) {
  const router = useRouter()
  const { snapshots } = useWallet()
  const meta = CHAINS[chain]
  const [address, setAddress] = useState("")
  const peg = usePegEvents(chain, sidechain.slot)
  const tip = snapshots[chain]?.height ?? 0
  const ours = useMemo(() => new Set(snapshots[chain]?.txs.map((t) => t.txid) ?? []), [snapshots, chain])
  const mine = (peg?.events ?? []).filter((e): e is Extract<PegEvent, { kind: "deposit" }> => e.kind === "deposit" && ours.has(e.txid))

  let check: { ok: true } | { ok: false; error: string } | null = null
  if (address.trim()) {
    try {
      const { slot } = parseDepositAddress(address.trim())
      check = slot === sidechain.slot ? { ok: true } : { ok: false, error: `This address is for slot ${slot}, not ${sidechain.title} (slot ${sidechain.slot})` }
    } catch (e) {
      check = { ok: false, error: (e as Error).message }
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ArrowDownToLineIcon className="size-4" /> Peg in to {sidechain.title}
        </DialogTitle>
        <DialogDescription>
          Move {meta.unit} from this wallet into {sidechain.title}. The deposit joins the sidechain&apos;s treasury on {meta.label}, and{" "}
          {sidechain.title} credits it once the transaction confirms.
        </DialogDescription>
      </DialogHeader>
      <Steps steps={["Deposit address", "Amount & fee", "Credited"]} at={check?.ok ? 1 : 0} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="deposit-address">Deposit address from your {sidechain.title} wallet</Label>
        <Input
          id="deposit-address"
          className="font-mono text-xs"
          placeholder={`s${sidechain.slot}_…_…`}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <p className={cn("text-xs", check && !check.ok ? "text-destructive" : check ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
          {check
            ? check.ok
              ? `Checksum OK: a ${sidechain.title} address.`
              : check.error
            : `Open ${sidechain.title}, choose Receive / Deposit, and copy its deposit address (s${sidechain.slot}_<address>_<checksum>).`}
        </p>
      </div>
      <Button disabled={!check?.ok} onClick={() => router.push(`/send?deposit=1&to=${encodeURIComponent(address.trim())}`)}>
        Continue: choose amount and fee
      </Button>
      <p className="text-xs text-muted-foreground">
        Next you pick the amount and fee in Send. The wallet checks the slot is active and spends its current treasury, so a stale or
        inactive sidechain can&apos;t swallow the coins.
      </p>
      <section className="flex flex-col gap-2 border-t pt-3">
        <h3 className="text-sm font-medium">Your deposits to {sidechain.title}</h3>
        {!peg ? (
          <Skeleton className="h-10 w-full" />
        ) : peg.error ? (
          <p className="text-xs text-destructive">{peg.error}</p>
        ) : mine.length ? (
          <ul className="flex flex-col gap-1.5 text-xs">
            {mine.map((d) => (
              <li key={d.txid} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2Icon className="size-3.5 text-emerald-500" />
                  <span className="font-mono">{shorten(d.txid)}</span>
                  <span className="text-muted-foreground">
                    {tip >= d.height ? `${(tip - d.height + 1).toLocaleString()} conf` : `block ${d.height.toLocaleString()}`}
                  </span>
                </span>
                <Amount sats={d.value} chain={chain} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">None yet.</p>
        )}
      </section>
    </>
  )
}

function PegOut({ chain, sidechain, rules }: { chain: Chain; sidechain: Sidechain; rules: Rules | null | undefined }) {
  const { snapshots, wallet } = useWallet()
  const meta = CHAINS[chain]
  const [copied, setCopied] = useState(false)
  const peg = usePegEvents(chain, sidechain.slot)
  const tip = snapshots[chain]?.height ?? 0
  const address = nextUnused(snapshots, 0)?.address
  const mine = useMemo(() => new Set(snapshots[chain]?.addresses.map((a) => a.address) ?? []), [snapshots, chain])

  // events come newest first: a bundle's first one is its latest status, its last one when it was submitted
  const bundles = useMemo(() => {
    const by = new Map<string, { m6id: string; status: string; submitted: number; height: number; txid?: string; toYou: number }>()
    for (const e of peg?.events ?? []) {
      if (e.kind !== "withdrawal") continue
      const b = by.get(e.m6id)
      const toYou = (e.payouts ?? []).filter((p) => p.address && mine.has(p.address)).reduce((s, p) => s + p.value, 0)
      if (!b) by.set(e.m6id, { m6id: e.m6id, status: e.status, submitted: e.height, height: e.height, txid: e.txid, toYou })
      else b.submitted = e.height
    }
    return [...by.values()]
  }, [peg, mine])

  const copyAddress = async () => {
    if (!address) return
    copy(address, "Address copied: paste it in the sidechain's withdraw form")
    setCopied(true)
    if (wallet)
      await api("/api/labels", { walletId: wallet.id, chain, type: "addr", ref: address, label: `Withdrawal from ${sidechain.title}` }).catch(() => {})
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ArrowUpFromLineIcon className="size-4" /> Peg out from {sidechain.title}
        </DialogTitle>
        <DialogDescription>
          Withdrawals start in {sidechain.title}&apos;s own wallet and land here. {meta.label} miners approve each withdrawal bundle
          {rules ? ` with ${rules.bundleThreshold.toLocaleString()} acks within ${rules.bundleMaxAge.toLocaleString()} blocks` : ""}, so
          this takes a while: it&apos;s the security model, not a stuck payment.
        </DialogDescription>
      </DialogHeader>
      <Steps steps={["Your address", "Withdraw there", "Miners approve", "Paid here"]} at={copied ? 1 : 0} />
      <ol className="flex flex-col gap-3 text-sm">
        <li className="flex flex-col gap-2">
          <span className="font-medium">1. Copy a fresh {meta.label} address</span>
          {address ? (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{address}</code>
              <Button size="sm" variant={copied ? "outline" : "default"} onClick={copyAddress}>
                <CopyIcon /> {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : (
            <Skeleton className="h-8 w-full" />
          )}
          <span className="text-xs text-muted-foreground">It gets the label “Withdrawal from {sidechain.title}”, so the payout is easy to spot.</span>
        </li>
        <li className="flex flex-col gap-1">
          <span className="font-medium">2. Withdraw in {sidechain.title}</span>
          <span className="text-xs text-muted-foreground">
            In its wallet choose Withdraw, paste the address, and set the amount plus the {meta.label} fee the bundle will pay. The
            sidechain adds it to its next withdrawal bundle.
          </span>
        </li>
        <li className="flex flex-col gap-1">
          <span className="font-medium">3. Miners approve the bundle</span>
          <span className="text-xs text-muted-foreground">
            {rules
              ? `It pays out once it collects ${rules.bundleThreshold.toLocaleString()} acks; a bundle that doesn't within ${rules.bundleMaxAge.toLocaleString()} blocks fails, and the sidechain returns the coins there.`
              : "It pays out once enough miners ack it."}
          </span>
        </li>
        <li className="flex flex-col gap-1">
          <span className="font-medium">4. The coins arrive here</span>
          <span className="text-xs text-muted-foreground">Like any payment: it shows on the dashboard and in Transactions.</span>
        </li>
      </ol>
      <section className="flex flex-col gap-2 border-t pt-3">
        <h3 className="text-sm font-medium">{sidechain.title} withdrawal bundles</h3>
        {!peg ? (
          <Skeleton className="h-10 w-full" />
        ) : peg.error ? (
          <p className="text-xs text-destructive">{peg.error}</p>
        ) : bundles.length ? (
          <ul className="flex flex-col gap-2 text-xs">
            {bundles.map((b) => (
              <li key={b.m6id} className="flex flex-col gap-1 rounded-md border px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    {b.status === "succeeded" ? (
                      <CheckCircle2Icon className="size-3.5 text-emerald-500" />
                    ) : b.status === "failed" ? (
                      <XCircleIcon className="size-3.5 text-destructive" />
                    ) : (
                      <HourglassIcon className="size-3.5 text-amber-500" />
                    )}
                    <span className="font-mono">{shorten(b.m6id)}</span>
                  </span>
                  <Badge variant={b.status === "failed" ? "destructive" : "outline"}>
                    {b.status === "succeeded" ? "Paid" : b.status === "failed" ? "Failed" : "Collecting acks"}
                  </Badge>
                </div>
                <span className="text-muted-foreground">
                  {b.status === "submitted"
                    ? `Submitted at block ${b.submitted.toLocaleString()}, ${Math.max(0, tip - b.submitted).toLocaleString()} blocks ago` +
                      (rules ? `; expires at block ${(b.submitted + rules.bundleMaxAge).toLocaleString()}` : "")
                    : `${b.status === "succeeded" ? "Paid" : "Failed"} at block ${b.height.toLocaleString()} (submitted ${b.submitted.toLocaleString()})`}
                </span>
                {b.toYou > 0 && (
                  <span className="text-emerald-600 dark:text-emerald-400">
                    Paid you <Amount sats={b.toYou} chain={chain} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No withdrawal bundle yet.</p>
        )}
      </section>
    </>
  )
}

function Proposals({ proposals, rules, used }: { proposals: Proposal[]; rules: Rules | null | undefined; used: Set<number> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <VoteIcon className="size-4" /> Proposed sidechains
        </CardTitle>
        <CardDescription>New sidechains activate once miners vote them in. You can&apos;t peg in until they do.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {[...proposals]
          .sort((a, b) => b.votes - a.votes)
          .map((p) => {
            // replacing an active sidechain needs the stricter threshold
            const need = rules ? (used.has(p.slot) ? rules.slotThreshold : rules.unusedSlotThreshold) : null
            const pct = need ? Math.min(100, (p.votes / need) * 100) : 0
            return (
              <div key={`${p.slot}:${p.proposalHeight}`} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{p.title}</span>
                    <Badge variant="outline" className="shrink-0 font-mono">
                      slot {p.slot}
                    </Badge>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {p.votes.toLocaleString()}
                    {need ? ` / ${need.toLocaleString()}` : ""} votes
                  </span>
                </div>
                {need && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${p.title} votes`}>
                    <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                )}
                {p.description && <p className="line-clamp-2 text-xs text-muted-foreground">{p.description}</p>}
              </div>
            )
          })}
      </CardContent>
    </Card>
  )
}
