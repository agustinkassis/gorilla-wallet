"use client"

import { useRef } from "react"
import { usePathname } from "next/navigation"
import { nip19 } from "nostr-tools"
import { useTheme } from "next-themes"
import Link from "next/link"
import { BellIcon, ChevronDownIcon, CopyIcon, LogOutIcon, MonitorIcon, MoonIcon, SlidersHorizontalIcon, SunIcon, ZapIcon } from "lucide-react"
import { toast } from "sonner"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { IncomingDot, NAV } from "@/components/app-sidebar"
import { useNostr } from "@/components/nostr-provider"
import { UnitSwitch } from "@/components/units"
import { useWallet } from "@/components/wallet-provider"
import { WatchOnlyBadge } from "@/components/wallet-switcher"
import { api } from "@/lib/api"
import { canNotify, requestNotifications } from "@/lib/notify"
import { cn } from "@/lib/utils"
import { CHAINS, WEB_CHAIN_IDS, isChain, pendingIncoming, type Chain } from "@/lib/wallet"

export const shorten = (s: string, n = 8) => (s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s)

export function copy(text: string, label = "Copied") {
  navigator.clipboard.writeText(text).then(() => toast.success(label))
}

/** Until a soon chain forks, from Bitcoin's tip at 10-minute blocks: "2,485 blocks · ~17 d (Oct 31)". */
export function forkCountdown(chain: Chain, btcHeight?: number) {
  const fork = CHAINS[chain].forkHeight!
  if (!btcHeight) return `at block ${fork.toLocaleString()}`
  const left = fork - btcHeight
  if (left <= 0) return `forked at block ${fork.toLocaleString()}, waiting for its servers`
  const min = left * 10
  const eta = new Date(Date.now() + min * 60_000).toLocaleString(undefined, { month: "short", day: "numeric", ...(min < 2880 && { hour: "numeric", minute: "2-digit" }) })
  return `${left.toLocaleString()} block${left === 1 ? "" : "s"} · ~${min >= 2880 ? `${Math.round(min / 1440)} d` : min >= 120 ? `${Math.round(min / 60)} h` : `${min} min`} (${eta})`
}

export function SiteHeader() {
  const pathname = usePathname()
  const { pubkey, required, profile, login, logout } = useNostr()
  const { snapshots, chain, watchOnly } = useWallet()
  const incoming = pendingIncoming({ [chain]: snapshots[chain] }).length > 0
  const title = NAV.find((n) => n.href === pathname)?.title ?? "Gorilla Wallet"
  const npub = pubkey ? nip19.npubEncode(pubkey) : ""
  const name = profile?.display_name || profile?.name || shorten(npub, 6)

  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-2 rounded-t-xl border-b bg-background/50 px-4 backdrop-blur-xl">
      <div className="relative -ml-1">
        <SidebarTrigger />
        {incoming && <IncomingDot className="top-1 right-1 md:hidden" />}
      </div>
      <h1 className="font-heading text-xl font-semibold">{title}</h1>
      {watchOnly && <WatchOnlyBadge className="hidden sm:inline-flex" />}

      <div className="ml-auto flex items-center gap-1">
        {(pubkey || required === false) && <NetworkSwitcher />}
        <UnitSwitch />
        <ThemeToggle />
        {required === false ? null : pubkey === undefined || required === undefined ? (
          <Skeleton className="size-8 rounded-full" />
        ) : pubkey ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-9 gap-2 rounded-full pr-3 pl-1">
                <Avatar className="size-7 ring-2 ring-violet-500/40">
                  <AvatarImage src={profile?.picture} alt={name} />
                  <AvatarFallback className="text-xs">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <span className="hidden max-w-32 truncate text-sm sm:inline">{name}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="flex flex-col gap-0.5">
                <span className="truncate">{name}</span>
                <span className="truncate font-mono text-xs font-normal text-muted-foreground">{shorten(npub, 12)}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => copy(npub, "npub copied")}>
                <CopyIcon /> Copy npub
              </DropdownMenuItem>
              {canNotify() && Notification.permission === "default" && (
                <DropdownMenuItem onSelect={requestNotifications}>
                  <BellIcon /> Enable notifications
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onSelect={logout}>
                <LogOutIcon /> Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button size="sm" onClick={login} className="gap-2">
            <ZapIcon /> Connect Nostr
          </Button>
        )}
      </div>
    </header>
  )
}

