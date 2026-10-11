"use client"

import { nip98 } from "nostr-tools"
import { waitForNostr } from "@/components/nostr-provider"

let login: Promise<boolean> | undefined
/** Whether the server asks for a Nostr login (ALLOWED_PUBKEYS is set). Asked once per page load. */
export function loginRequired() {
  login ??= fetch("/api/access")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((r: { login: boolean }) => r.login)
    .catch((e) => {
      login = undefined
      throw e
    })
  return login
}

/** NIP-98 Authorization header, bound to a POST body via the `payload` tag; none when the app runs without login. */
export async function authHeaders(url: string, method: string, body?: object): Promise<Record<string, string>> {
  if (!(await loginRequired())) return {}
  const nostr = await waitForNostr()
  // a nonce makes every event unique: the server refuses a reused event id on writes (replay protection)
  return { Authorization: await nip98.getToken(url, method, (e) => nostr.signEvent({ ...e, tags: [...e.tags, ["nonce", crypto.randomUUID()]] }), true, body) }
}

/** Call to our backend, NIP-98 signed when login is on. Throws an Error with the server's message on failure. */
export async function api<T = unknown>(path: string, body?: object): Promise<T> {
  const url = `${location.origin}${path}`
  const method = body ? "POST" : "GET"
  const res = await fetch(url, {
    method,
    headers: { ...(await authHeaders(url, method, body)), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`)
  return (res.headers.get("content-type")?.includes("json") ? res.json() : res.text()) as Promise<T>
}

/** Save bytes/text as a file in the browser. */
export function download(name: string, data: BlobPart, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = Object.assign(document.createElement("a"), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
