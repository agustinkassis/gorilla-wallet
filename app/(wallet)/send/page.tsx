"use client"

import { Suspense, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Script } from "@scure/btc-signer"
import { bytesToHex as toHex, utf8ToBytes } from "@noble/hashes/utils.js"
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  FingerprintIcon,
  LayersIcon,
  Loader2Icon,
  PenLineIcon,
  PlusIcon,
  ShieldCheckIcon,
  SplitIcon,
  SnowflakeIcon,
  Trash2Icon,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SetFingerprint } from "@/components/add-wallet"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { TxDialog, autoCandidates, coinsOf, useTxFlow } from "@/components/tx-dialog"
import { ModuleFrame } from "@/components/module-frame"
import { viewsFor } from "@/modules"
import { REPLAY_LOCKTIME, dataCapPair, minDataScript, replayPairs } from "@/lib/chains"
import { RecipientAddress } from "@/components/recipient-address"
import { shorten } from "@/components/site-header"
import { useWallet } from "@/components/wallet-provider"
import { api } from "@/lib/api"
import {
  INPUT_VSIZE,
  OP_RETURN_MAX_DATA,
  PlanError,
  addressFor,
  cpfpFee,
  feeAt,
  opReturnScript,
  parseDepositAddress,
  parseTxHex,
  planTx,
  rbfFee,
  sentBy,
  type Coin,
  type Ctip,
  type FeePolicy,
  type TxPlan,
} from "@/lib/tx"
import { UnitLabel, readUnit, useUnit } from "@/components/units"
import {
  CHAINS,
  amountInput,
  amountText,
  formatAmount,
  hasData,
  nextUnused,
  parseAmount,
  sharedOutpoints,
  type Chain,
  type FeePreset,
  type Snapshot,
} from "@/lib/wallet"
import { cn } from "@/lib/utils"

const PRESETS: { key: FeePreset; label: string }[] = [
  { key: "fastestFee", label: "Fastest" },
  { key: "halfHourFee", label: "30 min" },
  { key: "hourFee", label: "1 hour" },
  { key: "economyFee", label: "Economy" },
]

type Mode = { kind: "send" } | { kind: "deposit" } | { kind: "bump"; txid: string } | { kind: "cpfp"; outpoint: string }
type Sidechain = { slot: number; title: string; ctip: Ctip | null }

const outpoint = (c: { txid: string; vout: number }) => `${c.txid}:${c.vout}`

export default function SendPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
      <Send />
    </Suspense>
  )
}

function Send() {
  const params = useSearchParams()
  const router = useRouter()
  const wallet = useWallet()
  // the selected network (navbar); its replay pairs only inform the replay guards
  const chain = wallet.chain
  const snap = wallet.snapshots[chain]
  const mode: Mode = params.get("bump")
    ? { kind: "bump", txid: params.get("bump")! }
    : params.get("cpfp")
      ? { kind: "cpfp", outpoint: params.get("cpfp")! }
      : params.get("deposit") && CHAINS[chain].drivechain
        ? { kind: "deposit" }
        : { kind: "send" }
  // transaction types: a plain payment, or one a module adds (its view runs sandboxed and proposes the tx)
  const types = mode.kind === "send" ? viewsFor(wallet.settings.modules, chain, "send") : []
  const [picked, setPicked] = useState("payment")
  const type = types.find((t) => `${t.module.id}:${t.view.id}` === picked)

  if (!hasData(snap) || wallet.fingerprint === undefined || !wallet.xpub) return <Skeleton className="h-96 w-full rounded-xl" />

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {mode.kind === "send" ? (
          <div className="flex flex-wrap gap-1">
            {types.length > 0 &&
              [{ key: "payment", title: "Payment" }, ...types.map((t) => ({ key: `${t.module.id}:${t.view.id}`, title: t.view.title }))].map((t) => (
                <Button key={t.key} size="sm" variant={(type ? picked : "payment") === t.key ? "secondary" : "ghost"} onClick={() => setPicked(t.key)}>
                  {t.title}
                </Button>
              ))}
            {CHAINS[chain].drivechain && (
              <Button variant="outline" size="sm" onClick={() => router.push("/send?deposit=1")}>
                <LayersIcon /> Deposit to a sidechain
              </Button>
            )}
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => router.push("/send")}>
            <ArrowLeftIcon /> New payment
          </Button>
        )}
        <span className="text-sm text-muted-foreground">
          {mode.kind === "bump"
            ? "Bump fee (RBF)"
            : mode.kind === "cpfp"
              ? "Accelerate with CPFP"
              : mode.kind === "deposit"
                ? "Sidechain deposit (BIP300)"
                : "New payment"}{" "}
          on {CHAINS[chain].label}
        </span>
      </div>
      {type ? (
        <ModuleFrame key={`${picked}:${chain}`} module={type.module} view={type.view} minHeight={320} />
      ) : (
        // keyed so switching chain or mode resets the whole form
        <SendForm key={`${chain}:${params.toString()}`} chain={chain} snap={snap} mode={mode} preselect={params.get("utxos")} />
      )}
    </div>
  )
}

