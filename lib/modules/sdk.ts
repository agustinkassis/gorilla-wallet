"use client"
// The module side of the bridge: the only way module code reaches the wallet. It runs in a sandboxed frame (opaque
// origin, no cookies or storage of the wallet, no network but this), so every call goes to the host by postMessage.
import { useEffect, useState } from "react"
import type { HttpRequest, HttpResponse, ModuleInfo, ModuleInit, RpcEvent, RpcRequest, RpcResponse, SendRequest } from "@/lib/modules/types"

const token = typeof location === "undefined" ? "" : location.hash.slice(1)
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const listeners = new Set<(info: ModuleInfo) => void>()
let seq = 0

if (typeof window !== "undefined")
  window.addEventListener("message", (e: MessageEvent<RpcResponse | RpcEvent>) => {
    const m = e.data
    if (e.source !== window.parent || m?.gorilla !== 1) return
    if ("event" in m) return listeners.forEach((l) => l(m.data))
    const p = pending.get(m.id)
    pending.delete(m.id)
    if (m.error !== undefined) p?.reject(new Error(m.error))
    else p?.resolve(m.result)
  })

function call<T>(method: string, params?: unknown): Promise<T> {
  // opened on its own: no wallet to answer (and our own message would come back as the "answer")
  if (window.parent === window) return Promise.reject(new Error("Not running inside Gorilla Wallet"))
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    window.parent.postMessage({ gorilla: 1, token, id, method, params } satisfies RpcRequest, "*")
  })
}

export const wallet = {
  info: () => call<ModuleInfo>("wallet.info"),
  /** needs "wallet:read" */
  balance: () => call<{ confirmed: number; unconfirmed: number }>("wallet.balance"),
  /** needs "wallet:receive" */
  receive: () => call<{ address: string }>("wallet.receive"),
  /** needs "wallet:send": the user reviews it in the wallet; resolves once broadcast, rejects if they decline */
  send: (request: SendRequest) => call<{ txid: string }>("wallet.send", request),
}

/** This module's own key/value store (JSON values up to 64 KB), kept by the wallet. */
export const storage = {
  get: <T = unknown>(key: string) => call<T | null>("storage.get", { key }),
  set: (key: string, value: unknown) => call<void>("storage.set", { key, value }),
}

/** HTTPS requests to the hosts in the manifest, made by the wallet's server (no CORS, no cookies). */
export const http = {
  fetch: (url: string, init: Omit<HttpRequest, "url"> = {}) => call<HttpResponse>("http.fetch", { ...init, url }),
}

export const ui = {
  toast: (message: string) => call<void>("ui.toast", { message }),
}

/** Handshake: the module's config and the network, kept fresh (new blocks, fees). Sizes the frame to the content. */
export function useModule() {
  const [init, setInit] = useState<ModuleInit | null>(null)
  useEffect(() => {
    let live = true
    const update = (info: ModuleInfo) => setInit((i) => i && { ...i, info })
    listeners.add(update)
    call<ModuleInit>("init").then((i) => {
      if (!live) return
      document.documentElement.classList.toggle("dark", i.theme === "dark")
      document.documentElement.style.colorScheme = i.theme
      setInit(i)
    })
    const resize = new ResizeObserver(() => void call("ui.resize", { height: document.body.offsetHeight }).catch(() => {}))
    resize.observe(document.body)
    return () => {
      live = false
      listeners.delete(update)
      resize.disconnect()
    }
  }, [])
  return init
}
