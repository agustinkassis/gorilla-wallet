import assert from "node:assert/strict"
import net from "node:net"
import { spawn } from "node:child_process"
import http from "node:http"
import { once } from "node:events"
import { HDKey } from "@scure/bip32"
import { db } from "../lib/server/db"
import { openSyncSession, currentChains } from "../lib/server/watcher"
import { deriveAddress, scriptHash, type WalletInfo } from "../lib/wallet"

async function main() {
  assert.match(process.env.DATABASE_URL ?? "", /sync-check\.db$/)
  let stalled = false
  let subscriptions = 0
  let feeAborted = false
  let feeRespond = false
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString()
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (stalled && request.method === "blockchain.scripthash.subscribe") continue
        let result: unknown = null
        switch (request.method) {
          case "server.version": result = ["fixture", "1.4"]; break
          case "blockchain.headers.subscribe": result = { height: 123 }; break
          case "blockchain.scripthash.subscribe": subscriptions++; break
          case "blockchain.scripthash.get_history":
          case "blockchain.scripthash.listunspent": result = []; break
          case "blockchain.scripthash.get_balance": result = { confirmed: 0, unconfirmed: 0 }; break
          case "blockchain.estimatefee": result = 0.00002; break
        }
        socket.write(JSON.stringify({ id: request.id, result }) + "\n")
      }
    })
  })
  const fees = http.createServer((request, response) => {
    if (feeRespond) { response.writeHead(503); response.end() }
    else request.on("close", () => { feeAborted = true })
  })
  server.listen(0, "127.0.0.1")
  fees.listen(0, "127.0.0.1")
  await Promise.all([once(server, "listening"), once(fees, "listening")])
  const address = server.address()
  const feeAddress = fees.address()
  assert.ok(address && typeof address !== "string")
  assert.ok(feeAddress && typeof feeAddress !== "string")
  const xpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(1)).derive("m/84'/0'/0'").publicExtendedKey
  const wallet: WalletInfo = { id: "session-test", name: "fixture", kind: "watch", accounts: { main: { xpub, path: "m/84'/0'/0'", fingerprint: 0 } }, watchOnly: true, needsPassword: false, passphrase: false }
  let active: Awaited<ReturnType<typeof openSyncSession>> | undefined
  try {
    await db.setting.deleteMany()
    for (const [key, value] of Object.entries({ chain: "tbtc4", gapReceive: 5, gapChange: 5, sources: { btc: { electrum: ["tcp://127.0.0.1:1", `tcp://127.0.0.1:${address.port}`], mempool: [`http://127.0.0.1:${feeAddress.port}`] } } })) {
      await db.setting.create({ data: { key, value: JSON.stringify(value) } })
    }
    await db.address.deleteMany({ where: { walletId: wallet.id } })
    await db.addressState.deleteMany({ where: { walletId: wallet.id } })
    await db.receiveCursor.upsert({ where: { walletId_family: { walletId: wallet.id, family: "main" } }, create: { walletId: wallet.id, family: "main", index: 8 }, update: { index: 8 } })
    const skipped = deriveAddress(xpub, 0, 8, "main").address
    await db.address.create({ data: { walletId: wallet.id, family: "main", address: skipped, change: 0, index: 8, scripthash: scriptHash(skipped, "main") } })
    const session = await openSyncSession([wallet], ["btc"], 5000)
    active = session
    const snapshot = session.snapshots()[0]
    assert.equal(snapshot.height, 123)
    assert.equal(snapshot.addresses.filter((a) => a.change === 0).length, 14)
    assert.equal(subscriptions, 19)
    assert.equal(snapshot.synced, true)
    assert.deepEqual(currentChains(), {})
    assert.equal((await db.setting.findUnique({ where: { key: "chain" } }))?.value, '"tbtc4"')
    await session.close()
    active = undefined
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(sockets.size, 0)
    assert.equal(feeAborted, true)
    console.log("PASS fresh discovery, gap past cursor, sparse indices, failover, settings isolation, socket/fetch shutdown")

    stalled = true
    const start = Date.now()
    await assert.rejects(openSyncSession([wallet], ["btc"], 1500), /Synchronization timed out/)
    assert.ok(Date.now() - start < 2500)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(sockets.size, 0)
    console.log("PASS cached synced rows cannot satisfy fresh session; bounded timeout drains pending work")
    stalled = false
    feeRespond = true
    const withFees = await openSyncSession([wallet], ["btc"], 5000)
    active = withFees
    assert.equal((await withFees.client("btc").waitForFees(2000)).halfHourFee, 2)
    const ref = `${"a".repeat(64)}:0`
    await db.utxo.create({ data: { walletId: wallet.id, chain: "btc", txid: "a".repeat(64), vout: 0, address: skipped, value: 10000n, height: 1 } })
    await db.label.createMany({ data: [
      { walletId: wallet.id, chain: "btc", type: "output", ref, label: "display override", spendable: false },
      { walletId: wallet.id, chain: "xbt", type: "output", ref, spendable: true },
    ] })
    const sync = withFees.client("btc").syncs.get(wallet.id)
    assert.ok(sync)
    await sync.publish()
    assert.equal(withFees.snapshots()[0].utxos[0].frozen, true)
    await withFees.close()
    active = undefined
    console.log("PASS unavailable HTTP fee source falls back to fresh Electrum estimates")
    console.log("PASS a freeze applies to its own chain, whatever the other chain says")

    // Given a writer holding SQLite longer than its busy timeout, when syncing, then this session retries after release.
    await db.address.deleteMany({ where: { walletId: wallet.id } })
    const databaseUrl = process.env.DATABASE_URL
    assert.ok(databaseUrl)
    const locker = spawn(process.execPath, ["-e", `
      const Database = require("better-sqlite3")
      const database = new Database(process.argv[1])
      database.exec("BEGIN IMMEDIATE")
      process.stdout.write("locked\\n")
      setTimeout(() => { database.exec("ROLLBACK"); database.close() }, 6500)
    `, databaseUrl.replace(/^file:/, "")], { stdio: ["ignore", "pipe", "pipe"] })
    const lockerExit = once(locker, "exit")
    try {
      await once(locker.stdout, "data")
      const recovered = await openSyncSession([wallet], ["btc"], 15_000)
      active = recovered
      assert.equal(recovered.snapshots()[0].synced, true)
      assert.equal(recovered.client("btc").syncs.get(wallet.id)?.lastError, undefined)
      assert.equal((await lockerExit)[0], 0)
      await recovered.close()
      active = undefined
      console.log("PASS same sync session recovers after real SQLite writer exceeds busy timeout and clears lastError")
    } finally {
      if (locker.exitCode === null) locker.kill()
    }
  } finally {
    await active?.close()
    for (const socket of sockets) socket.destroy()
    server.close()
    fees.closeAllConnections()
    fees.close()
    await db.$disconnect()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
