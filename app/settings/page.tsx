"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { CheckIcon, DownloadIcon, EyeIcon, EyeOffIcon, NetworkIcon, Trash2Icon, UploadIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { SetFingerprint } from "@/components/add-wallet"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useWallet } from "@/components/wallet-provider"
import { KIND, WatchOnlyBadge } from "@/components/wallet-switcher"
import { api, download } from "@/lib/api"
import { canNotify, requestNotifications } from "@/lib/notify"
import { minDataScript } from "@/lib/chains"
import {
  CHAINS,
  WEB_CHAIN_IDS,
  FAMILIES,
  displayXpub,
  type Account,
  type Chain,
  type ChainSources,
  type Family,
  type FeePreset,
  type Settings,
} from "@/lib/wallet"
import { cn } from "@/lib/utils"

/** chains whose sends can carry an OP_RETURN their replay pair rejects (Bitcoin vs Blake) */
const GUARDED = WEB_CHAIN_IDS.filter((c) => minDataScript(c) > 0)

const PRESETS: { key: FeePreset; label: string }[] = [
  { key: "fastestFee", label: "Fastest" },
  { key: "halfHourFee", label: "30 min" },
  { key: "hourFee", label: "1 hour" },
  { key: "economyFee", label: "Economy" },
]

// Notification permission only exists in the browser: null on the server and during hydration.
const noSubscribe = () => () => {}
const readPermission = () => (canNotify() ? Notification.permission : null)

