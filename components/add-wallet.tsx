"use client"

import { useMemo, useState } from "react"
import { generateMnemonic, validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { ArrowLeftIcon, EyeIcon, KeyRoundIcon, Loader2Icon, RefreshCwIcon, SparklesIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useWallet } from "@/components/wallet-provider"
import { api } from "@/lib/api"
import { DERIVATION_PATH, FAMILIES, parseAccountKey, type Family, type WalletInfo } from "@/lib/wallet"
import { cn } from "@/lib/utils"

type Mode = "choose" | "create" | "words" | "xpub"
const WORDS = new Set(wordlist)
/** BIP84 account 0 per family: coin type 0' on mainnet, 1' on testnets and signet */
const DEFAULT_PATHS: Record<Family, string> = { main: "m/84'/0'/0'", test: "m/84'/1'/0'", regtest: "m/84'/1'/0'" }

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** Passphrase (optional), derivation path and wallet password: shared by "create" and "import words". */
function SecurityFields({ value, onChange }: { value: Security; onChange: (s: Security) => void }) {
  const set = (patch: Partial<Security>) => onChange({ ...value, ...patch })
  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-start justify-between gap-3 rounded-lg border p-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">BIP39 passphrase</span>
          <span className="text-xs text-muted-foreground">An extra word that creates a different wallet. Lose it and the funds are gone.</span>
        </span>
        <Switch checked={value.usePassphrase} onCheckedChange={(usePassphrase) => set({ usePassphrase })} aria-label="Use a BIP39 passphrase" />
      </label>
      {value.usePassphrase && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input type="password" placeholder="Passphrase" value={value.passphrase} onChange={(e) => set({ passphrase: e.target.value })} />
          <Input type="password" placeholder="Repeat passphrase" value={value.passphrase2} onChange={(e) => set({ passphrase2: e.target.value })} />
        </div>
      )}
      <Field label="Derivation path" hint="Native SegWit (BIP84). Change only to match another wallet.">
        <Input className="font-mono text-xs" value={value.path} onChange={(e) => set({ path: e.target.value })} />
      </Field>
      <Field label="Wallet password (optional)" hint="Encrypts the recovery words on the server. You'll enter it to sign. At least 8 characters.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input type="password" placeholder="Password" value={value.password} onChange={(e) => set({ password: e.target.value })} />
          <Input type="password" placeholder="Repeat password" value={value.password2} onChange={(e) => set({ password2: e.target.value })} />
        </div>
        {!value.password && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Without a password the recovery words are stored unencrypted: anyone who gets the database can spend.
          </p>
        )}
      </Field>
    </div>
  )
}

type Security = { usePassphrase: boolean; passphrase: string; passphrase2: string; path: string; password: string; password2: string }
const NEW_SECURITY: Security = { usePassphrase: false, passphrase: "", passphrase2: "", path: DEFAULT_PATHS.main, password: "", password2: "" }

function securityError(s: Security) {
  if (s.usePassphrase && !s.passphrase) return "Enter the passphrase, or turn it off"
  if (s.usePassphrase && s.passphrase !== s.passphrase2) return "Passphrases don't match"
  if (!DERIVATION_PATH.test(s.path.trim())) return "Invalid derivation path"
  if (s.password && s.password.length < 8) return "Wallet password must be at least 8 characters, or none"
  if (s.password !== s.password2) return "Passwords don't match"
  return null
}