/** The selected network, one at a time (a fork's replay pairs sync along in the background); upcoming ones count down. */
function NetworkSwitcher() {
  const { chain, settings, snapshots } = useWallet()
  const shown = WEB_CHAIN_IDS.filter((c) => c === chain || !settings.hidden.includes(c))
  const change = async (next: string) => {
    if (!isChain(next) || next === chain || CHAINS[next].soon) return
    try {
      await api("/api/settings", { chain: next })
    } catch (e) {
      toast.error("Couldn't switch network", { description: (e as Error).message })
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 rounded-full px-2.5" aria-label={`Network: ${CHAINS[chain].label}`}>
          <span className={cn("size-2.5 rounded-full shadow-[0_0_10px_currentColor]", CHAINS[chain].bg, CHAINS[chain].text)} />
          <span className="hidden font-medium sm:inline">{CHAINS[chain].label}</span>
          <ChevronDownIcon className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Network</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={chain} onValueChange={change}>
          {shown.filter((c) => !CHAINS[c].soon).map((c) => (
            <DropdownMenuRadioItem key={c} value={c} className="gap-2">
              <span className={cn("size-2 rounded-full", CHAINS[c].bg)} />
              <span className="flex-1">{CHAINS[c].label}</span>
              <span className="font-mono text-xs text-muted-foreground">{CHAINS[c].unit}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {shown.filter((c) => CHAINS[c].soon).map((c) => (
          <DropdownMenuLabel key={c} className="flex items-start gap-2 pr-8 text-sm font-normal text-foreground">
            <span className={cn("mt-1.5 size-2 shrink-0 rounded-full opacity-60", CHAINS[c].bg)} />
            <span className="flex flex-1 flex-col">
              <span className="flex items-center gap-1.5 opacity-70">
                {CHAINS[c].label} <Badge variant="outline" className="px-1.5 py-0 text-[10px]">Soon</Badge>
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">{forkCountdown(c, snapshots.btc?.height)}</span>
            </span>
            <span className="font-mono text-xs text-muted-foreground">{CHAINS[c].unit}</span>
          </DropdownMenuLabel>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <SlidersHorizontalIcon /> Sources &amp; features
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Theme change as a circle growing from `at` (lacrypta/blocks-ar, after theme-toggle.rdsx.dev): a View Transition
 * whose new snapshot is revealed by an animated clip-path. Instant without View Transitions or with reduced motion.
 * The class is set by hand inside the transition so the new snapshot already has the theme; next-themes catches up.
 */
function switchTheme(next: string, setTheme: (theme: string) => void, at: { x: number; y: number }) {
  const root = document.documentElement
  const dark = next === "dark" || (next === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  const apply = () => {
    root.classList.toggle("dark", dark)
    root.classList.toggle("light", !dark)
    root.style.colorScheme = dark ? "dark" : "light"
    setTheme(next)
  }
  if (dark === root.classList.contains("dark") || !("startViewTransition" in document) || matchMedia("(prefers-reduced-motion: reduce)").matches)
    return apply()
  const radius = Math.hypot(Math.max(at.x, innerWidth - at.x), Math.max(at.y, innerHeight - at.y))
  document
    .startViewTransition(apply)
    .ready.then(() =>
      root.animate(
        { clipPath: [`circle(0px at ${at.x}px ${at.y}px)`, `circle(${radius}px at ${at.x}px ${at.y}px)`] },
        { duration: 480, easing: "ease-in-out", pseudoElement: "::view-transition-new(root)" },
      ),
    )
    .catch(() => {})
}

/** Light / Dark / System. The icon swaps via CSS so server and client render the same markup. */
function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const button = useRef<HTMLButtonElement>(null)
  const change = (next: string) => {
    const r = button.current!.getBoundingClientRect()
    switchTheme(next, setTheme, { x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={button} variant="ghost" size="icon" aria-label="Theme">
          <SunIcon className="dark:hidden" />
          <MoonIcon className="hidden dark:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme} onValueChange={change}>
          <DropdownMenuRadioItem value="light">
            <SunIcon /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
