"use client"
// Review → sign → broadcast for one transaction: the Send page and module requests (components/module-frame.tsx).

import { useRef, useState } from "react"
import { base64 } from "@scure/base"
import {
  CheckCircle2Icon,
  CheckIcon,
  ClipboardPasteIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PenLineIcon,
  RadioTowerIcon,
  ScanLineIcon,
  UploadIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { PsbtQr, QrImage } from "@/components/qr"
import { QrScanner, type Scanned } from "@/components/qr-scanner"
import { copy, shorten } from "@/components/site-header"
import { useUnit } from "@/components/units"
import { useWallet } from "@/components/wallet-provider"
import { api, download } from "@/lib/api"
import { INPUT_VSIZE, buildPsbt, importSigned, type Coin, type TxPlan } from "@/lib/tx"
import { CHAINS, amountText, type Chain, type Snapshot } from "@/lib/wallet"
import { cn } from "@/lib/utils"

export type Signed = { hex: string; txid: string; fee: number; vsize: number }
export type Step = { name: "edit" } | { name: "review"; psbt: Uint8Array; plan: TxPlan } | { name: "signed"; signed: Signed } | { name: "sent"; txid: string }

/** UTXOs of a snapshot as spendable coins (with their derivation position). */
export function coinsOf(s?: Snapshot) {
  const pos = new Map((s?.addresses ?? []).map((a) => [a.address, a]))
  return (s?.utxos ?? []).flatMap((u) => {
    const a = pos.get(u.address)
    return a ? [{ coin: { ...u, change: a.change, index: a.index } as Coin, frozen: u.frozen, label: u.label }] : []
  })
}

/** Coins the automatic selection may spend: not frozen, confirmed (or our own change), worth more than their input fee. */
export const autoCandidates = (coins: ReturnType<typeof coinsOf>, rate: number) =>
  coins.filter(({ coin, frozen }) => !frozen && (coin.height > 0 || coin.change === 1) && coin.value > rate * INPUT_VSIZE).map((c) => c.coin)

export type TxFlow = ReturnType<typeof useTxFlow>

/** The steps' state and actions: build the PSBT, sign here, broadcast. `onSent` gets the txid once broadcast. */
export function useTxFlow(chain: Chain, onSent?: (txid: string) => void) {
  const wallet = useWallet()
  const [step, setStep] = useState<Step>({ name: "edit" })
  const [busy, setBusy] = useState(false)
  const run = async (failure: string, work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
    } catch (e) {
      toast.error(failure, { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return {
    step,
    setStep,
    busy,
    review: (plan: TxPlan) =>
      run("Couldn't build the transaction", async () => {
        // full parent txs (nonWitnessUtxo) for hardware/external signers; optional
        const parents = await api<Record<string, string>>("/api/rawtx", { chain, txids: [...new Set(plan.inputs.map((c) => c.txid))] }).catch(() => ({}))
        const tx = buildPsbt(plan, {
          chain,
          xpub: wallet.xpub!,
          fingerprint: wallet.fingerprint!,
          accountPath: wallet.path!,
          tipHeight: wallet.snapshots[chain]?.height ?? 0,
          parents,
        })
        setStep({ name: "review", psbt: tx.toPSBT(), plan })
      }),
    sign: (psbt: Uint8Array, password?: string) =>
      run("Signing refused", async () => {
        const signed = await api<Signed>("/api/sign", { walletId: wallet.wallet?.id, chain, psbt: base64.encode(psbt), password })
        setStep({ name: "signed", signed })
      }),
    broadcast: (signed: Signed) =>
      run("Broadcast failed", async () => {
        const { txid } = await api<{ txid: string }>("/api/broadcast", { chain, hex: signed.hex })
        setStep({ name: "sent", txid })
        toast.success(`${CHAINS[chain].label} transaction broadcast`, { description: shorten(txid) })
        onSent?.(txid)
      }),
  }
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

/** Review (unsigned PSBT) → sign (NIP-98 to the backend) → broadcast, in a modal over the send form or a module. */
export function TxDialog({ flow, chain, doneLabel = "New payment", onClose }: { flow: TxFlow; chain: Chain; doneLabel?: string; onClose: () => void }) {
  const wallet = useWallet()
  const { step, busy } = flow
  const explorer = wallet.snapshots[chain]?.explorer ?? ""
  const needsPassword = !!wallet.wallet?.needsPassword
  const watchOnly = wallet.watchOnly
  const onSign = flow.sign
  const onSigned = (signed: Signed) => flow.setStep({ name: "signed", signed })
  const onBroadcast = flow.broadcast
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
                {doneLabel}
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
