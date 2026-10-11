import { requireNostr } from "@/lib/server/auth"
import { getSettings, onSettings } from "@/lib/server/settings"
import { currentSyncs, onSyncsChange, syncWatchers, type WalletSync } from "@/lib/server/watcher"
import { listWallets, onWalletsChange } from "@/lib/server/wallets"
import type { StreamMessage } from "@/lib/wallet"

/**
 * SSE: the wallet list, settings, then live snapshots for every wallet on every active chain.
 * One NIP-98 signature per connection; switching wallets in the UI needs no reconnect.
 * Follows changes live: wallets added/removed, the network switched (the selected chain and its replay pair).
 */
export async function GET(req: Request) {
  const denied = await requireNostr(req)
  if (denied) return denied

  let settings, wallets
  try {
    await syncWatchers()
    ;[settings, wallets] = await Promise.all([getSettings(), listWallets()])
  } catch {
    return Response.json({ error: "Server not ready" }, { status: 500 })
  }

  const enc = new TextEncoder()
  let cleanup = () => {}
  const stream = new ReadableStream({
    start(controller) {
      const write = (s: string) => {
        try {
          controller.enqueue(enc.encode(s))
        } catch {
          cleanup()
        }
      }
      const send = (msg: StreamMessage) => write(`data: ${JSON.stringify(msg)}\n\n`)

      send({ type: "wallets", wallets })
      send({ type: "settings", settings })
      const subs = new Map<WalletSync, () => void>()
      const attach = () => {
        const active = new Set(currentSyncs())
        for (const [sync, unsub] of subs)
          if (!active.has(sync)) {
            unsub()
            subs.delete(sync)
          }
        for (const sync of active)
          if (!subs.has(sync)) {
            send({ type: "snapshot", snapshot: sync.snapshot })
            subs.set(sync, sync.subscribe((snapshot) => send({ type: "snapshot", snapshot })))
          }
      }
      attach()
      const offSyncs = onSyncsChange(attach)
      const offSettings = onSettings((s) => send({ type: "settings", settings: s }))
      const offWallets = onWalletsChange(() => void listWallets().then((w) => send({ type: "wallets", wallets: w })))
      const ping = setInterval(() => write(": ping\n\n"), 25_000)
      cleanup = () => {
        clearInterval(ping)
        offSyncs()
        offSettings()
        offWallets()
        subs.forEach((u) => u())
        subs.clear()
      }
      const abort = () => {
        cleanup()
        try {
          controller.close()
        } catch {}
      }
      req.signal.addEventListener("abort", abort, { once: true })
      if (req.signal.aborted) abort()
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
