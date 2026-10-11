"use client"

import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { base64 } from "@scure/base"
import { Script } from "@scure/btc-signer"
import { bytesToHex as toHex, utf8ToBytes } from "@noble/hashes/utils.js"
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ClipboardPasteIcon,
  ScanLineIcon,
  UploadIcon,
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FingerprintIcon,
  Loader2Icon,
  PenLineIcon,
  PlusIcon,
  RadioTowerIcon,
  ShieldCheckIcon,
  SnowflakeIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SetFingerprint } from "@/components/add-wallet"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { PsbtQr, QrImage } from "@/components/qr"
import { QrScanner, type Scanned } from "@/components/qr-scanner"
import { minDataScript } from "@/lib/chains"
import { RecipientAddress } from "@/components/recipient-address"
import { copy, shorten } from "@/components/site-header"
import { useWallet } from "@/components/wallet-provider"
import { api, download } from "@/lib/api"
import {
  INPUT_VSIZE,
  OP_RETURN_MAX_DATA,
  PlanError,
  addressFor,
  buildPsbt,
  cpfpFee,
  feeAt,
  importSigned,
  opReturnScript,
  parseTxHex,
  planTx,
  rbfFee,
  type Coin,
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

type Mode = { kind: "send" } | { kind: "bump"; txid: string } | { kind: "cpfp"; outpoint: string }
type Signed = { hex: string; txid: string; fee: number; vsize: number }
type Step = { name: "edit" } | { name: "review"; psbt: Uint8Array; plan: TxPlan } | { name: "signed"; signed: Signed } | { name: "sent"; txid: string }

const outpoint = (c: { txid: string; vout: number }) => `${c.txid}:${c.vout}`

/** UTXOs of a snapshot as spendable coins (with their derivation position). */
function coinsOf(s?: Snapshot) {
  const pos = new Map((s?.addresses ?? []).map((a) => [a.address, a]))
  return (s?.utxos ?? []).flatMap((u) => {
    const a = pos.get(u.address)
    return a ? [{ coin: { ...u, change: a.change, index: a.index } as Coin, frozen: u.frozen, label: u.label }] : []
  })
}

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
  const mode: Mode = params.get("bump")
    ? { kind: "bump", txid: params.get("bump")! }
    : params.get("cpfp")
      ? { kind: "cpfp", outpoint: params.get("cpfp")! }
      : { kind: "send" }
  // the selected network (navbar); its replay pair only informs the replay guard
  const chain = wallet.chain
  const snap = wallet.snapshots[chain]

  if (!hasData(snap) || wallet.fingerprint === undefined || !wallet.xpub) return <Skeleton className="h-96 w-full rounded-xl" />

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {mode.kind === "send" ? (
          <span />
        ) : (
          <Button variant="ghost" size="sm" onClick={() => router.push("/send")}>
            <ArrowLeftIcon /> New payment
          </Button>
        )}
        <span className="text-sm text-muted-foreground">
          {mode.kind === "bump" ? "Bump fee (RBF)" : mode.kind === "cpfp" ? "Accelerate with CPFP" : "New payment"} on {CHAINS[chain].label}
        </span>
      </div>
      {/* keyed so switching chain or mode resets the whole form */}
      <SendForm key={`${chain}:${params.toString()}`} chain={chain} snap={snap} mode={mode} preselect={params.get("utxos")} />
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
  const shared = useMemo(() => sharedOutpoints(wallet.snapshots, chain), [wallet.snapshots, chain])
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
  // replay guard: an OP_RETURN too big for the replay pair (Bitcoin ≥ 84 bytes, Blake allows ≤ 83) pins the tx here
  const pair = wallet.pair
  const guardable = !!pair && minDataScript(chain) > 0
  const [guard, setGuard] = useState(guardable && wallet.settings.replayGuard)
  const [message, setMessage] = useState("")
  const [step, setStep] = useState<Step>({ name: "edit" })
  const [busy, setBusy] = useState(false)

  // Fee-bump / CPFP context loaded from the chain
  const [bump, setBump] = useState<{ inputs: Coin[]; recipients: { address: string; amount: number }[]; data?: Uint8Array; fee: number; vsize: number } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

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

  // Auto-selection pool: not frozen, confirmed (or our own unconfirmed change), worth more than it costs to spend.
  const candidates = coins
    .filter(({ coin, frozen }) => !frozen && (coin.height > 0 || coin.change === 1) && coin.value > rate * INPUT_VSIZE)
    .map((c) => c.coin)
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
      } else if (mode.kind === "send" || bump) {
        const list = recipients.map((r, i) => {
          const amount = sendMax && i === 0 ? 0 : parseAmount(r.amount, unit)
          if (amount === null) throw new PlanError("Enter a valid amount")
          return { address: r.address, amount }
        })
        // RBF: the original's coins are always spent, so the new tx conflicts with (replaces) the stuck one
        const required = [...locked, ...(manualCoins ?? [])]
        plan = planTx({
          chain,
          recipients: list,
          sendMax,
          required: required.length ? required : undefined,
          candidates: manualCoins ? [] : candidates,
          fee: policy,
          changeAddress,
          data: mode.kind === "bump" ? bump?.data : data,
        })
      }
    } catch (e) {
      planError = e instanceof PlanError ? e.message : (e as Error).message
    }
  } else if (!planError) planError = "Choose a fee rate"

  const chosen = new Set([...lockedOps, ...(plan?.inputs ?? manualCoins ?? []).map(outpoint)])
  const bumpShort = mode.kind === "bump" && !plan && !!planError && /Insufficient|dust/.test(planError)
  const spendsShared = [...chosen].some((o) => shared.has(o))
  const sending = plan ? plan.outputs.filter((o) => o.kind === "recipient").reduce((s, o) => s + o.amount, 0) : 0
  const feeShare = plan && sending ? plan.fee / sending : 0
  const editable = step.name === "edit"

  const toggleCoin = (op: string) => {
    if (lockedOps.has(op)) return
    const next = new Set(manual ?? [...chosen].filter((o) => !lockedOps.has(o)))
    if (next.has(op)) next.delete(op)
    else next.add(op)
    setManual(next)
  }

  const review = async () => {
    if (!plan) return
    setBusy(true)
    try {
      // full parent txs (nonWitnessUtxo) for hardware/external signers; optional
      const parents = await api<Record<string, string>>("/api/rawtx", { chain, txids: [...new Set(plan.inputs.map((c) => c.txid))] }).catch(() => ({}))
      const tx = buildPsbt(plan, {
        chain,
        xpub: wallet.xpub!,
        fingerprint: wallet.fingerprint!,
        accountPath: wallet.path!,
        tipHeight: snap.height,
        parents,
      })
      setStep({ name: "review", psbt: tx.toPSBT(), plan })
    } catch (e) {
      toast.error("Couldn't build the transaction", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const sign = async (psbt: Uint8Array, password?: string) => {
    setBusy(true)
    try {
      const signed = await api<Signed>("/api/sign", { walletId: wallet.wallet?.id, chain, psbt: base64.encode(psbt), password })
      setStep({ name: "signed", signed })
    } catch (e) {
      toast.error("Signing refused", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const broadcast = async (signed: Signed) => {
    setBusy(true)
    try {
      const { txid } = await api<{ txid: string }>("/api/broadcast", { chain, hex: signed.hex })
      setStep({ name: "sent", txid })
      toast.success(`${meta.label} transaction broadcast`, { description: shorten(txid) })
    } catch (e) {
      toast.error("Broadcast failed", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
      <div className="flex min-w-0 flex-col gap-4">
        {mode.kind !== "cpfp" && (
          <Card>
            <CardHeader>
              <CardTitle>Recipients</CardTitle>
              <CardDescription>
                {mode.kind === "bump"
                  ? "Prefilled from the stuck transaction. Change amounts, add recipients, or use Max to take the higher fee from the payment."
                  : "Batch several payments into one transaction, or sweep with Max."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {recipients.map((r, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px_auto]">
                  <RecipientAddress
                    chain={chain}
                    index={i}
                    disabled={!editable}
                    value={r.address}
                    onChange={(address) => setRecipients(recipients.map((x, j) => (j === i ? { ...x, address } : x)))}
                  />
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
                        {shared.has(op) && <Badge variant="outline">On both chains</Badge>}
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
                Adds an on-chain message as an OP_RETURN of at least {minDataScript(chain)} bytes. {CHAINS[pair!].label}&apos;s consensus rejects
                OP_RETURNs over {minDataScript(chain) - 1} bytes, so this transaction can only ever confirm on {meta.label} and can&apos;t be replayed to move
                your {CHAINS[pair!].label} coins. Needs a relay that accepts large OP_RETURNs (Bitcoin Core 30+, mempool.space).
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
                {mode.kind !== "cpfp" && <Row label="Sending" value={amountText(sending, chain, unit)} />}
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

        {meta.unifiedSighash ? (
          <Alert>
            <ShieldCheckIcon className={meta.text} />
            <AlertTitle>Replay-protected</AlertTitle>
            <AlertDescription>
              Signed with SIGHASH_UNIFIED (0x21), which {pair ? CHAINS[pair].label : "other chains"} rejects, so this only moves {meta.label} coins.
              External signers need SIGHASH_UNIFIED support (Bitcoin Knots 29.4.1+).
            </AlertDescription>
          </Alert>
        ) : (
          pair &&
          spendsShared &&
          !guard &&
          !(mode.kind === "bump" && bump?.data) && (
            <Alert className="border-amber-500/40">
              <AlertTriangleIcon className="text-amber-600 dark:text-amber-400" />
              <AlertTitle>Replayable on {CHAINS[pair].label}</AlertTitle>
              <AlertDescription>
                These coins also exist on {CHAINS[pair].label}. Anyone can rebroadcast this transaction there and move your {CHAINS[pair].label} coins
                too.{guardable ? ` Turn on the ${meta.label}-only OP_RETURN, or move the ${CHAINS[pair].label} coins first.` : ""}
              </AlertDescription>
            </Alert>
          )
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

        <Button size="lg" disabled={!plan || busy || step.name !== "edit"} onClick={review}>
          {busy && step.name === "edit" ? <Loader2Icon className="animate-spin" /> : <PenLineIcon />} Review transaction
        </Button>
      </div>

      <TxDialog
        step={step}
        chain={chain}
        explorer={snap.explorer}
        busy={busy}
        needsPassword={!!wallet.wallet?.needsPassword}
        watchOnly={wallet.watchOnly}
        onSign={sign}
        onSigned={(signed) => setStep({ name: "signed", signed })}
        onBroadcast={broadcast}
        onClose={() => (step.name === "sent" ? router.push(`/send?chain=${chain}&new=${Date.now()}`) : setStep({ name: "edit" }))}
      />
    </div>
  )
}

const STEPS = ["Review", "Sign", "Broadcast"] as const

function Stepper({ at }: { at: 0 | 1 | 2 | 3 }) {
  return (
    <ol className="flex items-center gap-2 text-xs">
      {STEPS.map((name, i) => (
        <li key={name} className="flex items-center gap-2">
          <span
            className={cn(
              "flex size-5 items-center justify-center rounded-full border text-[10px] font-semibold",
              i < at ? "border-emerald-500 bg-emerald-500 text-white" : i === at ? "border-primary text-foreground" : "text-muted-foreground",
            )}
          >
            {i < at ? <CheckIcon className="size-3" /> : i + 1}
          </span>
          <span className={i === at ? "text-foreground" : "text-muted-foreground"}>{name}</span>
          {i < STEPS.length - 1 && <span className="h-px w-4 bg-border sm:w-8" />}
        </li>
      ))}
    </ol>
  )
}

/** Review (unsigned PSBT) → sign (NIP-98 to the backend) → broadcast, in a modal over the send form. */
function TxDialog({
  step,
  chain,
  explorer,
  busy,
  needsPassword,
  watchOnly,
  onSign,
  onSigned,
  onBroadcast,
  onClose,
}: {
  step: Step
  chain: Chain
  explorer: string
  busy: boolean
  /** software wallet: signing asks for its password */
  needsPassword: boolean
  /** no keys here: the PSBT can only be signed on another device */
  watchOnly: boolean
  onSign: (psbt: Uint8Array, password?: string) => void
  /** a transaction signed elsewhere, already verified against the reviewed PSBT */
  onSigned: (signed: Signed) => void
  onBroadcast: (signed: Signed) => void
  onClose: () => void
}) {
  const unit = useUnit()
  const meta = CHAINS[chain]
  // Keep a signed-but-unsent tx (or an in-flight request) from being dismissed by a stray click or Escape.
  const guarded = busy || step.name === "signed"
  const at = step.name === "review" ? 0 : step.name === "signed" ? 2 : 3

  return (
    <Dialog open={step.name !== "edit"} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-md"
        onInteractOutside={(e) => guarded && e.preventDefault()}
        onEscapeKeyDown={(e) => guarded && e.preventDefault()}
      >
        <DialogHeader className="gap-3">
          <Stepper at={at} />
          <DialogTitle className="flex items-center gap-2">
            <span className={cn("size-2 rounded-full", meta.bg)} />
            {step.name === "review" ? "Unsigned transaction (PSBT)" : step.name === "signed" ? "Signed transaction" : `Broadcast to ${meta.label}`}
          </DialogTitle>
          <DialogDescription>
            {step.name === "review" &&
              `${step.plan.inputs.length} input${step.plan.inputs.length === 1 ? "" : "s"} · ${amountText(
                step.plan.outputs.filter((o) => o.kind === "recipient").reduce((s, o) => s + o.amount, 0),
                chain,
                unit,
              )} · fee ${step.plan.fee.toLocaleString()} sats (${(step.plan.fee / step.plan.vsize).toFixed(1)} sat/vB). ${watchOnly ? "Watch-only wallet: sign it on the device that holds the keys, then bring it back below." : "Scan with a signing wallet, or let this wallet's backend sign it."}`}
            {step.name === "signed" &&
              `${step.signed.vsize} vB · fee ${step.signed.fee.toLocaleString()} sats · txid ${shorten(step.signed.txid)}. Nothing is sent until you broadcast.`}
            {step.name === "sent" && "The network accepted the transaction. It will confirm in an upcoming block."}
          </DialogDescription>
        </DialogHeader>

        {step.name === "review" && (
          <>
            <ReviewStep
              chain={chain}
              psbt={step.psbt}
              fee={step.plan.fee}
              busy={busy}
              needsPassword={needsPassword}
              watchOnly={watchOnly}
              onSign={onSign}
              onSigned={onSigned}
              onEdit={onClose}
            />
          </>
        )}

        {step.name === "signed" && (
          <>
            <div className="flex flex-col items-center gap-3">
              {step.signed.hex.length <= 2900 ? (
                <QrImage value={step.signed.hex} />
              ) : (
                <p className="text-center text-sm text-muted-foreground">Too large for a single QR. Copy or download it instead.</p>
              )}
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" size="sm" onClick={() => copy(step.signed.hex, "Signed transaction copied")}>
                  <CopyIcon /> Copy hex
                </Button>
                <Button variant="outline" size="sm" onClick={() => download(`${chain}-${step.signed.txid}.txn`, step.signed.hex, "text/plain")}>
                  <DownloadIcon /> Download .txn
                </Button>
              </div>
            </div>
            <DialogFooter className="flex-row gap-2">
              <Button variant="outline" className="flex-1" disabled={busy} onClick={onClose}>
                Discard
              </Button>
              <Button className="flex-1" disabled={busy} onClick={() => onBroadcast(step.signed)}>
                {busy ? <Loader2Icon className="animate-spin" /> : <RadioTowerIcon />} Broadcast
              </Button>
            </DialogFooter>
          </>
        )}

        {step.name === "sent" && (
          <>
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <CheckCircle2Icon className="size-12 text-emerald-600 dark:text-emerald-400 motion-safe:animate-in motion-safe:zoom-in-50" />
              <code className="max-w-full font-mono text-xs break-all text-muted-foreground">{step.txid}</code>
            </div>
            <DialogFooter className="flex-row gap-2">
              <Button asChild variant="outline" className="flex-1">
                <a href={`${explorer}/tx/${step.txid}`} target="_blank" rel="noreferrer">
                  {new URL(explorer).host} <ExternalLinkIcon />
                </a>
              </Button>
              <Button className="flex-1" onClick={onClose}>
                New payment
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Review step: unsigned PSBT out, then sign here (password for software wallets) or bring back a tx signed elsewhere. */
function ReviewStep({
  chain,
  psbt,
  fee,
  busy,
  needsPassword,
  watchOnly,
  onSign,
  onSigned,
  onEdit,
}: {
  chain: Chain
  psbt: Uint8Array
  fee: number
  busy: boolean
  needsPassword: boolean
  watchOnly: boolean
  onSign: (psbt: Uint8Array, password?: string) => void
  onSigned: (signed: Signed) => void
  onEdit: () => void
}) {
  const [password, setPassword] = useState("")
  const [external, setExternal] = useState<"scan" | "paste" | null>(null)
  const [pasted, setPasted] = useState("")
  const file = useRef<HTMLInputElement>(null)
  const importFrom = (data: Scanned) => {
    try {
      const { hex, txid, vsize } = importSigned(chain, psbt, data)
      setExternal(null)
      setPasted("")
      onSigned({ hex, txid, vsize, fee })
      toast.success("Signed transaction imported", { description: "Signatures verified against the reviewed transaction." })
    } catch (e) {
      toast.error("Can't use that signed transaction", { description: (e as Error).message })
    }
  }

  return (
    <>
            <PsbtQr psbt={psbt} filename={`${chain}-unsigned.psbt`} />

            <div className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{watchOnly ? "Bring back the signed transaction" : "Signed on another device?"}</span>
                <div className="flex gap-1">
                  <Button size="sm" variant={external === "scan" ? "secondary" : "ghost"} onClick={() => setExternal(external === "scan" ? null : "scan")}>
                    <ScanLineIcon /> Scan
                  </Button>
                  <Button size="sm" variant={external === "paste" ? "secondary" : "ghost"} onClick={() => setExternal(external === "paste" ? null : "paste")}>
                    <ClipboardPasteIcon /> Paste
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => file.current?.click()}>
                    <UploadIcon /> File
                  </Button>
                  <input
                    ref={file}
                    type="file"
                    accept=".psbt,.txn,.txt,application/octet-stream,text/plain"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0]
                      e.target.value = ""
                      if (!f) return
                      const bytes = new Uint8Array(await f.arrayBuffer())
                      // binary PSBT as-is, otherwise text (base64 PSBT or hex tx)
                      importFrom(bytes[0] === 0x70 && bytes[4] === 0xff ? bytes : new TextDecoder().decode(bytes))
                    }}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Bring back the signed PSBT or transaction from your hardware wallet, Sparrow{CHAINS[chain].unifiedSighash ? " or Bitcoin Knots" : ""}: scan its QR (UR or
                BBQr), paste it, or load the file. It must match this transaction and carry valid signatures.
              </p>
              {external === "scan" && <QrScanner onResult={importFrom} />}
              {external === "paste" && (
                <div className="flex flex-col gap-2">
                  <Textarea
                    rows={4}
                    spellCheck={false}
                    className="font-mono text-xs"
                    placeholder="Signed PSBT (base64) or raw transaction (hex)"
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                  />
                  <Button size="sm" disabled={!pasted.trim()} onClick={() => importFrom(pasted)}>
                    Use signed transaction
                  </Button>
                </div>
              )}
            </div>

            {needsPassword && !watchOnly && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wallet-password" className="text-xs">
                  Wallet password
                </Label>
                <Input
                  id="wallet-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && password && onSign(psbt, password)}
                  placeholder="Unlocks this wallet's keys for this signature only"
                />
              </div>
            )}
            <DialogFooter className="flex-row gap-2">
              <Button variant="outline" className="flex-1" disabled={busy} onClick={onEdit}>
                Edit
              </Button>
              {!watchOnly && (
                <Button className="flex-1" disabled={busy || (needsPassword && !password)} onClick={() => onSign(psbt, needsPassword ? password : undefined)}>
                  {busy ? <Loader2Icon className="animate-spin" /> : <PenLineIcon />} Sign here
                </Button>
              )}
            </DialogFooter>
    </>
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
        `${bytes} / ${OP_RETURN_MAX_DATA} bytes${bytes < pad ? `, padded with ${pad - bytes} zero bytes` : ""} · OP_RETURN script ${script} bytes (${CHAINS[CHAINS[chain].replayPair!].label} max ${pad + 2}) · +${script + 9} vB`}
    </p>
  )
}