/** Create / import a wallet (Sparrow-style). Used in the "Add wallet" dialog and as the first-run screen. */
export function AddWalletFlow({ onDone, onCancel }: { onDone: (w: WalletInfo) => void; onCancel?: () => void }) {
  const [mode, setMode] = useState<Mode>("choose")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)

  // create
  const [strength, setStrength] = useState<128 | 256>(128)
  const [generated, setGenerated] = useState(() => generateMnemonic(wordlist, 128))
  const [createStep, setCreateStep] = useState<"words" | "verify" | "secure">("words")
  const [checks, setChecks] = useState<Record<number, string>>({})
  // import words
  const [words, setWords] = useState("")
  // xpub
  const [xpub, setXpub] = useState("")
  const [xpubPath, setXpubPath] = useState("")
  const [fingerprint, setFingerprint] = useState("")
  // the account path is for the selected network's family; the other families follow its coin type
  const { family } = useWallet()
  const [security, setSecurity] = useState(() => ({ ...NEW_SECURITY, path: DEFAULT_PATHS[family] }))

  const genWords = generated.split(" ")
  // three positions to confirm the backup, fixed per generated phrase
  const verify = useMemo(() => {
    const picks = new Set<number>()
    const r = new Uint32Array(8)
    crypto.getRandomValues(r)
    for (const x of r) if (picks.size < 3) picks.add(x % generated.split(" ").length)
    return [...picks].sort((a, b) => a - b)
  }, [generated])

  const typed = words.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const unknown = typed.filter((w) => !WORDS.has(w))
  const wordsValid = validateMnemonic(typed.join(" "), wordlist)
  let xpubError: string | null = null
  let key: ReturnType<typeof parseAccountKey> | undefined
  try {
    if (xpub.trim()) key = parseAccountKey(xpub)
  } catch (e) {
    xpubError = (e as Error).message
  }
  const xpubFamily = key?.family
  // a descriptor / [fingerprint/path]xpub fills these; typing overrides
  const fpValue = fingerprint || key?.fingerprint || ""
  const pathValue = xpubPath || key?.path || ""

  const submit = async (body: Record<string, unknown>) => {
    setBusy(true)
    try {
      const w = await api<WalletInfo>("/api/wallets", body)
      toast.success(`Wallet "${w.name}" added`)
      onDone(w)
    } catch (e) {
      toast.error("Couldn't add the wallet", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const seedBody = (mnemonic: string) => ({
    action: "seed",
    name,
    mnemonic,
    passphrase: security.usePassphrase ? security.passphrase : "",
    path: security.path.trim(),
    password: security.password,
    family,
  })

  const back = () => {
    if (mode === "create" && createStep !== "words") return setCreateStep(createStep === "secure" ? "verify" : "words")
    setMode("choose")
  }
  const nameField = (
    <Field label="Wallet name">
      <Input autoFocus value={name} maxLength={40} placeholder="e.g. Savings" onChange={(e) => setName(e.target.value)} />
    </Field>
  )

  if (mode === "choose")
    return (
      <div className="flex flex-col gap-3">
        {(
          [
            { mode: "create", icon: SparklesIcon, title: "Create a new wallet", desc: "Generate new recovery words, with an optional passphrase." },
            { mode: "words", icon: KeyRoundIcon, title: "Import recovery words", desc: "Restore from the 12 or 24 BIP39 words you already have." },
            { mode: "xpub", icon: EyeIcon, title: "Watch-only (xpub)", desc: "Track an xpub or output descriptor. No keys here: sends are signed on your hardware wallet or Sparrow (PSBT)." },
          ] as const
        ).map((o) => (
          <button
            key={o.mode}
            onClick={() => setMode(o.mode)}
            className="flex items-start gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-muted/50"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-400/20 to-violet-500/20">
              <o.icon className="size-4" />
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{o.title}</span>
              <span className="text-xs text-muted-foreground">{o.desc}</span>
            </span>
          </button>
        ))}
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    )

  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" className="self-start" disabled={busy} onClick={back}>
        <ArrowLeftIcon /> Back
      </Button>

      {mode === "create" && createStep === "words" && (
        <>
          {nameField}
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex rounded-lg border p-0.5" role="tablist" aria-label="Number of words">
              {([128, 256] as const).map((s) => (
                <button
                  key={s}
                  role="tab"
                  aria-selected={strength === s}
                  onClick={() => {
                    setStrength(s)
                    setGenerated(generateMnemonic(wordlist, s))
                  }}
                  className={cn("rounded-md px-3 py-1 text-xs font-medium", strength === s ? "bg-secondary" : "text-muted-foreground")}
                >
                  {s === 128 ? "12 words" : "24 words"}
                </button>
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setGenerated(generateMnemonic(wordlist, strength))}>
              <RefreshCwIcon /> New words
            </Button>
          </div>
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {genWords.map((w, i) => (
              <li key={i} className="flex items-center gap-2 rounded-lg border bg-muted/30 px-2.5 py-1.5 font-mono text-sm">
                <span className="w-5 text-right text-xs text-muted-foreground">{i + 1}</span>
                {w}
              </li>
            ))}
          </ol>
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Write these words down on paper, in order. They are the only way to recover this wallet. Don&apos;t screenshot or copy them.
          </p>
          <Button disabled={!name.trim()} onClick={() => setCreateStep("verify")}>
            I wrote them down
          </Button>
        </>
      )}

      {mode === "create" && createStep === "verify" && (
        <>
          <p className="text-sm text-muted-foreground">Confirm your backup: type these words.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {verify.map((i) => (
              <Field key={i} label={`Word #${i + 1}`}>
                <Input
                  autoComplete="off"
                  className="font-mono"
                  value={checks[i] ?? ""}
                  onChange={(e) => setChecks({ ...checks, [i]: e.target.value.trim().toLowerCase() })}
                />
              </Field>
            ))}
          </div>
          <Button disabled={!verify.every((i) => checks[i] === genWords[i])} onClick={() => setCreateStep("secure")}>
            Continue
          </Button>
        </>
      )}

      {mode === "create" && createStep === "secure" && (
        <>
          <SecurityFields value={security} onChange={setSecurity} />
          {securityError(security) && <p className="text-xs text-muted-foreground">{securityError(security)}</p>}
          <Button disabled={busy || !!securityError(security)} onClick={() => submit(seedBody(generated))}>
            {busy && <Loader2Icon className="animate-spin" />} Create wallet
          </Button>
        </>
      )}

      {mode === "words" && (
        <>
          {nameField}
          <Field
            label="Recovery words"
            hint={
              !typed.length
                ? "12, 15, 18, 21 or 24 words separated by spaces."
                : unknown.length
                  ? `Not BIP39 words: ${unknown.slice(0, 4).join(", ")}${unknown.length > 4 ? "…" : ""}`
                  : wordsValid
                    ? `${typed.length} words · checksum OK`
                    : `${typed.length} words · checksum doesn't match yet`
            }
          >
            <Textarea
              rows={3}
              autoComplete="off"
              spellCheck={false}
              className={cn("font-mono", typed.length > 0 && (wordsValid ? "border-emerald-500/60" : unknown.length ? "border-rose-500/60" : ""))}
              value={words}
              onChange={(e) => setWords(e.target.value)}
            />
          </Field>
          <SecurityFields value={security} onChange={setSecurity} />
          <Button
            disabled={busy || !name.trim() || !wordsValid || !!securityError(security)}
            onClick={() => submit(seedBody(typed.join(" ")))}
          >
            {busy && <Loader2Icon className="animate-spin" />} Import wallet
          </Button>
          {wordsValid && securityError(security) && <p className="text-xs text-muted-foreground">{securityError(security)}</p>}
        </>
      )}

      {mode === "xpub" && (
        <>
          {nameField}
          <Field
            label="Account xpub / zpub (mainnet) or tpub / vpub (testnets)"
            hint={
              xpubError ??
              (xpubFamily
                ? `Valid ${FAMILIES[xpubFamily].label} key${key?.fingerprint ? " · fingerprint and path read from it" : ""}`
                : "Paste the output descriptor from Sparrow or your hardware wallet (it fills the fingerprint), or just the xpub.")
            }
          >
            <Textarea rows={3} spellCheck={false} className="font-mono text-xs" value={xpub} onChange={(e) => setXpub(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Derivation path">
              <Input
                className="font-mono text-xs"
                placeholder={DEFAULT_PATHS[xpubFamily ?? family]}
                value={pathValue}
                onChange={(e) => setXpubPath(e.target.value)}
              />
            </Field>
            <Field label="Master fingerprint (optional)">
              <Input className="font-mono text-xs" placeholder="e.g. 73c5da0a" value={fpValue} onChange={(e) => setFingerprint(e.target.value)} />
            </Field>
          </div>
          <Button
            disabled={busy || !name.trim() || !xpub.trim() || !!xpubError}
            onClick={() => submit({ action: "watch", name, xpub: xpub.trim(), path: pathValue.trim(), fingerprint: fpValue.trim() })}
          >
            {busy && <Loader2Icon className="animate-spin" />} Add watch-only wallet
          </Button>
        </>
      )}
    </div>
  )
}

/** "Add wallet" dialog: the flow above; the new wallet becomes the selected one. */
export function AddWalletDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { selectWallet } = useWallet()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add wallet</DialogTitle>
          <DialogDescription>Create a new wallet, restore one from its words, or watch an xpub.</DialogDescription>
        </DialogHeader>
        {open && (
          <AddWalletFlow
            onCancel={() => onOpenChange(false)}
            onDone={(w) => {
              selectWallet(w.id)
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Watch-only wallet without a master fingerprint: add it in place (8 hex, or a descriptor / [fp/path]xpub to read it from). */
export function SetFingerprint({ walletId, className }: { walletId: string; className?: string }) {
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  let fp = value.trim()
  try {
    fp = parseAccountKey(fp).fingerprint ?? fp
  } catch {} // not a key: take it as typed
  const save = async () => {
    setBusy(true)
    try {
      await api("/api/wallets", { action: "fingerprint", id: walletId, fingerprint: fp })
      toast.success("Master fingerprint saved")
    } catch (e) {
      toast.error("Couldn't save the fingerprint", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={cn("flex gap-2", className)}>
      <Input
        className="h-8 font-mono text-xs"
        placeholder="73c5da0a"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && /^[0-9a-f]{8}$/i.test(fp) && save()}
        aria-label="Master fingerprint"
      />
      <Button size="sm" disabled={busy || !/^[0-9a-f]{8}$/i.test(fp)} onClick={save}>
        {busy && <Loader2Icon className="animate-spin" />} Save
      </Button>
    </div>
  )
}
