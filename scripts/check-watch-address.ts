import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"

const requireLocal = createRequire(import.meta.url)
const { WebSocketServer } = requireLocal("next/dist/compiled/ws")
async function main(unsupportedMempool = false) {
  const address = "bc1q7y4amw6us9dv4lp2zvpp4fa5y5au068x7wughw"
  const tx = (id: string, confirmed = false, incoming = true) => ({
    txid: id.repeat(64), status: { confirmed, block_height: confirmed ? 100 : undefined },
    vin: incoming ? [] : [{ prevout: { scriptpubkey_address: address, value: 5000 } }],
    vout: incoming ? [{ scriptpubkey_address: address, value: 700 }, { scriptpubkey_address: address, value: 500 }] : [{ scriptpubkey_address: "other", value: 4500 }],
  })
  let connections = 0
  const baseline = tx("a")
  const missed = tx("d")
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/api/tx/")) { res.writeHead(404); res.end(); return }
    assert.match(req.url ?? "", new RegExp(`/api/address/${address}/txs`))
    if (unsupportedMempool && req.url?.endsWith("/mempool")) { res.writeHead(404); res.end(); return }
    res.setHeader("Content-Type", "application/json")
    const history = connections > 1 ? [baseline, missed, ...(req.url?.endsWith("/mempool") ? [] : [tx("f", true)])] : [baseline]
    res.end(JSON.stringify(history))
  })
  const wss = new WebSocketServer({ server, path: "/api/v1/ws" })
  let subscriptions = 0
  wss.on("connection", (ws: { on: (event: string, cb: (data: Buffer) => void) => void; send: (data: string) => void; close: () => void }) => {
    connections++
    ws.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString())
      if (message.action === "ping") ws.send(JSON.stringify({ pong: true }))
      if (message["track-address"]) {
        assert.equal(message["track-address"], address)
        subscriptions++
        if (subscriptions === 1) void (async () => {
          await delay(150)
          ws.send("not-json")
          ws.send(JSON.stringify({ "address-transactions": [baseline, tx("b"), tx("b"), tx("c", false, false), tx("e"), tx("f")] }))
          ws.send(JSON.stringify({ "block-transactions": [tx("b", true), tx("b", true)] }))
          ws.send(JSON.stringify({ "address-removed-transactions": [tx("c", false, false)] }))
          await delay(250)
          ws.close()
        })()
        else void (async () => {
          ws.send(JSON.stringify({ "address-transactions": [tx("f")] }))
          await delay(200)
          ws.send(JSON.stringify({ "block-transactions": [tx("f", true)], "address-transactions": [tx("e")], pong: true }))
        })()
      }
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = (server.address() as { port: number }).port
  const child = spawn(process.execPath, ["scripts/watch-address.mjs", address, "--mempool", `http://127.0.0.1:${port}`, "--interval", "1"], { stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  let exited = false
  child.stdout.on("data", (data) => { output += data })
  child.stderr.on("data", (data) => { output += data })
  child.on("exit", () => { exited = true })
  const completion = once(child, "exit")
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 120; i++) {
      if (predicate()) return
      assert.ok(!output.includes("Historial HTTP 404"), `Missing optional endpoint must not prevent listening:\n${output}`)
      assert.equal(exited, false, `Monitor exited early:\n${output}`)
      await delay(100)
    }
    assert.fail(`Monitor timed out:\n${output}`)
  }
  try {
    await until(() => output.includes(missed.txid) && output.includes("PONG"))
    await delay(300)
    assert.equal(subscriptions, 2, "Reconnect must subscribe again")
    assert.equal(output.split(`RECIBIDO +1200 sats | txid: ${tx("b").txid}`).length - 1, 1)
    assert.equal(output.split(`RECIBIDO +1200 sats | txid: ${missed.txid}`).length - 1, 1, "REST must recover events missed offline")
    assert.equal(output.split(`CONFIRMADO | txid: ${tx("b").txid}`).length - 1, 1)
    assert.ok(!output.includes(`RECIBIDO +1200 sats | txid: ${baseline.txid}`), "Existing transactions are not new payments")
    assert.match(output, /SALIDA -5000 sats/)
    assert.match(output, /RETIRADA.*cccc/)
    assert.equal(output.split(`CONFIRMADO | txid: ${tx("f").txid}`).length - 1, 1, "Stale buffered mempool events must not undo REST confirmations")
    assert.match(output, /RETIRADA.*eeee/, "Removal while offline must be reconciled")
    assert.match(output, /REINGRESADA.*eeee/, "Returning evicted transactions must be announced")
    child.kill("SIGINT")
    assert.deepEqual(await completion, [0, null], output)
    const invalid = spawnSync(process.execPath, ["scripts/watch-address.mjs", address, "--mempool", "ftp://example.com"])
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr.toString(), /HTTP/)
    const badInterval = spawnSync(process.execPath, ["scripts/watch-address.mjs", address, "--interval", "0"])
    assert.equal(badInterval.status, 1)
    console.log("Address monitor checks passed (events, deduplication, baseline, reconnect, heartbeat, SIGINT, arguments)")
  } finally {
    if (!exited) { child.kill("SIGKILL"); await completion }
    for (const client of wss.clients) client.terminate()
    wss.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
main().then(() => main(true)).catch((error) => { console.error(error); process.exitCode = 1 })
