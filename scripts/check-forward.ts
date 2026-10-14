import assert from "node:assert/strict"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import net from "node:net"
import http from "node:http"
import Database from "better-sqlite3"
import { Transaction } from "@scure/btc-signer"
import { bytesToHex } from "@noble/hashes/utils.js"
import { db } from "@/lib/server/db"
import { createSeedWallet } from "@/lib/server/wallets"
import { runForward } from "@/lib/server/forward"
import { acquireForwardLease } from "@/lib/server/forward-lease"
import { deriveAddress, scriptHash } from "@/lib/wallet"
import { parseTxHex, scriptFor } from "@/lib/tx"

async function main() {
  assert.ok(process.env.DATABASE_URL?.endsWith("forward-check.db"), "Use isolated forward-check.db")
  const legacy = new Database(":memory:")
  try {
    legacy.exec(await readFile("prisma/migrations/20261010120000_forward_rules/migration.sql", "utf8"))
    legacy.exec(`INSERT INTO ForwardRule (id,walletId,chain,fromAddress,toAddress,everyMinutes,maxFeeRate,cronLine,logFile)
      VALUES ('legacy','wallet','btc','A','B',5,10,'unchanged cron command','unchanged log')`)
    legacy.exec(`INSERT INTO ForwardRun (ruleId,status,txid,amount,fee,inputs) VALUES ('legacy','sent','known',12345,678,'[{"txid":"parent","vout":0,"value":13023}]')`)
    const before = legacy.prepare("SELECT * FROM ForwardRule").get()
    const history = legacy.prepare("SELECT * FROM ForwardRun").get()
    legacy.exec(await readFile("prisma/migrations/20261014120000_forward_amount_source_threshold/migration.sql", "utf8"))
    assert.deepEqual(legacy.prepare("SELECT * FROM ForwardRule").get(), { ...before as object, amountSats: null, balanceAboveSats: null })
    assert.deepEqual(legacy.prepare("SELECT * FROM ForwardRun").get(), { ...history as object, observedBalance: null })
    legacy.exec(`UPDATE ForwardRule SET fromAddress=NULL, amountSats=15000, balanceAboveSats=0`)
    console.log("PASS forward migration preserves legacy rules, cron lines and history; nullable source and amounts")
  } finally { legacy.close() }

  const wallet = await createSeedWallet({ name: "forward checks", mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", password: "" })
  const account = wallet.accounts.main!
  const a = deriveAddress(account.xpub, 0, 0, "main").address
  const b = deriveAddress(account.xpub, 0, 1, "main").address
  const c = deriveAddress(account.xpub, 1, 0, "main").address
  const nextChange = deriveAddress(account.xpub, 1, 2, "main").address
  const destination = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
  type Unspent = { txid: string; vout: number; value: number; address: string; height: number }
  let utxos: Unspent[] = []
  let serial = 0
  let tip = 150
  const raw = new Map<string, string>()
  const known = new Set<string>()
  const broadcasts: string[] = []
  let statusUnavailable = false
  let fees = { hourFee: 2, minimumFee: 1 }
  let beforeHistory: (() => Promise<void>) | undefined
  let beforeRejectedBroadcast: (() => Promise<void>) | undefined
  const sockets = new Set<net.Socket>()
  const fund = (address: string, value: number, height = 100) => {
    const tx = new Transaction({ allowUnknownInputs: true })
    tx.addInput({ txid: "00".repeat(32), index: 0xffffffff })
    tx.addOutputAddress(address, BigInt(value))
    tx.updateInput(0, { finalScriptSig: Uint8Array.of(1, ++serial) })
    raw.set(tx.id, tx.hex)
    const coin = { txid: tx.id, vout: 0, address, value, height }
    utxos.push(coin)
    return coin
  }
  const small = fund(a, 10_000)
  const large = fund(a, 40_000)
  const other = fund(b, 20_000)
  const internal = fund(c, 30_000)
  const frozen = fund(b, 50_000)
  fund(b, 70_000, 150)
  fund(a, 80_000, 0)
  await db.label.create({ data: { walletId: wallet.id, chain: "btc", type: "output", ref: `${frozen.txid}:0`, spendable: false } })
  // Change index 0 is used on BTC, and index 1 on its replay pair; only BTC is connected.
  const replayChange = deriveAddress(account.xpub, 1, 1, "main").address
  await db.addressState.create({ data: { walletId: wallet.id, chain: "xbt", address: replayChange, used: true } })
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
        void (async () => {
          const coins = utxos.filter((coin) => scriptHash(coin.address, "main") === request.params?.[0])
          let result: unknown = null
          switch (request.method) {
            case "server.version": result = ["forward fixture", "1.4"]; break
            case "blockchain.headers.subscribe": result = { height: tip }; break
            case "blockchain.scripthash.subscribe": result = coins.length ? JSON.stringify(coins) : null; break
            case "blockchain.scripthash.get_history":
              await beforeHistory?.()
              result = coins.map((coin) => ({ tx_hash: coin.txid, height: coin.height })); break
            case "blockchain.scripthash.listunspent": result = coins.map((coin) => ({ tx_hash: coin.txid, tx_pos: coin.vout, value: coin.value, height: coin.height })); break
            case "blockchain.scripthash.get_balance": result = { confirmed: coins.filter((c) => c.height > 0).reduce((s, c) => s + c.value, 0), unconfirmed: coins.filter((c) => c.height <= 0).reduce((s, c) => s + c.value, 0) }; break
            case "blockchain.block.header": { const header = Buffer.alloc(80); header.writeUInt32LE(1_700_000_000, 68); result = header.toString("hex"); break }
            case "blockchain.transaction.get": result = raw.get(request.params[0]); assert.ok(result, `Unknown fixture tx: ${request.params[0]}`); break
            case "blockchain.estimatefee": result = fees.hourFee / 100000; break
            case "blockchain.transaction.broadcast": broadcasts.push(request.params[0]); result = parseTxHex(request.params[0]).id; known.add(result as string); break
          }
          if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, result }) + "\n")
        })().catch((error) => { console.error(error); socket.destroy() })
      }
    })
  })
  const api = http.createServer((request, response) => {
    if (request.url?.endsWith("/fees/recommended")) {
      response.end(JSON.stringify({ ...fees, fastestFee: fees.hourFee, halfHourFee: fees.hourFee, economyFee: fees.hourFee }))
    } else if (request.url?.endsWith("/status")) {
      response.writeHead(statusUnavailable ? 503 : [...known].some((id) => request.url?.includes(id)) ? 200 : 404)
      response.end(JSON.stringify({ confirmed: false }))
    } else if (request.method === "POST" && beforeRejectedBroadcast) {
      void beforeRejectedBroadcast().then(() => { response.writeHead(503); response.end() }).catch((error) => { response.destroy(error) })
    } else { response.writeHead(503); response.end() }
  })
  server.listen(0, "127.0.0.1"); api.listen(0, "127.0.0.1")
  await Promise.all([once(server, "listening"), once(api, "listening")])
  const port = (s: net.Server) => (s.address() as net.AddressInfo).port
  const rules: string[] = []
  const add = async (fromAddress: string | null, amountSats: bigint | null, balanceAboveSats: bigint | null = null, cap = 10) => {
    const id = `check-${rules.length}`
    rules.push(id)
    await db.forwardRule.create({ data: { id, walletId: wallet.id, chain: "btc", fromAddress, toAddress: destination, amountSats, balanceAboveSats, everyMinutes: 5, minConf: 2, maxFeeRate: cap, cronLine: "never installed", logFile: "never written" } })
    return id
  }
  const dry = async (id: string) => runForward(id, { timeoutMs: 5000, dryRun: true })
  try {
    await db.setting.create({ data: { key: "sources", value: JSON.stringify({ btc: { electrum: [`tcp://127.0.0.1:${port(server)}`], mempool: [`http://127.0.0.1:${port(api)}`] }, xbt: { electrum: ["tcp://127.0.0.1:1"] } }) } })
    const fixedAddress = await add(a, 15_000n)
    const fixedWallet = await add(null, 15_000n)
    const sweepAddress = await add(a, null)
    const sweepWallet = await add(null, null)
    for (const [id, total, amount, selected, changeAddress] of [
      [fixedAddress, 40_000, 15_000, [large.txid], a],
      [fixedWallet, 20_000, 15_000, [other.txid], nextChange],
      [sweepAddress, 50_000, null, [small.txid, large.txid], null],
      [sweepWallet, 100_000, null, [small.txid, large.txid, other.txid, internal.txid], null],
    ] as const) {
      const review = await dry(id)
      assert.equal(review.status, "dry-run")
      assert.ok("inputs" in review && "amount" in review && "fee" in review && "change" in review && "observedBalance" in review)
      assert.equal(review.observedBalance, 100_000)
      assert.deepEqual(review.inputs!.map((i) => i.txid).sort(), [...selected].sort())
      if (amount !== null) assert.equal(review.amount, amount)
      assert.equal(review.amount! + review.fee! + (review.change?.amount ?? 0), total)
      assert.equal(review.change?.address ?? null, changeAddress)
    }
    assert.equal(broadcasts.length, 0)
    assert.equal(await db.forwardRun.count(), 0)
    assert.equal(await db.forwardLease.count(), 0)
    assert.ok((await db.forwardRule.findMany()).every((r) => r.lastCheckedAt === null))
    console.log("PASS all four source/payment modes, exact amount, selected inputs, change/replay branch, isolated dry run")

    for (const [threshold, status] of [[100001n, "skipped"], [100000n, "skipped"], [99999n, "dry-run"], [0n, "dry-run"]] as const) {
      const id = await add(a, 15_000n, threshold)
      const r = await dry(id)
      assert.equal(r.status, status)
      assert.ok("observedBalance" in r)
      assert.equal(r.observedBalance, 100_000)
      if (r.status === "skipped") assert.match(r.reason!, /balance.*100000.*threshold/)
    }
    const equalRule = await add(a, 15_000n, 100000n)
    assert.equal((await runForward(equalRule, { timeoutMs: 5000 })).status, "skipped")
    const equalHistory = await db.forwardRun.findFirstOrThrow({ where: { ruleId: equalRule } })
    assert.equal(equalHistory.observedBalance, 100000n)
    assert.deepEqual(JSON.parse(equalHistory.inputs), [])
    const insufficient = await dry(await add(a, 55_000n, 99999n))
    assert.equal(insufficient.status, "skipped")
    assert.match(insufficient.reason!, /Insufficient funds/)
    assert.equal((await dry(await add(a, 100n))).status, "skipped")
    const absorbed = await dry(await add(a, 39_300n, null, 2.5))
    assert.equal(absorbed.status, "skipped")
    assert.match(absorbed.reason!, /effective fee.*cap/)
    fees = { hourFee: 1, minimumFee: 3 }
    const floor = await dry(await add(a, null, null, 2))
    assert.equal(floor.status, "skipped")
    assert.equal(floor.feeRate, 3)
    fees = { hourFee: 2, minimumFee: 1 }
    console.log("PASS strict wallet threshold excludes frozen/low-confirmation coins; origin never subsidized, dust and effective fee caps")

    const reservedRule = await add(a, null)
    const reservedId = "aa".repeat(32)
    known.add(reservedId)
    await db.forwardRun.create({ data: { ruleId: reservedRule, status: "sent", txid: reservedId, inputs: JSON.stringify([large]) } })
    const reserved = await dry(await add(null, null, 60_000n))
    assert.equal(reserved.status, "skipped")
    assert.ok("observedBalance" in reserved)
    assert.equal(reserved.observedBalance, 60_000)
    statusUnavailable = true
    assert.equal((await dry(sweepAddress)).status, "dry-run")
    const unavailable = await dry(sweepWallet)
    assert.ok("observedBalance" in unavailable)
    assert.equal(unavailable.observedBalance, 60_000)
    statusUnavailable = false
    known.delete(reservedId)
    const evicted = await dry(sweepWallet)
    assert.ok("observedBalance" in evicted)
    assert.equal(evicted.observedBalance, 100_000)
    await db.forwardRule.update({ where: { id: reservedRule }, data: { chain: "xbt" } })
    known.add(reservedId)
    const differentChain = await dry(sweepWallet)
    assert.ok("observedBalance" in differentChain)
    assert.equal(differentChain.observedBalance, 100_000)
    console.log("PASS published inputs reserved across rules, unreachable status conservative, explicit eviction recovers, chains isolated")

    await db.forwardRule.update({ where: { id: fixedWallet }, data: { toAddress: b.toUpperCase() } })
    await assert.rejects(dry(fixedWallet), /destination.*belongs to this wallet/)
    await db.forwardRule.update({ where: { id: fixedWallet }, data: { toAddress: destination } })

    let unblock!: () => void
    const gate = new Promise<void>((resolve) => { unblock = resolve })
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    beforeHistory = async () => { entered(); await gate }
    // Force a fresh history fetch, so the winner is held in synchronization before the loser attempts its lease.
    await db.addressState.deleteMany({ where: { walletId: wallet.id, chain: "btc" } })
    const winner = runForward(fixedAddress, { timeoutMs: 5000 })
    await enteredPromise
    assert.equal((await runForward(sweepWallet, { timeoutMs: 5000 })).status, "busy")
    const held = await db.forwardLease.findUniqueOrThrow({ where: { walletId_chain: { walletId: wallet.id, chain: "btc" } } })
    unblock(); beforeHistory = undefined
    const sent = await winner
    assert.equal(sent.status, "sent")
    assert.equal(broadcasts.length, 1)
    assert.equal(await db.forwardLease.count(), 0)
    const history = await db.forwardRun.findFirstOrThrow({ where: { ruleId: fixedAddress, status: "sent" } })
    assert.deepEqual(JSON.parse(history.inputs).map((i: { txid: string }) => i.txid), [large.txid])
    const tx = parseTxHex(broadcasts[0])
    const outputs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i))
    assert.equal(outputs.find((o) => bytesToHex(o.script!) === bytesToHex(scriptFor(destination, "btc")))?.amount, 15000n)
    assert.equal(outputs.find((o) => bytesToHex(o.script!) === bytesToHex(scriptFor(a, "btc")))?.amount, BigInt(sent.change!.amount))
    assert.equal(history.fee! + outputs.reduce((s, o) => s + o.amount!, 0n), 40000n)
    console.log("PASS two different rules share lease, dry run bypasses it, signed exact payment and history only selected inputs")

    // Leave the fixture stale deliberately: published inputs must not be spent on a second cycle.
    const stale = await dry(sweepWallet)
    assert.ok("observedBalance" in stale)
    assert.equal(stale.observedBalance, 60_000)
    utxos = utxos.filter((u) => u.txid !== large.txid)
    raw.set(tx.id, tx.hex)
    for (let vout = 0; vout < tx.outputsLength; vout++) {
      const out = tx.getOutput(vout)
      if (bytesToHex(out.script!) === bytesToHex(scriptFor(a, "btc"))) utxos.push({ txid: tx.id, vout, address: a, value: Number(out.amount), height: 0 })
    }
    const repeat = await add(a, 15_000n, 75_000n)
    assert.equal((await runForward(repeat, { timeoutMs: 5000 })).status, "skipped")
    utxos = utxos.filter((u) => u.height !== 150)
    tip++
    for (const u of utxos) if (u.txid === tx.id) u.height = tip - 1
    const again = await runForward(repeat, { timeoutMs: 5000 })
    assert.equal(again.status, "sent")
    assert.ok("observedBalance" in again)
    assert.ok(again.observedBalance! > 75000)
    assert.equal(again.amount, 15000)
    assert.equal((await runForward(repeat, { timeoutMs: 5000 })).status, "skipped")
    assert.equal(broadcasts.length, 2)
    console.log("PASS confirmed address change funds later cycles; strict threshold stops subsequent sends")

    await db.forwardLease.create({ data: { walletId: wallet.id, chain: "btc", owner: "expired", expiresAt: new Date(0) } })
    assert.equal((await runForward(equalRule, { timeoutMs: 5000 })).status, "skipped")
    assert.equal(await db.forwardLease.count(), 0)
    await db.addressState.deleteMany({ where: { walletId: wallet.id, chain: "btc" } })
    let releaseLoss!: () => void
    const lossGate = new Promise<void>((resolve) => { releaseLoss = resolve })
    let lossEntered!: () => void
    const lossReady = new Promise<void>((resolve) => { lossEntered = resolve })
    beforeHistory = async () => { lossEntered(); await lossGate }
    const lost = runForward(sweepAddress, { timeoutMs: 5000 })
    await lossReady
    await db.forwardLease.update({ where: { walletId_chain: { walletId: wallet.id, chain: "btc" } }, data: { owner: "successor", expiresAt: held.expiresAt } })
    releaseLoss(); beforeHistory = undefined
    await assert.rejects(lost, /lease.*lost/i)
    assert.equal(broadcasts.length, 2)
    assert.equal((await db.forwardLease.findFirstOrThrow()).owner, "successor")
    console.log("PASS expired lease recovered; lost owner cannot sign/broadcast or release successor")

    await db.forwardLease.deleteMany()
    const heartbeat = await acquireForwardLease(wallet.id, "btc", 900)
    assert.ok(heartbeat)
    const originalExpiry = (await db.forwardLease.findFirstOrThrow()).expiresAt.getTime()
    try {
      // Wait past the original expiry: only automatic renewal can keep the competing rule busy.
      await new Promise((resolve) => setTimeout(resolve, 1100))
      assert.ok((await db.forwardLease.findFirstOrThrow()).expiresAt.getTime() > originalExpiry)
      assert.equal(await acquireForwardLease(wallet.id, "btc", 900), null)
      const separateChain = await acquireForwardLease(wallet.id, "regtest", 5000)
      assert.ok(separateChain)
      await separateChain.close()
      const runCount = await db.forwardRun.count()
      assert.equal((await dry(sweepAddress)).status, "dry-run")
      assert.equal(await db.forwardRun.count(), runCount)
      // Losing the lease is sticky: expiry recovery creates a successor that the old handle cannot release.
      await db.forwardLease.update({ where: { walletId_chain: { walletId: wallet.id, chain: "btc" } }, data: { expiresAt: new Date(0) } })
      await assert.rejects(heartbeat.assertOwned(), /lease.*lost/i)
      const successor = await acquireForwardLease(wallet.id, "btc", 5000)
      assert.ok(successor)
      try {
        await heartbeat.close()
        assert.equal(await db.forwardLease.count(), 1)
        await assert.rejects(heartbeat.assertOwned(), /lease.*lost/i)
      } finally { await successor.close() }
    } finally { await heartbeat.close() }
    console.log("PASS lease auto-renews past original expiry, chains isolated, occupied dry run untouched, expired owner fenced")

    // A lease can be lost after the first HTTP broadcast attempt fails. No later endpoint may publish it.
    beforeRejectedBroadcast = async () => {
      await db.forwardLease.update({ where: { walletId_chain: { walletId: wallet.id, chain: "btc" } }, data: { owner: "broadcast-successor" } })
    }
    const fallbackRule = await add(a, 5000n)
    await assert.rejects(runForward(fallbackRule, { timeoutMs: 5000 }), /lease.*lost/i)
    assert.equal(broadcasts.length, 2)
    assert.equal((await db.forwardLease.findFirstOrThrow()).owner, "broadcast-successor")
    assert.equal(await db.forwardRun.count({ where: { ruleId: fallbackRule, status: "sent" } }), 0)
    console.log("PASS lease lost during HTTP outage stops fallback publication and preserves successor")
  } finally {
    for (const socket of sockets) socket.destroy()
    server.close(); api.closeAllConnections(); api.close()
    await db.$disconnect()
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
