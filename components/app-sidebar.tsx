"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ArrowDownLeftIcon, ArrowLeftRightIcon, ArrowUpRightIcon, CoinsIcon, LayoutDashboardIcon, SettingsIcon } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { useWallet } from "@/components/wallet-provider"
import { WalletSwitcher } from "@/components/wallet-switcher"
import { CHAINS, pendingIncoming } from "@/lib/wallet"
import { cn } from "@/lib/utils"

export const NAV = [
  { href: "/", title: "Dashboard", icon: LayoutDashboardIcon },
  { href: "/send", title: "Send", icon: ArrowUpRightIcon },
  { href: "/receive", title: "Receive", icon: ArrowDownLeftIcon },
  { href: "/transactions", title: "Transactions", icon: ArrowLeftRightIcon, showsIncoming: true },
  { href: "/utxos", title: "UTXOs", icon: CoinsIcon },
  { href: "/settings", title: "Settings", icon: SettingsIcon },
]

/** Pulsing dot that marks an unconfirmed incoming payment. */
export function IncomingDot({ className }: { className?: string }) {
  return (
    <span className={cn("pointer-events-none absolute flex size-2", className)}>
      <span className="absolute inline-flex size-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" />
      <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
    </span>
  )
}

export function StatusDot({ on, className }: { on: boolean; className?: string }) {
  return (
    <span className={cn("relative flex size-2", className)}>
      {on && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
      <span className={cn("relative inline-flex size-2 rounded-full", on ? "bg-emerald-400" : "bg-amber-400")} />
    </span>
  )
}

export function AppSidebar() {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()
  const { snapshots, live, chains, chain: active } = useWallet()
  const incoming = pendingIncoming({ [active]: snapshots[active] }).length

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <WalletSwitcher />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Wallet</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname === item.href}
                    tooltip={item.showsIncoming && incoming ? `${item.title} · ${incoming} incoming` : item.title}
                  >
                    <Link href={item.href} onClick={() => setOpenMobile(false)} className="relative">
                      <item.icon />
                      <span>{item.title}</span>
                      {item.showsIncoming && incoming > 0 && (
                        <>
                          <IncomingDot className="top-1.5 left-5" />
                          <span className="ml-auto text-xs font-medium text-emerald-600 dark:text-emerald-400 group-data-[collapsible=icon]:hidden">
                            {incoming} incoming
                          </span>
                        </>
                      )}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {chains.map((chain) => {
            const s = snapshots[chain]
            const on = live && !!s?.connected
            return (
              <SidebarMenuItem key={chain}>
                <SidebarMenuButton
                  size="sm"
                  className="pointer-events-none"
                  tooltip={`${CHAINS[chain].label}: ${on ? `live via ${s?.server}` : "reconnecting"}`}
                >
                  <StatusDot on={on} className="mx-1" />
                  <span className="flex-1">{CHAINS[chain].label}</span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {s?.height ? `#${s.height.toLocaleString()}` : "—"}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
        <p className="px-2 font-mono text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          Gorilla Wallet v{process.env.APP_VERSION}
        </p>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