function SendForm({ chain, snap, mode, preselect }: { chain: Chain; snap: Snapshot; mode: Mode; preselect: string | null }) {
  const wallet = useWallet()
  const router = useRouter()
  const meta = CHAINS[chain]
  const fees = snap.fees
  // a replacement can't spend outputs of the tx it replaces: hide them in bump mode
  const replacing = mode.kind === "bump" ? mode.txid : null
  const coins = useMemo(() => coinsOf(snap).filter((c) => c.coin.txid !== replacing), [snap, replacing])
  const pairs = wallet.pairs
  // per replay pair, our coins unspent there too: a tx spending only those can be replayed there
  const shared = useMemo(() => new Map(replayPairs(chain).map((p) => [p, sharedOutpoints(wallet.snapshots, chain, p)])), [wallet.snapshots, chain])
  const changeAddress = (nextUnused(wallet.snapshots, 1) ?? snap.addresses.find((a) => a.change === 1))?.address ?? ""

  const [recipients, setRecipients] = useState([{ address: "", amount: "" }])
  // Amounts are typed in the display unit; when the switch flips, re-express what's typed so it keeps its value.
  const unit = useUnit()
  const [typedIn, setTypedIn] = useState(unit)
  if (typedIn !== unit) {
    setTypedIn(unit)
    setRecipients(recipients.map((r) => {
      const sats = parseAmount(r.amount, typedIn)
      return sats === null ? r : { ...r, amount: amountInput(sats, unit) }
    }))
  }
  const [sendMax, setSendMax] = useState(false)
  const [manual, setManual] = useState<Set<string> | null>(preselect ? new Set(preselect.split(",")) : null)
  const [preset, setPreset] = useState<FeePreset | "custom">(wallet.settings.feePreset)
  const [customRate, setCustomRate] = useState("")
  // replay guards. Blake caps OP_RETURNs (≤ 83 bytes): a bigger one (Bitcoin ≥ 84) pins the tx here.
  const dataPair = dataCapPair(chain)
  const guardable = !!dataPair
  const [guard, setGuard] = useState(guardable && wallet.settings.replayGuard)
  // eCash has no marker a Bitcoin tx can carry: spending one coin it lacks (post-fork, or split there) makes it invalid there
  const coinPair = pairs.find((p) => CHAINS[p].replayLockTime)
  const [coinGuard, setCoinGuard] = useState(!!coinPair && wallet.settings.replayGuard)
  const [message, setMessage] = useState("")
  const flow = useTxFlow(chain, (txid) => {
    const sidechain = depositTo?.sidechain
    if (sidechain && wallet.wallet)
      void api("/api/labels", { walletId: wallet.wallet.id, chain, type: "tx", ref: txid, label: `Deposit to ${sidechain.title} (sidechain ${sidechain.slot})` }).catch(() => {})
  })
  const { step, busy } = flow

  // Fee-bump / CPFP context loaded from the chain
  const [bump, setBump] = useState<{ inputs: Coin[]; recipients: { address: string; amount: number }[]; data?: Uint8Array; fee: number; vsize: number } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // deposit: the active sidechains and their treasuries, from the chain's BIP300 enforcer
  const [sidechains, setSidechains] = useState<Sidechain[] | null>(null)

  useEffect(() => {
    if (mode.kind !== "deposit") return
    let live = true
    api<{ sidechains: Sidechain[] }>("/api/sidechains", { chain })
      .then((r) => live && setSidechains(r.sidechains.sort((a, b) => a.slot - b.slot)))
      .catch((e) => live && setLoadError((e as Error).message))
    return () => {
      live = false
    }
  }, [mode.kind, chain])
  const depositTo = (() => {
    if (mode.kind !== "deposit") return null
    try {
      const { slot, address } = parseDepositAddress(recipients[0].address)
      return { slot, address, sidechain: sidechains?.find((s) => s.slot === slot) }
    } catch {
      return null
    }
  })()

  useEffect(() => {
    if (mode.kind !== "bump") return
    let live = true
    const original = snap.txs.find((t) => t.txid === mode.txid)
    ;(async () => {
      if (!original || original.height > 0 || original.fee == null || !original.vsize) throw new Error("Transaction is not an unconfirmed send from this wallet")
      const { [mode.txid]: hex } = await api<Record<string, string>>("/api/rawtx", { chain, txids: [mode.txid] })
      const tx = parseTxHex(hex)
      const ins = Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i))
      const parentIds = [...new Set(ins.map((i) => toHex(i.txid!)))]
      const parents = await api<Record<string, string>>("/api/rawtx", { chain, txids: parentIds })
      const pos = new Map(snap.addresses.map((a) => [a.address, a]))
      const inputs = ins.map((i) => {
        const txid = toHex(i.txid!)
        const out = parseTxHex(parents[txid]).getOutput(i.index!)
        const address = addressFor(out.script!, chain)
        const a = address ? pos.get(address) : undefined
        if (!a) throw new Error("Only transactions spending this wallet's coins can be bumped")
        return { txid, vout: i.index!, value: Number(out.amount), address: a.address, change: a.change, index: a.index, height: 0 } as Coin
      })
      let data: Uint8Array | undefined
      const outs: { address: string; amount: number }[] = []
      for (let i = 0; i < tx.outputsLength; i++) {
        const o = tx.getOutput(i)
        if (o.script![0] === 0x6a) data = Script.decode(o.script!)[1] as Uint8Array
        else {
          const address = addressFor(o.script!, chain)!
          if (pos.get(address)?.change !== 1) outs.push({ address, amount: Number(o.amount) }) // change is recomputed
        }
      }
      if (!live) return
      setBump({ inputs, recipients: outs, data, fee: original.fee, vsize: original.vsize })
      // the replacement starts as a copy of the original; recipients stay editable (amounts, Max, more recipients)
      if (outs.length) setRecipients(outs.map((r) => ({ address: r.address, amount: amountInput(r.amount, readUnit()) })))
    })().catch((e) => live && setLoadError((e as Error).message))
    return () => {
      live = false
    }
  }, [mode, chain, snap.txs, snap.addresses])

  const cpfpCoin = mode.kind === "cpfp" ? coins.find((c) => outpoint(c.coin) === mode.outpoint)?.coin : undefined
  const cpfpParent = cpfpCoin ? snap.txs.find((t) => t.txid === cpfpCoin.txid) : undefined

  const rate = preset === "custom" ? Number(customRate) : (fees?.[preset] ?? 0)
  const minBumpRate = bump ? Math.floor(bump.fee / bump.vsize) + 1 : 0

  const policy: FeePolicy | null = !(rate > 0)
    ? null
    : mode.kind === "bump" && bump
      ? rbfFee(Math.max(rate, minBumpRate), bump.fee)
      : mode.kind === "cpfp" && cpfpParent?.fee != null && cpfpParent.vsize
        ? cpfpFee(rate, cpfpParent.fee, cpfpParent.vsize)
        : feeAt(rate)

  const candidates = autoCandidates(coins, rate)
  const manualCoins = manual ? coins.filter((c) => manual.has(outpoint(c.coin))).map((c) => c.coin) : null
  const locked = mode.kind === "bump" ? (bump?.inputs ?? []) : []
  const lockedOps = new Set(locked.map(outpoint))

  const data = guard && guardable ? utf8ToBytes(message) : undefined

  let plan: TxPlan | null = null
  let planError: string | null = loadError
  if (!planError && policy) {
    try {
      if (mode.kind === "cpfp") {
        if (!cpfpCoin) throw new PlanError("That coin is no longer unconfirmed in this wallet")
        if (cpfpParent?.fee == null) throw new PlanError("Parent fee unknown yet")
        plan = planTx({ chain, recipients: [{ address: changeAddress, amount: 0 }], sendMax: true, required: [cpfpCoin], fee: policy, changeAddress })
      } else if (mode.kind === "send" || mode.kind === "deposit" || bump) {
        const list = recipients.map((r, i) => {
          const amount = sendMax && i === 0 ? 0 : parseAmount(r.amount, unit)
          if (amount === null) throw new PlanError("Enter a valid amount")
          return { address: r.address, amount }
        })
        // RBF: the original's coins are always spent, so the new tx conflicts with (replaces) the stuck one
        const required = [...locked, ...(manualCoins ?? [])]
        // eCash guard: spend a coin eCash lacks (needs its UTXOs to know which)
        // ponytail: "lacks" is today's view; a post-fork coin whose parent gets replayed there later is shared again
        const guarding = coinPair && coinGuard && mode.kind === "send"
        if (guarding && !hasData(wallet.snapshots[coinPair]))
          throw new PlanError(`Waiting for ${CHAINS[coinPair].label} to sync to pick a coin it lacks (or turn off its replay protection)`)
        // deposit: only to an active slot (an inactive one's output is anyone-can-spend), spending its current treasury
        let deposit: { ctip: Ctip | null } | undefined
        if (mode.kind === "deposit") {
          const { slot } = parseDepositAddress(recipients[0].address)
          if (!sidechains) throw new PlanError(`Loading ${meta.label} sidechains…`)
          const sidechain = sidechains.find((s) => s.slot === slot)
          if (!sidechain) throw new PlanError(`Sidechain slot ${slot} isn't active on ${meta.label}: a deposit there would be lost`)
          deposit = { ctip: sidechain.ctip }
        }
        plan = planTx({
          chain,
          recipients: list,
          sendMax,
          required: required.length ? required : undefined,
          candidates: manualCoins ? [] : candidates,
          fee: policy,
          changeAddress,
          data: mode.kind === "bump" ? bump?.data : data,
          guard: guarding ? { coins: [...(manualCoins ?? []), ...candidates].filter((c) => !shared.get(coinPair)!.has(outpoint(c))), pair: coinPair } : undefined,
          deposit,
        })
      }
    } catch (e) {
      planError = e instanceof PlanError ? e.message : (e as Error).message
    }
  } else if (!planError) planError = "Choose a fee rate"

  const chosen = new Set([...lockedOps, ...(plan?.inputs ?? manualCoins ?? []).map(outpoint)])
  const bumpShort = mode.kind === "bump" && !plan && !!planError && /Insufficient|dust/.test(planError)
  // replayable on a pair when every input is unspent there too and nothing in the tx is invalid there
  const pinned = (p: Chain) => !!meta.unifiedSighash || !!meta.replayLockTime || (p === dataPair && !!(data ?? (mode.kind === "bump" && bump?.data)))
  const replayableOn = pairs.filter((p) => !pinned(p) && chosen.size > 0 && [...chosen].every((o) => shared.get(p)!.has(o)))
  // eCash: our coins still unspent on Bitcoin too; spending them here first splits them (Bitcoin spends then can't replay here)
  const splittable = meta.replayLockTime ? coins.filter((c) => !c.frozen && pairs.some((p) => shared.get(p)!.has(outpoint(c.coin)))) : []
  const splitTo = nextUnused(wallet.snapshots, 0)?.address
  const split = () => {
    setRecipients([{ address: splitTo!, amount: "" }])
    setSendMax(true)
    setManual(new Set(splittable.map((c) => outpoint(c.coin))))
  }
  const sending = plan ? sentBy(plan) : 0
  const feeShare = plan && sending ? plan.fee / sending : 0
  const editable = step.name === "edit"

  const toggleCoin = (op: string) => {
    if (lockedOps.has(op)) return
    const next = new Set(manual ?? [...chosen].filter((o) => !lockedOps.has(o)))
    if (next.has(op)) next.delete(op)
    else next.add(op)
    setManual(next)
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
      <div className="flex min-w-0 flex-col gap-4">
        {mode.kind !== "cpfp" && (
          <Card>
            <CardHeader>
              <CardTitle>{mode.kind === "deposit" ? "Sidechain deposit" : "Recipients"}</CardTitle>
              <CardDescription>
                {mode.kind === "bump"
                  ? "Prefilled from the stuck transaction. Change amounts, add recipients, or use Max to take the higher fee from the payment."
                  : mode.kind === "deposit"
                    ? `Moves ${meta.unit} into a BIP300 sidechain: paste a deposit address from the sidechain's wallet (s9_…), which names its slot and carries a checksum.`
                    : "Batch several payments into one transaction, or sweep with Max."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {recipients.map((r, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px_auto]">
                  {mode.kind === "deposit" ? (
                    <Input
                      disabled={!editable}
                      spellCheck={false}
                      placeholder="s9_…_checksum"
                      value={r.address}
                      onChange={(e) => setRecipients([{ ...r, address: e.target.value }])}
                      className="font-mono text-xs"
                      aria-label="Sidechain deposit address"
                    />
                  ) : (
                    <RecipientAddress
                      chain={chain}
                      index={i}
                      disabled={!editable}
                      value={r.address}
                      onChange={(address) => setRecipients(recipients.map((x, j) => (j === i ? { ...x, address } : x)))}
                    />
                  )}
                  <div className="relative">
                    <Input
                      disabled={!editable || (sendMax && i === 0)}
                      inputMode={unit === "sats" ? "numeric" : "decimal"}
                      placeholder={sendMax && i === 0 ? "Max" : unit === "sats" ? "0" : "0.00000000"}
                      value={sendMax && i === 0 ? (plan ? amountInput(plan.outputs.find((o) => o.kind === "recipient")?.amount ?? 0, unit) : "") : r.amount}
                      onChange={(e) => setRecipients(recipients.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                      className="pr-12 font-mono text-xs"
                      aria-label={`Recipient ${i + 1} amount`}
                    />
                    <UnitLabel chain={chain} className={cn("absolute top-1/2 right-3 -translate-y-1/2 text-xs", meta.text)} />
                  </div>
                  <div className="flex gap-1">
                    {recipients.length === 1 ? (
                      <Button variant={sendMax ? "secondary" : "outline"} disabled={!editable} onClick={() => setSendMax(!sendMax)}>
                        Max
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={!editable}
                        aria-label="Remove recipient"
                        onClick={() => setRecipients(recipients.filter((_, j) => j !== i))}
                      >
                        <Trash2Icon />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {mode.kind === "deposit" ? (
                <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                  {depositTo && (
                    <p className={depositTo.sidechain || !sidechains ? "text-foreground" : "text-amber-600 dark:text-amber-400"}>
                      To {depositTo.sidechain ? `${depositTo.sidechain.title} (slot ${depositTo.slot})` : `slot ${depositTo.slot}`}
                      {sidechains && !depositTo.sidechain && `, not active on ${meta.label}`} ·{" "}
                      <span className="font-mono break-all">{depositTo.address}</span>
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span>Active on {meta.label}:</span>
                    {sidechains ? (
                      sidechains.map((s) => (
                        <Badge key={s.slot} variant="outline">
                          {s.title} · {s.slot}
                        </Badge>
                      ))
                    ) : (
                      <Skeleton className="h-5 w-40" />
                    )}
                  </div>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  disabled={!editable}
                  onClick={() => {
                    setSendMax(false)
                    setRecipients([...recipients, { address: "", amount: "" }])
                  }}
                >
                  <PlusIcon /> Add recipient
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {mode.kind === "bump" && (
          <Card>
            <CardHeader>
              <CardTitle>Replace by fee</CardTitle>
              <CardDescription>
                Builds a new transaction that spends the same coins as {shorten(mode.txid)}, so only one of them can confirm. It must pay a higher rate than
                the original{bump ? ` (${bump.fee.toLocaleString()} sats, ${(bump.fee / bump.vsize).toFixed(1)} sat/vB)` : ""}. If the original coins can&apos;t
                cover it, add coins below or lower an amount.
              </CardDescription>
            </CardHeader>
            {!bump && !loadError && (
              <CardContent>
                <Skeleton className="h-10 w-full" />
              </CardContent>
            )}
          </Card>
        )}

        {mode.kind === "cpfp" && (
          <Card>
            <CardHeader>
              <CardTitle>Child pays for parent</CardTitle>
              <CardDescription>
                Spends the unconfirmed coin back to this wallet with a fee high enough that parent + child together reach the chosen rate.
              </CardDescription>
            </CardHeader>
            {cpfpParent && (
              <CardContent className="text-sm text-muted-foreground">
                Parent pays {cpfpParent.fee ?? "?"} sats for {cpfpParent.vsize ?? "?"} vB
                {cpfpParent.fee != null && cpfpParent.vsize ? ` (${(cpfpParent.fee / cpfpParent.vsize).toFixed(1)} sat/vB)` : ""}.
              </CardContent>
            )}
          </Card>
        )}

        {mode.kind !== "cpfp" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                Coin control
                {manual ? (
                  <Button variant="ghost" size="sm" disabled={!editable} onClick={() => setManual(null)}>
                    Back to automatic
                  </Button>
                ) : (
                  <Badge variant="secondary">Automatic</Badge>
                )}
              </CardTitle>
              <CardDescription>
                {mode.kind === "bump" && "The original coins are locked in, so this replaces the stuck transaction. "}
                {manual ? "Spending exactly the selected coins." : "Suggested coins are checked. Tick or untick to choose them yourself."} Frozen coins are never
                spent.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex max-h-96 flex-col gap-1 overflow-y-auto px-2 sm:px-4">
              {coins.length + locked.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No coins on {meta.label} yet.</p>}
              {[
                ...locked.map((coin) => ({ coin, frozen: false, label: undefined as string | undefined, isLocked: true })),
                ...coins.map((c) => ({ ...c, isLocked: false })),
              ].map(({ coin, frozen, label, isLocked }) => {
                const op = outpoint(coin)
                const uneconomical = rate > 0 && coin.value <= rate * INPUT_VSIZE
                return (
                  <label
                    key={op}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50",
                      frozen && "cursor-not-allowed opacity-50",
                      chosen.has(op) && "bg-muted/40",
                    )}
                  >
                    <Checkbox
                      checked={chosen.has(op)}
                      disabled={frozen || isLocked || !editable}
                      onCheckedChange={() => toggleCoin(op)}
                      aria-label={`Select ${op}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs">{shorten(coin.txid, 6)}:{coin.vout}</span>
                        {isLocked && <Badge variant="secondary">Replacing</Badge>}
                        {frozen && (
                          <Badge variant="outline" className="gap-1 text-sky-600 dark:text-sky-400">
                            <SnowflakeIcon /> Frozen
                          </Badge>
                        )}
                        {coin.height <= 0 && !isLocked && <Badge variant="outline" className="text-amber-600 dark:text-amber-400">Unconfirmed</Badge>}
                        {pairs.filter((p) => shared.get(p)!.has(op)).map((p) => (
                          <Badge key={p} variant="outline">Also on {CHAINS[p].label}</Badge>
                        ))}
                        {uneconomical && <Badge variant="outline" className="text-rose-600 dark:text-rose-400">Uneconomical</Badge>}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{label ?? `${coin.change ? "change" : "receive"} #${coin.index}`}</div>
                    </div>
                    <span className="font-mono text-xs tabular-nums">{formatAmount(coin.value, unit)}</span>
                  </label>
                )
              })}
            </CardContent>
          </Card>
        )}

        {guardable && mode.kind === "send" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <ShieldCheckIcon className={cn("size-4", meta.text)} /> {meta.label}-only OP_RETURN
                </span>
                <Switch checked={guard} disabled={!editable} onCheckedChange={setGuard} aria-label={`${meta.label}-only OP_RETURN`} />
              </CardTitle>
              <CardDescription>
                Adds an on-chain message as an OP_RETURN of at least {minDataScript(chain)} bytes. {CHAINS[dataPair!].label}&apos;s consensus rejects
                OP_RETURNs over {minDataScript(chain) - 1} bytes, so this transaction can only ever confirm on {meta.label} and can&apos;t be replayed to move
                your {CHAINS[dataPair!].label} coins. Needs a relay that accepts large OP_RETURNs (Bitcoin Core 30+, mempool.space).
              </CardDescription>
            </CardHeader>
            {guard && (
              <CardContent className="flex flex-col gap-2">
                <Textarea
                  disabled={!editable}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={`Message to write on ${meta.label} (optional, padded to ${minDataScript(chain) - 3}+ bytes)`}
                  rows={3}
                />
                <OpReturnInfo message={message} chain={chain} />
              </CardContent>
            )}
          </Card>
        )}

        {coinPair && mode.kind === "send" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <ShieldCheckIcon className={cn("size-4", CHAINS[coinPair].text)} /> Not replayable on {CHAINS[coinPair].label}
                </span>
                <Switch checked={coinGuard} disabled={!editable} onCheckedChange={setCoinGuard} aria-label={`Not replayable on ${CHAINS[coinPair].label}`} />
              </CardTitle>
              <CardDescription>
                eCash&apos;s replay protection (nLockTime {REPLAY_LOCKTIME}) only marks eCash transactions; nothing marks a {meta.label} one. So this
                spends at least one coin {CHAINS[coinPair].label} doesn&apos;t have (received after its fork at block{" "}
                {CHAINS[coinPair].forkHeight?.toLocaleString()}, or already split there), and {CHAINS[coinPair].label} rejects the whole transaction.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>

      <div className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
        <Card>
          <CardHeader>
            <CardTitle>Fee</CardTitle>
            <CardDescription>
              {fees ? `Live estimates from ${new URL(snap.explorer).host}` : "Fee estimates unavailable — enter a custom rate."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  disabled={!fees || !editable}
                  onClick={() => setPreset(p.key)}
                  className={cn(
                    "flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50",
                    preset === p.key ? "border-primary bg-secondary" : "hover:bg-muted/50",
                  )}
                >
                  <span className="text-xs text-muted-foreground">{p.label}</span>
                  <span className="font-mono text-sm">{fees ? `${fees[p.key]} sat/vB` : "—"}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="custom-rate" className="shrink-0 text-xs text-muted-foreground">
                Custom
              </Label>
              <Input
                id="custom-rate"
                disabled={!editable}
                inputMode="decimal"
                placeholder="sat/vB"
                value={customRate}
                onFocus={() => setPreset("custom")}
                onChange={(e) => {
                  setPreset("custom")
                  setCustomRate(e.target.value)
                }}
                className="font-mono text-xs"
              />
            </div>
            {mode.kind === "bump" && bump && rate < minBumpRate && (
              <p className="text-xs text-amber-600 dark:text-amber-400">Raised to {minBumpRate} sat/vB: a replacement must pay a higher rate than the original.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {plan ? (
              <>
                <Row label="Inputs" value={`${plan.inputs.length} coin${plan.inputs.length === 1 ? "" : "s"} · ${formatAmount(plan.inputs.reduce((s, c) => s + c.value, 0), unit)}`} />
                {mode.kind !== "cpfp" && <Row label={plan.deposit ? "Depositing" : "Sending"} value={amountText(sending, chain, unit)} />}
                {plan.deposit && (
                  <Row
                    label="Treasury"
                    value={
                      plan.deposit.ctip ? `${formatAmount(plan.deposit.ctip.value, unit)} → ${formatAmount(plan.deposit.ctip.value + sending, unit)}` : "first deposit"
                    }
                  />
                )}
                <Row
                  label="Change"
                  value={(() => {
                    const ch = plan.outputs.find((o) => o.kind === "change")
                    return ch ? `${formatAmount(ch.amount, unit)} → change #${snap.addresses.find((a) => a.address === ch.address)?.index ?? "?"}` : "none (changeless)"
                  })()}
                />
                <Row label="Size" value={`~${plan.vsize} vB`} />
                <Row
                  label="Fee"
                  value={`${plan.fee.toLocaleString()} sats · ${(plan.fee / plan.vsize).toFixed(1)} sat/vB`}
                  className={feeShare > 0.1 ? "text-amber-600 dark:text-amber-400" : undefined}
                />
                {mode.kind === "cpfp" && cpfpParent?.fee != null && cpfpParent.vsize && (
                  <Row label="Package rate" value={`${((cpfpParent.fee + plan.fee) / (cpfpParent.vsize + plan.vsize)).toFixed(1)} sat/vB`} />
                )}
                {feeShare > 0.1 && (
                  <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangleIcon className="size-3" /> Fee is {(feeShare * 100).toFixed(0)}% of the amount sent.
                  </p>
                )}
              </>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-muted-foreground">{planError}</p>
                {bumpShort && (
                  <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 p-3 text-xs">
                    <p className="text-amber-600 dark:text-amber-400">
                      The original coins can&apos;t pay the higher fee with these amounts. Redesign the replacement: add coins in Coin control, lower an amount,
                      or take the fee from the payment.
                    </p>
                    {recipients.length === 1 && !sendMax && (
                      <Button size="sm" variant="outline" className="self-start" disabled={!editable} onClick={() => setSendMax(true)}>
                        Take fee from payment (Max)
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {meta.unifiedSighash || meta.replayLockTime ? (
          <Alert>
            <ShieldCheckIcon className={meta.text} />
            <AlertTitle>Replay-protected</AlertTitle>
            <AlertDescription>
              {meta.unifiedSighash
                ? `Signed with SIGHASH_UNIFIED (0x21), which ${pairs.map((p) => CHAINS[p].label).join(" and ") || "other chains"} rejects, so this only moves ${meta.label} coins. External signers need SIGHASH_UNIFIED support (Bitcoin Knots 29.4.1+).`
                : `nLockTime ${REPLAY_LOCKTIME.toLocaleString()} is final on ${meta.label}, but Bitcoin reads it as a block ~500M blocks away and never accepts it, so this only moves ${meta.label} coins.`}
            </AlertDescription>
          </Alert>
        ) : (
          replayableOn.map((p) => (
            <Alert key={p} className="border-amber-500/40">
              <AlertTriangleIcon className="text-amber-600 dark:text-amber-400" />
              <AlertTitle>Replayable on {CHAINS[p].label}</AlertTitle>
              <AlertDescription>
                These coins also exist on {CHAINS[p].label}. Anyone can rebroadcast this transaction there and move your {CHAINS[p].label} coins too.
                {p === dataPair && ` Turn on the ${meta.label}-only OP_RETURN, or move the ${CHAINS[p].label} coins first.`}
                {p === coinPair && ` Turn on "Not replayable on ${CHAINS[p].label}", or split the coins there first.`}
              </AlertDescription>
            </Alert>
          ))
        )}

        {splittable.length > 0 && mode.kind === "send" && (
          <Alert>
            <SplitIcon className={meta.text} />
            <AlertTitle>
              {splittable.length} coin{splittable.length === 1 ? "" : "s"} still on {pairs.map((p) => CHAINS[p].label).join(" and ")} too
            </AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <span>
                Split them: send them to yourself here first. Once they&apos;re spent on {meta.label}, a {pairs.map((p) => CHAINS[p].label).join(" or ")}{" "}
                transaction spending them can&apos;t be replayed here. Wait for a few confirmations before relying on it.
              </span>
              <Button size="sm" variant="outline" className="self-start" disabled={!editable || !splitTo} onClick={split}>
                <SplitIcon /> Split coins
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {wallet.watchOnly && !wallet.fingerprint && wallet.wallet && (
          <Alert>
            <FingerprintIcon />
            <AlertTitle>Add the master fingerprint for hardware wallets</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <span>
                Hardware wallets use it to find their keys in the PSBT, so add it before signing there. It&apos;s shown in Sparrow&apos;s wallet
                settings and on the device; pasting the output descriptor works too. Everything else works without it.
              </span>
              <SetFingerprint walletId={wallet.wallet.id} />
            </AlertDescription>
          </Alert>
        )}

        <Button size="lg" disabled={!plan || busy || step.name !== "edit"} onClick={() => plan && flow.review(plan)}>
          {busy && step.name === "edit" ? <Loader2Icon className="animate-spin" /> : <PenLineIcon />} Review transaction
        </Button>
      </div>

      <TxDialog
        flow={flow}
        chain={chain}
        onClose={() => (step.name === "sent" ? router.push(`/send?chain=${chain}&new=${Date.now()}`) : flow.setStep({ name: "edit" }))}
      />
    </div>
  )
}

function Row({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("text-right font-mono text-xs", className)}>{value}</span>
    </div>
  )
}

function OpReturnInfo({ message, chain }: { message: string; chain: Chain }) {
  const bytes = utf8ToBytes(message).length
  const pad = minDataScript(chain) - 3
  let script = 0
  let error = ""
  try {
    script = opReturnScript(utf8ToBytes(message), chain).length
  } catch (e) {
    error = (e as Error).message
  }
  return (
    <p className={cn("text-xs", error ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>
      {error ||
        `${bytes} / ${OP_RETURN_MAX_DATA} bytes${bytes < pad ? `, padded with ${pad - bytes} zero bytes` : ""} · OP_RETURN script ${script} bytes (${CHAINS[dataCapPair(chain)!].label} max ${pad + 2}) · +${script + 9} vB`}
    </p>
  )
}
