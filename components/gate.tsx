"use client"

import { useState } from "react"
import { KeyRoundIcon, Loader2Icon, NetworkIcon, ShieldAlertIcon, ZapIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useNostr } from "@/components/nostr-provider"
import { AddWalletFlow } from "@/components/add-wallet"
import { Input } from "@/components/ui/input"
import { useWallet } from "@/components/wallet-provider"
import { api } from "@/lib/api"
import { CHAINS, FAMILIES } from "@/lib/wallet"

/** Shows the page only once logged in and authorized; otherwise a connect/error card. */
export function Gate({ children }: { children: React.ReactNode }) {
  const { pubkey, required, login, logout } = useNostr()
  const { error, retry, ready, wallets, selectWallet, wallet, account } = useWallet()

  // Login state unknown (server render / hydration): pages render their own loading skeletons.
  if (pubkey === undefined || required === undefined) return children

  if ((required && !pubkey) || error)
    return (
      <div className="flex flex-1 items-center justify-center py-12">
        <Card className="w-full max-w-md text-center">
          <CardHeader className="items-center">
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-400/20 to-violet-500/20">
              {error ? <ShieldAlertIcon className="size-6 text-amber-600 dark:text-amber-400" /> : <KeyRoundIcon className="size-6 text-violet-600 dark:text-violet-400" />}
            </div>
            <CardTitle className="text-xl">{error ? "Access problem" : "Connect with Nostr"}</CardTitle>
            <CardDescription>
              {error ?? "Sign in with your NIP-07 browser extension to open Gorilla Wallet."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center gap-2">
            {error ? (
              <>
                <Button onClick={retry}>Retry</Button>
                {required && (
                  <Button variant="outline" onClick={logout}>
                    Switch account
                  </Button>
                )}
              </>
            ) : (
              <Button onClick={login} className="gap-2">
                <ZapIcon /> Connect Nostr
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    )

  // first run: no .env seed and no wallet yet
  if (ready && wallets.length === 0)
    return (
      <div className="flex flex-1 items-start justify-center py-6 sm:py-12">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle className="text-xl">Welcome to Gorilla Wallet 🦍</CardTitle>
            <CardDescription>Add your first wallet: create new recovery words, restore existing ones, or watch an xpub.</CardDescription>
          </CardHeader>
          <CardContent>
            <AddWalletFlow onDone={(w) => selectWallet(w.id)} />
          </CardContent>
        </Card>
      </div>
    )

  if (ready && wallet && !account) return <EnableNetwork />

  return children
}

/** The selected wallet has no account on this network's family yet (created before testnets, or watch-only). */
function EnableNetwork() {
  const { wallet, chain, family } = useWallet()
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  if (!wallet) return null
  const net = CHAINS[chain].label
  const enable = async () => {
    setBusy(true)
    try {
      await api("/api/wallets", { action: "unlock", id: wallet.id, password })
      toast.success(`${wallet.name} is ready on ${FAMILIES[family].label}`)
    } catch (e) {
      toast.error("Couldn't enable the wallet", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-1 items-center justify-center py-12">
      <Card className="w-full max-w-md text-center">
        <CardHeader className="items-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-400/20 to-violet-500/20">
            <NetworkIcon className={`size-6 ${CHAINS[chain].text}`} />
          </div>
          <CardTitle className="text-xl">
            {wallet.name} isn&apos;t on {net} yet
          </CardTitle>
          <CardDescription>
            {wallet.kind === "watch"
              ? `A watch-only wallet tracks one key. To watch ${net}, add its tpub / vpub as another watch-only wallet, or switch network.`
              : `${FAMILIES[family].label} uses its own account (m/84'/${family === "main" ? 0 : 1}'/0'), derived from this wallet's recovery words.`}
          </CardDescription>
        </CardHeader>
        {wallet.kind === "seed" && (
          <CardContent className="flex flex-col gap-2">
            {wallet.needsPassword && (
              <Input type="password" placeholder="Wallet password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && enable()} />
            )}
            <Button onClick={enable} disabled={busy || (wallet.needsPassword && !password)} className="gap-2">
              {busy && <Loader2Icon className="animate-spin" />} Enable on {FAMILIES[family].label}
            </Button>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
