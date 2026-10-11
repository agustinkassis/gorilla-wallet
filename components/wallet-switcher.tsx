"use client"

import { useState } from "react"
import { CheckIcon, ChevronsUpDownIcon, EyeIcon, FileKeyIcon, KeyRoundIcon, PlusIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
import { AddWalletDialog } from "@/components/add-wallet"
import { GorillaLogo } from "@/components/logo"
import { useWallet } from "@/components/wallet-provider"
import { UnitLabel, useUnit } from "@/components/units"
import { CHAINS, FAMILIES, formatAmount, sumBalances, type WalletKind } from "@/lib/wallet"
import { cn } from "@/lib/utils"

export const KIND: Record<WalletKind, { label: string; icon: typeof KeyRoundIcon }> = {
  env: { label: "From .env", icon: FileKeyIcon },
  seed: { label: "Software wallet", icon: KeyRoundIcon },
  watch: { label: "Watch-only", icon: EyeIcon },
}

/** Marks a wallet without keys: it can watch balances but not sign. */
export function WatchOnlyBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("gap-1 border-sky-500/40 text-sky-600 dark:text-sky-400", className)}>
      <EyeIcon /> Watch-only
    </Badge>
  )
}

/** Sidebar header: the selected wallet, a dropdown to switch between wallets, and "Add wallet". */
export function WalletSwitcher() {
  const { wallets, wallet, selectWallet, allSnapshots, chain, family } = useWallet()
  const unit = useUnit()
  const { isMobile, setOpenMobile } = useSidebar()
  const [adding, setAdding] = useState(false)
  const balance = (id: string) => sumBalances(allSnapshots[id]?.[chain])

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent" aria-label="Switch wallet">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-[#b20e18] shadow-md">
                <GorillaLogo className="size-6" />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">{wallet?.name ?? "Gorilla Wallet"}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {wallet ? (wallet.watchOnly ? "Watch-only" : KIND[wallet.kind].label) : "No wallet yet"}
                  {` · ${CHAINS[chain].label}`}
                </span>
              </div>
              <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-64" align="start" side={isMobile ? "bottom" : "right"} sideOffset={4}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Wallets</DropdownMenuLabel>
            {wallets.map((w) => {
              const Icon = KIND[w.kind].icon
              const bal = balance(w.id)
              return (
                <DropdownMenuItem
                  key={w.id}
                  onSelect={() => {
                    selectWallet(w.id)
                    setOpenMobile(false)
                  }}
                  className="gap-2"
                >
                  <Icon className="text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1.5 truncate">
                      {w.name}
                      {w.watchOnly && <EyeIcon className="size-3 text-sky-600 dark:text-sky-400" />}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {w.accounts[family] ? (
                        <>
                          {formatAmount(bal.confirmed + bal.unconfirmed, unit)} <UnitLabel chain={chain} />
                        </>
                      ) : (
                        `not on ${FAMILIES[family].label} yet`
                      )}
                    </span>
                  </span>
                  {w.id === wallet?.id && <CheckIcon className="size-4" />}
                </DropdownMenuItem>
              )
            })}
            {wallets.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => setAdding(true)} className="gap-2">
              <PlusIcon /> Add wallet
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AddWalletDialog open={adding} onOpenChange={setAdding} />
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
