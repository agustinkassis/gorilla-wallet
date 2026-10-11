"use client"

import { useState } from "react"
import { AlertTriangleIcon, BookUserIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { shorten } from "@/components/site-header"
import { UnitLabel, useUnit } from "@/components/units"
import { useWallet } from "@/components/wallet-provider"
import { KIND } from "@/components/wallet-switcher"
import { FAMILIES, formatAmount, nextUnused, type Chain, type WalletInfo } from "@/lib/wallet"

/** Your own receive addresses on `chain`, per wallet: used or labeled ones, plus the next unused one. */
function useMyAddresses(chain: Chain) {
  const { wallets, allSnapshots } = useWallet()
  return wallets.flatMap((w) => {
    const next = nextUnused(allSnapshots[w.id] ?? {}, 0)?.address
    const list = (allSnapshots[w.id]?.[chain]?.addresses ?? [])
      .filter((a) => a.change === 0 && (a.used || a.label || a.address === next))
      .sort((a, b) => a.index - b.index)
      .map((a) => ({ ...a, name: a.label ?? (a.address === next ? "Next unused" : `Receive #${a.index}`) }))
    return list.length ? [{ wallet: w, list }] : []
  })
}

/** Recipient address field with a picker for your own addresses, showing labels and balances. Opens on this wallet; others are a switch away. */
export function RecipientAddress({
  chain,
  value,
  onChange,
  disabled,
  index,
}: {
  chain: Chain
  value: string
  onChange: (address: string) => void
  disabled?: boolean
  index: number
}) {
  const { wallet, family } = useWallet()
  const unit = useUnit()
  const groups = useMyAddresses(chain)
  const [picked, setPicked] = useState<string>()
  const [switching, setSwitching] = useState(false)
  const shown = groups.find((g) => g.wallet.id === picked) ?? groups.find((g) => g.wallet.id === wallet?.id) ?? groups[0]
  const other = shown && shown.wallet.id !== wallet?.id
  const mine = groups.flatMap((g) => g.list.map((a) => ({ ...a, wallet: g.wallet }))).find((a) => a.address === value.trim())

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="relative">
        <Input
          disabled={disabled}
          placeholder={`${FAMILIES[family].network.bech32}1… address`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="pr-10 font-mono text-xs"
          aria-label={`Recipient ${index + 1} address`}
        />
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) setPicked(wallet?.id)
            setSwitching(false)
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              disabled={disabled || groups.length === 0}
              className="absolute top-1/2 right-1 size-7 -translate-y-1/2 rounded-md text-muted-foreground"
              aria-label="Pick one of my addresses"
              title="My addresses"
            >
              <BookUserIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-80 overflow-y-auto">
            {shown && groups.length > 1 && (
              <>
                <DropdownMenuSub open={switching} onOpenChange={setSwitching}>
                  <DropdownMenuSubTrigger className="gap-2">
                    <WalletName w={shown.wallet} current={!other} />
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-60">
                    <DropdownMenuRadioGroup value={shown.wallet.id} onValueChange={setPicked}>
                      {groups.map(({ wallet: w }) => (
                        <DropdownMenuRadioItem
                          key={w.id}
                          value={w.id}
                          className="gap-2"
                          onSelect={(e) => {
                            e.preventDefault() // stay in the picker: just show that wallet's addresses
                            setSwitching(false)
                          }}
                        >
                          <WalletName w={w} current={w.id === wallet?.id} />
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
              </>
            )}
            {shown && (
              <DropdownMenuGroup>
                {shown.list.map((a) => (
                  <DropdownMenuItem key={a.address} onSelect={() => onChange(a.address)} className="gap-3">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{a.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">{shorten(a.address, 10)}</span>
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums">
                      {formatAmount(a.confirmed + a.unconfirmed, unit)} <UnitLabel chain={chain} />
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            )}
            {other && (
              <p className="sticky bottom-0 -mx-1 -mb-1 flex items-center gap-1.5 border-t border-destructive/20 bg-popover px-2.5 py-1.5 text-xs text-destructive">
                <AlertTriangleIcon className="size-3.5 shrink-0" /> Different wallet: this pays {shown.wallet.name}, not {wallet?.name}.
              </p>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {mine && (
        <p className="truncate px-1 text-xs text-muted-foreground">
          {mine.wallet.id === wallet?.id ? "This wallet" : mine.wallet.name} · {mine.name}
        </p>
      )}
    </div>
  )
}

/** A wallet's kind icon and name, with "This wallet" on the selected one (same look as the sidebar switcher). */
function WalletName({ w, current }: { w: WalletInfo; current: boolean }) {
  const Icon = KIND[w.kind].icon
  return (
    <>
      <Icon className="text-muted-foreground" />
      <span className="flex-1 truncate">{w.name}</span>
      {current && <span className="text-xs text-muted-foreground">This wallet</span>}
    </>
  )
}
