import "server-only"
import net from "node:net"
import tls from "node:tls"
import { config } from "@/lib/server/config"

/** One JSON-RPC line: above a 4 MB raw tx in hex and Fulcrum's 125k-entry history cap; bounds a hostile server. */
const MAX_LINE = 16 * 1024 * 1024

type Handlers = {
  onConnect: () => void
  onDisconnect: () => void
  onNotify: (method: string, params: unknown[]) => void
}

/** Minimal Electrum JSON-RPC client (tcp:// or ssl://). Fails over through `urls` in order, backing off after a full cycle. */
export class Electrum {
  connected = false
  private socket?: net.Socket
  private buf = ""
  private nextId = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private ping?: NodeJS.Timeout
  private retry = 5_000
  private index = 0
  private closed = false
  private reconnect?: NodeJS.Timeout

  constructor(
    private urls: string[],
    private handlers: Handlers,
  ) {
    this.connect()
  }

  /** host:port of the server currently in use */
  get server() {
    return new URL(this.urls[this.index]).host
  }

  request<T>(method: string, params: unknown[] = []): Promise<T> {
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      if (!this.socket?.writable) return reject(new Error("Not connected"))
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 30_000)
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v as T)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      this.socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }

  /** Disconnect for good (extension disabled): no reconnects, pending requests fail. */
  close() {
    this.closed = true
    clearTimeout(this.reconnect)
    clearInterval(this.ping)
    this.connected = false
    for (const pending of this.pending.values()) pending.reject(new Error("Connection closed"))
    this.pending.clear()
    this.socket?.destroy()
  }

  private connect() {
    if (this.closed) return
    const { protocol, hostname, port } = new URL(this.urls[this.index])
    const secure = protocol === "ssl:" || protocol === "tls:"
    const socket = secure
      ? tls.connect({ host: hostname, port: Number(port), servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: !config.electrumSelfSigned.includes(hostname) })
      : net.connect({ host: hostname, port: Number(port) })
    this.socket = socket
    socket.setEncoding("utf8")
    socket.setTimeout(15_000, () => socket.destroy()) // connect + handshake timeout
    socket.once(secure ? "secureConnect" : "connect", async () => {
      socket.setKeepAlive(true)
      try {
        await this.request("server.version", ["gorilla-wallet", "1.4"])
        if (this.closed) return
        socket.setTimeout(0)
        this.connected = true
        this.retry = 5_000
        this.ping = setInterval(() => this.request("server.ping").catch(() => socket.destroy()), 60_000)
        this.handlers.onConnect()
      } catch {
        socket.destroy()
      }
    })
    socket.on("data", (chunk: string) => this.onData(chunk))
    socket.on("error", (e) => console.warn(`Electrum ${hostname}:${port}: ${e.message}`)) // "close" follows and handles reconnect
    socket.on("close", () => this.onClose())
  }

  private onData(chunk: string) {
    this.buf += chunk
    let nl
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      if (nl > MAX_LINE) return void this.socket?.destroy()
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msgs
      try {
        msgs = [JSON.parse(line)].flat()
      } catch {
        continue
      }
      for (const msg of msgs) {
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue
        if (typeof msg.method === "string") {
          if (!Array.isArray(msg.params)) continue
          this.handlers.onNotify(msg.method, msg.params)
          continue
        }
        const p = this.pending.get(msg.id)
        if (!p) continue
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message ?? "Electrum error"))
        else p.resolve(msg.result)
      }
    }
    if (this.buf.length > MAX_LINE) this.socket?.destroy()
  }

  private onClose() {
    const wasConnected = this.connected
    this.connected = false
    this.buf = ""
    clearInterval(this.ping)
    for (const p of this.pending.values()) p.reject(new Error("Connection closed"))
    this.pending.clear()
    if (wasConnected) this.handlers.onDisconnect()
    if (this.closed) return
    this.index = (this.index + 1) % this.urls.length
    // next server right away; back off only once every server has failed
    const delay = this.index === 0 ? this.retry : 1_000
    if (this.index === 0) this.retry = Math.min(this.retry * 2, 60_000)
    this.reconnect = setTimeout(() => this.connect(), delay)
  }
}
