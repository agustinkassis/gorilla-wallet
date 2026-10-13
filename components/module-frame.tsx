"use client"
// The wallet's side of the module API: a module view in a sandboxed frame, and the handler for its calls
// (lib/modules/sdk.ts). Everything a module gets passes through `handle` below, checked against its permissions.

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useTheme } from "next-themes"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { PuzzleIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { shorten } from "@/components/site-header"
import { TxDialog, autoCandidates, coinsOf, useTxFlow } from "@/components/tx-dialog"
import { useUnit } from "@/components/units"
import { useWallet } from "@/components/wallet-provider"
import { api } from "@/lib/api"
import { OP_RETURN_MAX_DATA, PlanError, feeAt, planTx, type Recipient, type TxPlan } from "@/lib/tx"
import type { ModuleInfo, ModuleManifest, ModuleView, Permission, RpcRequest, SendRequest } from "@/lib/modules/types"
import { CHAINS, amountText, nextUnused, sumBalances } from "@/lib/wallet"
import { isEnabled, runsOn } from "@/modules"
import { cn } from "@/lib/utils"

type Wallet = ReturnType<typeof useWallet>
const noSubscribe = () => () => {}
type Pending = { request: unknown; resolve: (r: { txid: string }) => void; reject: (e: Error) => void }

const infoOf = (w: Wallet): ModuleInfo => {
  const s = w.snapshots[w.chain]
  const { label, unit, family } = CHAINS[w.chain]
  return { chain: w.chain, label, unit, family, height: s?.height ?? 0, explorer: s?.explorer ?? "", fees: s?.fees ?? null, watchOnly: w.watchOnly }
}

export function ModuleFrame({ module, view, minHeight = 120, className }: { module: ModuleManifest; view: ModuleView; minHeight?: number; className?: string }) {
  const wallet = useWallet()
  const { resolvedTheme } = useTheme()
  const ref = useRef<HTMLIFrameElement>(null)
  // in the frame URL's fragment: only the document we load knows it, so a frame that navigated away loses the API.
  // The frame renders in the browser only (its URL needs the token and the page's port).
  const [token] = useState(() => crypto.randomUUID())
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false)
  const [height, setHeight] = useState<number>()
  const [pending, setPending] = useState<Pending | null>(null)
  const current = useRef({ wallet, theme: resolvedTheme, pending })
  useEffect(() => {
    current.current = { wallet, theme: resolvedTheme, pending }
  })

  useEffect(() => {
    const frame = () => ref.current?.contentWindow
    const need = (p: Permission) => {
      if (!module.permissions.includes(p)) throw new Error(`${module.name} doesn't have the "${p}" permission`)
    }
    const handle = async (method: string, params: Record<string, unknown>) => {
      const { wallet: w, theme } = current.current
      if (!isEnabled(module, w.settings.modules) || !runsOn(module, w.chain)) throw new Error(`${module.name} is off on ${CHAINS[w.chain].label}`)
      switch (method) {
        case "init":
          return { module: { id: module.id, name: module.name }, view: view.id, config: module.config ?? {}, permissions: module.permissions, info: infoOf(w), theme: theme === "dark" ? "dark" : "light" }
        case "wallet.info":
          return infoOf(w)
        case "wallet.balance":
          need("wallet:read")
          return sumBalances(w.snapshots[w.chain])
        case "wallet.receive": {
          need("wallet:receive")
          const next = nextUnused(w.snapshots, 0)
          if (!next) throw new Error("The wallet hasn't synced yet")
          return { address: next.address }
        }
        case "wallet.send":
          need("wallet:send")
          if (current.current.pending) throw new Error("Another transaction is waiting for the user")
          return new Promise((resolve, reject) => setPending({ request: params, resolve, reject }))
        case "storage.get":
        case "storage.set":
        case "http.fetch":
          return (await api<{ result: unknown }>("/api/modules", { module: module.id, method, params })).result
        case "ui.resize":
          setHeight(Math.min(Math.max(Math.ceil(Number(params.height) || 0), 40), 4000))
          return
        case "ui.copy": {
          // only the wallet's own addresses: a module can't swap in someone else's for the user to paste
          const text = String(params.text ?? "")
          if (!Object.values(w.snapshots).some((s) => s?.addresses.some((a) => a.address === text))) throw new Error("Modules can only copy this wallet's addresses")
          await navigator.clipboard.writeText(text)
          toast.success("Address copied")
          return
        }
        case "ui.toast":
          toast(module.name, { description: String(params.message ?? "").slice(0, 200) })
          return
        default:
          throw new Error(`Unknown method: ${method}`)
      }
    }
    const onMessage = (e: MessageEvent) => {
      const m = e.data as RpcRequest
      const target = frame()
      if (!target || e.source !== target || m?.gorilla !== 1 || m.token !== token || !Number.isSafeInteger(m.id) || typeof m.method !== "string") return
      const params = m.params && typeof m.params === "object" ? (m.params as Record<string, unknown>) : {}
      handle(m.method, params).then(
        (result) => target.postMessage({ gorilla: 1, id: m.id, result: result ?? null }, "*"),
        (err: Error) => target.postMessage({ gorilla: 1, id: m.id, error: err.message || "Failed" }, "*"),
      )
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [module, view.id, token])

  // new blocks and fee estimates reach open modules
  const info = JSON.stringify(infoOf(wallet))
  useEffect(() => {
    ref.current?.contentWindow?.postMessage({ gorilla: 1, event: "info", data: JSON.parse(info) }, "*")
  }, [info])

  // production: an opaque origin (sandbox without allow-same-origin, plus the CSP sandbox in next.config.ts).
  // `next dev` won't serve its chunks to opaque origins, so there the module gets its own origin, <id>.localhost.
  const dev = process.env.NODE_ENV === "development"
  const sandbox = ["allow-scripts", "allow-forms", ...(dev ? ["allow-same-origin"] : []), ...(module.permissions.includes("ui:popups") ? ["allow-popups", "allow-popups-to-escape-sandbox"] : [])]
  const src = mounted ? `${dev ? `http://${module.id}.localhost:${location.port}` : ""}/m/${module.id}/${view.id}#${token}` : undefined
  return (
    <>
      <iframe
        ref={ref}
        src={src}
        title={`${module.name}: ${view.title}`}
        sandbox={sandbox.join(" ")}
        className={cn("w-full rounded-xl border-0 bg-transparent", className)}
        style={{ height: Math.max(height ?? 0, minHeight), colorScheme: resolvedTheme === "dark" ? "dark" : "light" }}
      />
      {pending && <SendRequestDialog module={module} pending={pending} onDone={() => setPending(null)} />}
    </>
  )
}

/** A module's transaction, checked like any input: valid outputs, sane fee, the user's review. */
function parseRequest(raw: unknown) {
  const r = (raw ?? {}) as SendRequest
  if (!Array.isArray(r.outputs) || r.outputs.length > 100) throw new PlanError("outputs must be a list of up to 100")
  const recipients: Recipient[] = r.outputs.map((o) => {
    if (!o || typeof o !== "object" || !Number.isSafeInteger(o.amount) || o.amount <= 0) throw new PlanError("Every output needs a whole, positive amount in sats")
    if ("script" in o) {
      if (typeof o.script !== "string" || !/^(?:[0-9a-f]{2}){1,10000}$/i.test(o.script)) throw new PlanError("Output scripts are hex")
      return { script: hexToBytes(o.script), amount: o.amount }
    }
    if (typeof o.address !== "string") throw new PlanError("Output without address or script")
    return { address: o.address, amount: o.amount }
  })
  if (r.data !== undefined && (typeof r.data !== "string" || !/^(?:[0-9a-f]{2})*$/i.test(r.data) || r.data.length > OP_RETURN_MAX_DATA * 2))
    throw new PlanError(`data is hex, up to ${OP_RETURN_MAX_DATA} bytes`)
  if (r.feeRate !== undefined && !(typeof r.feeRate === "number" && r.feeRate >= 1 && r.feeRate <= 1000)) throw new PlanError("feeRate is 1-1000 sat/vB")
  return { recipients, data: r.data === undefined ? undefined : hexToBytes(r.data), feeRate: r.feeRate, memo: typeof r.memo === "string" ? r.memo.slice(0, 200) : undefined }
}

function SendRequestDialog({ module, pending, onDone }: { module: ModuleManifest; pending: Pending; onDone: () => void }) {
  const wallet = useWallet()
  const unit = useUnit()
  const chain = wallet.chain
  const snap = wallet.snapshots[chain]
  const flow = useTxFlow(chain, (txid) => pending.resolve({ txid }))
  const sent = flow.step.name === "sent"

  let plan: TxPlan | null = null
  let error: string | null = null
  let memo: string | undefined
  try {
    const req = parseRequest(pending.request)
    memo = req.memo
    const rate = req.feeRate ?? snap?.fees?.[wallet.settings.feePreset]
    if (!rate) throw new PlanError("No fee estimate yet")
    const changeAddress = nextUnused(wallet.snapshots, 1)?.address
    if (!changeAddress) throw new PlanError("The wallet hasn't synced yet")
    plan = planTx({ chain, recipients: req.recipients, candidates: autoCandidates(coinsOf(snap), rate), fee: feeAt(rate), changeAddress, data: req.data })
  } catch (e) {
    error = (e as Error).message
  }

  const decline = () => {
    if (!sent) pending.reject(new Error("Declined by the user"))
    onDone()
  }

  return (
    <>
      <Dialog open={flow.step.name === "edit"} onOpenChange={(open) => !open && !flow.busy && decline()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PuzzleIcon className="size-4" /> {module.name} proposes a transaction
            </DialogTitle>
            <DialogDescription>{memo ?? `Review what it sends on ${CHAINS[chain].label}. Nothing is signed until you approve it in the next steps.`}</DialogDescription>
          </DialogHeader>
          {plan ? (
            <ul className="flex flex-col gap-1.5 text-sm">
              {plan.outputs.map((o, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate font-mono text-xs">
                    {o.kind === "data" ? `OP_RETURN · ${o.script.length} B` : o.kind === "change" ? `change → ${shorten(o.address ?? "", 6)}` : (o.address ?? `script ${shorten(bytesToHex(o.script), 8)}`)}
                  </span>
                  <span className={cn("shrink-0 font-mono text-xs", o.kind === "change" && "text-muted-foreground")}>{o.kind === "data" ? "" : amountText(o.amount, chain, unit)}</span>
                </li>
              ))}
              <li className="flex justify-between gap-3 border-t pt-1.5 text-muted-foreground">
                <span>Fee</span>
                <span className="font-mono text-xs">
                  {plan.fee.toLocaleString()} sats · {(plan.fee / plan.vsize).toFixed(1)} sat/vB
                </span>
              </li>
            </ul>
          ) : (
            <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
          )}
          <DialogFooter className="flex-row gap-2">
            <Button variant="outline" className="flex-1" disabled={flow.busy} onClick={decline}>
              Decline
            </Button>
            <Button className="flex-1" disabled={!plan || flow.busy} onClick={() => plan && flow.review(plan)}>
              Review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <TxDialog flow={flow} chain={chain} doneLabel="Done" onClose={() => (sent ? onDone() : flow.setStep({ name: "edit" }))} />
    </>
  )
}