export default function SettingsPage() {
  const { settings, chains } = useWallet()
  const permission = useSyncExternalStore(noSubscribe, readPermission, () => null)
  const save = async (patch: Partial<Settings>) => {
    try {
      await api("/api/settings", patch)
    } catch (e) {
      toast.error("Couldn't save setting", { description: (e as Error).message })
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <NetworksCard />

      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
          <CardDescription>How incoming payments are announced.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Toggle label="Sound on incoming payments" checked={settings.sound} onChange={(sound) => save({ sound })} />
          <Toggle
            label="System notifications when the tab is in the background"
            checked={settings.notifications}
            onChange={(notifications) => {
              if (notifications) requestNotifications()
              void save({ notifications })
            }}
          />
          {permission === "denied" && (
            <p className="text-xs text-amber-600 dark:text-amber-400">Notifications are blocked for this site in your browser settings.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sending</CardTitle>
          <CardDescription>Defaults for new payments.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label className="text-sm">Default fee</Label>
            <div className="grid grid-cols-4 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => save({ feePreset: p.key })}
                  className={cn("rounded-lg border px-2 py-1.5 text-xs", settings.feePreset === p.key ? "border-primary bg-secondary" : "hover:bg-muted/50")}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <Toggle
            label={`${GUARDED.map((c) => CHAINS[c].label).join(" / ")}-only OP_RETURN replay guard on by default`}
            checked={settings.replayGuard}
            onChange={(replayGuard) => save({ replayGuard })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Address discovery</CardTitle>
          <CardDescription>Gap limit: how many unused addresses to watch past the last used one (Electrum: 20 / 10).</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <GapInput label="Receive" value={settings.gapReceive} onSave={(gapReceive) => save({ gapReceive })} />
          <GapInput label="Change" value={settings.gapChange} onSave={(gapChange) => save({ gapChange })} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Labels (BIP-329)</CardTitle>
          <CardDescription>Export or import labels and frozen coins. Works with Sparrow, Nunchuk, BlueWallet and others.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {chains.map((chain) => (
            <LabelsRow key={chain} chain={chain} />
          ))}
        </CardContent>
      </Card>

      <WalletCard />
    </div>
  )
}

type Effective = Record<Chain, Required<ChainSources> & { custom: boolean }>

/** Every chain: features, select it, and its Electrum / mempool sources (custom lists or the defaults). */
function NetworksCard() {
  const { settings, chain: active, snapshots } = useWallet()
  const [effective, setEffective] = useState<Effective | null>(null)
  const [editing, setEditing] = useState<Chain | null>(null)
  const load = () => api<Effective>("/api/settings").then(setEffective, () => {})
  useEffect(() => void load(), [settings.sources])

  const select = async (chain: Chain) => {
    try {
      await api("/api/settings", { chain })
    } catch (e) {
      toast.error("Couldn't switch network", { description: (e as Error).message })
    }
  }
  const toggleHidden = async (chain: Chain) => {
    const hidden = settings.hidden.includes(chain) ? settings.hidden.filter((c) => c !== chain) : [...settings.hidden, chain]
    try {
      await api("/api/settings", { hidden })
    } catch (e) {
      toast.error("Couldn't update the navbar networks", { description: (e as Error).message })
    }
  }
  const saveSources = async (chain: Chain, next: ChainSources | null) => {
    const sources = { ...settings.sources }
    if (next) sources[chain] = next
    else delete sources[chain]
    try {
      await api("/api/settings", { sources })
      setEditing(null)
      toast.success(next ? `${CHAINS[chain].label} sources saved` : `${CHAINS[chain].label} back to the default sources`)
    } catch (e) {
      toast.error("Couldn't save sources", { description: (e as Error).message })
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <NetworkIcon className="size-4" /> Networks
        </CardTitle>
        <CardDescription>
          One network at a time (also from the navbar; hide the ones you don&apos;t use). Each chain can use several Electrum servers and mempool explorers,
          tried in order; a fork&apos;s replay pair syncs along for replay checks.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {WEB_CHAIN_IDS.map((c) => {
          const def = CHAINS[c]
          const src = effective?.[c]
          const features = [
            FAMILIES[def.family].label,
            def.unifiedSighash && "SIGHASH_UNIFIED",
            def.replayPair && `replays ↔ ${CHAINS[def.replayPair].label}`,
            def.maxScript && `scripts ≤ ${def.maxScript} B`,
            typeof def.maxDataScript === "number" && `OP_RETURN ≤ ${def.maxDataScript} B`,
          ].filter(Boolean)
          const hidden = settings.hidden.includes(c) && c !== active
          return (
            <div key={c} className={cn("flex flex-col gap-3 rounded-lg border p-4", c === active && "border-primary/50 bg-primary/5")}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className={cn("flex min-w-0 flex-col gap-1", hidden && "opacity-50")}>
                  <span className="flex items-center gap-2 font-medium">
                    <span className={cn("size-2.5 rounded-full", def.bg)} />
                    {def.label}
                    <span className="text-xs font-normal text-muted-foreground">{def.unit}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{features.join(" · ")}</span>
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={c === active}
                    title={c === active ? "The selected network always shows in the navbar" : hidden ? "Show in the navbar" : "Hide from the navbar"}
                    onClick={() => toggleHidden(c)}
                  >
                    {hidden ? <EyeIcon /> : <EyeOffIcon />} {hidden ? "Show" : "Hide"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditing(editing === c ? null : c)}>
                    Sources{src?.custom ? " · custom" : ""}
                  </Button>
                  {c === active ? (
                    <Button size="sm" variant="secondary" disabled>
                      <CheckIcon /> Selected
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => select(c)}>
                      Select
                    </Button>
                  )}
                </div>
              </div>
              {c === active && snapshots[c] && (
                <Info label="Connected" value={`Electrum ${snapshots[c]?.server ?? "connecting…"} · explorer ${snapshots[c]?.explorer || "—"}`} />
              )}
              {editing === c && src && <SourcesEditor chain={c} sources={src} onSave={(next) => saveSources(c, next)} />}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function SourcesEditor({ chain, sources, onSave }: { chain: Chain; sources: Effective[Chain]; onSave: (next: ChainSources | null) => void }) {
  const [electrum, setElectrum] = useState(sources.electrum.join("\n"))
  const [mempool, setMempool] = useState(sources.mempool.join("\n"))
  const lines = (v: string) => v.split("\n").map((l) => l.trim()).filter(Boolean)
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Electrum / Fulcrum (tcp:// or ssl://host:port), one per line</Label>
        <Textarea rows={4} spellCheck={false} className="font-mono text-xs" value={electrum} onChange={(e) => setElectrum(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">mempool.space-compatible APIs (fees, broadcast, explorer), one per line</Label>
        <Textarea rows={4} spellCheck={false} className="font-mono text-xs" value={mempool} onChange={(e) => setMempool(e.target.value)} />
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button size="sm" onClick={() => onSave({ electrum: lines(electrum), mempool: lines(mempool) })}>
          Save {CHAINS[chain].label} sources
        </Button>
        {sources.custom && (
          <Button size="sm" variant="ghost" onClick={() => onSave(null)}>
            Reset to defaults
          </Button>
        )}
      </div>
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-4 text-sm">
      {label}
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

function GapInput({ label, value, onSave }: { label: string; value: number; onSave: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  const commit = () => {
    const n = Number(draft)
    if (Number.isInteger(n) && n >= 5 && n <= 200 && n !== value) onSave(n)
    else setDraft(String(value))
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input inputMode="numeric" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
    </div>
  )
}

function LabelsRow({ chain }: { chain: Chain }) {
  const { wallet } = useWallet()
  const file = useRef<HTMLInputElement>(null)
  const exportLabels = async () => {
    try {
      download(`${wallet?.name ?? "wallet"}-${chain}-labels.jsonl`, await api<string>(`/api/labels?wallet=${wallet?.id}&chain=${chain}`), "application/jsonl")
    } catch (e) {
      toast.error("Export failed", { description: (e as Error).message })
    }
  }
  const importLabels = async (f: File) => {
    try {
      const r = await api<{ imported: number; skipped: number }>("/api/labels/import", { walletId: wallet?.id, chain, jsonl: await f.text() })
      toast.success(`Imported ${r.imported} labels`, { description: r.skipped ? `${r.skipped} skipped` : undefined })
    } catch (e) {
      toast.error("Import failed", { description: (e as Error).message })
    }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm">{CHAINS[chain].label}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={exportLabels}>
          <DownloadIcon /> Export
        </Button>
        <Button variant="outline" size="sm" onClick={() => file.current?.click()}>
          <UploadIcon /> Import
        </Button>
        <input
          ref={file}
          type="file"
          accept=".jsonl,.json,application/jsonl,text/plain"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void importLabels(f)
            e.target.value = ""
          }}
        />
      </div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <span className="shrink-0 text-muted-foreground sm:w-44">{label}</span>
      <code className="min-w-0 font-mono text-xs break-all">{value}</code>
    </div>
  )
}

/** The selected wallet: rename, public details, delete (software / watch-only wallets). */
function WalletCard() {
  const { wallet, wallets, selectWallet } = useWallet()
  const [name, setName] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  if (!wallet) return null
  const Kind = KIND[wallet.kind]

  const rename = async () => {
    if (name === null || !name.trim() || name.trim() === wallet.name) return setName(null)
    try {
      await api("/api/wallets", { action: "rename", id: wallet.id, name: name.trim() })
      setName(null)
    } catch (e) {
      toast.error("Couldn't rename", { description: (e as Error).message })
    }
  }
  const remove = async () => {
    try {
      await api("/api/wallets", { action: "delete", id: wallet.id })
      const next = wallets.find((w) => w.id !== wallet.id)
      if (next) selectWallet(next.id)
      toast.success(`Removed "${wallet.name}"`)
    } catch (e) {
      toast.error("Couldn't remove the wallet", { description: (e as Error).message })
    } finally {
      setConfirming(false)
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Kind.icon className="size-4" /> Wallet
          {wallet.watchOnly ? <WatchOnlyBadge /> : <span className="text-xs font-normal text-muted-foreground">{Kind.label}</span>}
        </CardTitle>
        <CardDescription>
          {wallet.kind === "seed"
            ? wallet.needsPassword
              ? "Recovery words are stored encrypted with this wallet's password; you enter it to sign."
              : "No password: recovery words are stored unencrypted, and signing asks for nothing."
            : wallet.kind === "env"
              ? "From SEED_PHRASE in .env. The seed never leaves the server and is never written to the database."
              : "Public key only: balances and history, no signing."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-4">
          <span className="shrink-0 text-muted-foreground sm:w-44">Name</span>
          {name === null ? (
            <button className="text-left hover:underline" onClick={() => setName(wallet.name)}>
              {wallet.name}
            </button>
          ) : (
            <Input
              autoFocus
              className="h-8 max-w-xs"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              onBlur={rename}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur()
                if (e.key === "Escape") setName(null)
              }}
            />
          )}
        </div>
        {wallet.passphrase && <Info label="BIP39 passphrase" value="yes (not stored in clear)" />}
        {(Object.entries(wallet.accounts) as [Family, Account][]).map(([family, a]) => (
          <div key={family} className="flex flex-col gap-2 rounded-lg border p-3">
            <span className="text-xs font-medium text-muted-foreground">{FAMILIES[family].label} account</span>
            <Info label="Derivation path" value={a.path} />
            {a.fingerprint || !wallet.watchOnly ? (
              <Info label="Master fingerprint" value={a.fingerprint.toString(16).padStart(8, "0")} />
            ) : (
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
                <span className="shrink-0 text-muted-foreground sm:w-44">Master fingerprint</span>
                <SetFingerprint walletId={wallet.id} className="max-w-xs" />
              </div>
            )}
            <Info label="Account xpub" value={displayXpub(a.xpub, family)} />
          </div>
        ))}
        {wallet.kind !== "env" && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {confirming ? (
              <>
                <span className="text-xs text-rose-600 dark:text-rose-400">
                  Remove &quot;{wallet.name}&quot; and its labels from this app? {wallet.kind === "seed" && "Make sure you have its recovery words."}
                </span>
                <Button size="sm" variant="destructive" onClick={remove}>
                  Remove
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
                <Trash2Icon /> Remove wallet
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
