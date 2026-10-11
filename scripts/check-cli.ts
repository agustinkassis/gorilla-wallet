import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, readFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import net from "node:net"
import http from "node:http"
import { HDKey } from "@scure/bip32"
import { mnemonicToSeedSync } from "@scure/bip39"
import { Transaction } from "@scure/btc-signer"
import { hexToBytes } from "@noble/hashes/utils.js"
import { deriveAddress, scriptHash } from "@/lib/wallet"
import { parseArgs } from "@/lib/cli/args"
import { parseTxHex } from "@/lib/tx"

async function main() {
  const temporary = await mkdtemp(join(tmpdir(), "gorila-cli-"))
  const launcher = resolve("bin/gorila.mjs")
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
  const account = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive("m/84'/0'/0'")
  const address = deriveAddress(account.publicExtendedKey, 0, 0, "main").address
  const hash = scriptHash(address, "main")
  const destination = deriveAddress(account.publicExtendedKey, 0, 4, "main").address
  const seedFile = join(temporary, "seed.txt")
  const passwordFile = join(temporary, "password.txt")
  const passphraseFile = join(temporary, "passphrase.txt")
  await Promise.all([writeFile(seedFile, mnemonic), writeFile(passwordFile, "password123"), writeFile(passphraseFile, "separate BIP39 passphrase")])
  const crontabFile = join(temporary, "crontab.txt")
  const crontabBin = join(temporary, "fake-crontab.sh")
  await writeFile(crontabBin, `#!/bin/sh\nif [ "$1" = "-l" ]; then\n  if [ -f "${crontabFile}" ]; then cat "${crontabFile}"; exit 0; fi\n  echo "no crontab for fixture" >&2; exit 1\nfi\nif [ "$1" = "-" ]; then cat > "${crontabFile}"; exit 0; fi\nexit 2\n`, { mode: 0o755 })
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: `file:${join(temporary, "wallet.db")}`, SEED_PHRASE: "", NODE_ENV: "test", GORILA_CRONTAB_BIN: crontabBin, XDG_STATE_HOME: join(temporary, "state") }
  const sockets = new Set<net.Socket>()
  const broadcasts: { chain: string; hex: string }[] = []
  let rejectBroadcast = false
  let failStatus = false
  let failFees = false
  const funding = (value: bigint) => {
    const tx = new Transaction({ allowUnknownInputs: true })
    tx.addInput({ txid: "00".repeat(32), index: 0xffffffff })
    tx.addOutputAddress(address, value)
    tx.updateInput(0, { finalScriptSig: Uint8Array.of(1, 1) })
    return tx
  }
  const btc = funding(100_000n)
  const xbt = funding(200_000n)
  const chainServer = (chain: string, tx: Transaction) => net.createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString()
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        const funded = request.params?.[0] === hash
        let result: unknown = null
        switch (request.method) {
          case "server.version": result = ["fixture", "1.4"]; break
          case "blockchain.headers.subscribe": result = { height: 150 }; break
          case "blockchain.scripthash.subscribe": result = funded ? "funded" : null; break
          case "blockchain.scripthash.get_history": result = funded ? [{ tx_hash: tx.id, height: 100 }] : []; break
          case "blockchain.scripthash.listunspent": result = funded ? [{ tx_hash: tx.id, tx_pos: 0, height: 100, value: Number(tx.getOutput(0).amount) }] : []; break
          case "blockchain.scripthash.get_balance": result = { confirmed: funded ? Number(tx.getOutput(0).amount) : 0, unconfirmed: 0 }; break
          case "blockchain.block.header": { const header = Buffer.alloc(80); header.writeUInt32LE(1_700_000_000, 68); result = header.toString("hex"); break }
          case "blockchain.transaction.get": result = tx.hex; break
          case "blockchain.estimatefee": result = failFees ? -1 : 0.00002; break
          case "blockchain.transaction.broadcast": broadcasts.push({ chain, hex: request.params[0] }); result = parseTxHex(request.params[0]).id; break
        }
        socket.write(JSON.stringify({ id: request.id, result }) + "\n")
      }
    })
  })
  const btcServer = chainServer("btc", btc)
  const xbtServer = chainServer("xbt", xbt)
  const api = http.createServer((request, response) => {
    if (request.url?.endsWith("/fees/recommended")) {
      response.writeHead(failFees ? 503 : 200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ fastestFee: 3, halfHourFee: 2, hourFee: 2, economyFee: 1, minimumFee: 1 }))
    } else if (request.method === "POST" && request.url?.endsWith("/api/tx")) {
      let hex = ""
      request.on("data", (chunk) => { hex += chunk.toString() })
      request.on("end", () => {
        if (rejectBroadcast) { response.writeHead(422); response.end("Rejected by fixture network") }
        else {
          broadcasts.push({ chain: request.url?.startsWith("/xbt") ? "xbt" : "btc", hex })
          response.end(parseTxHex(hex).id)
        }
      })
    } else if (request.url?.endsWith("/status")) {
      if (failStatus) { response.writeHead(503); response.end() }
      else if (request.url.includes("aa".repeat(32))) response.end(JSON.stringify({ confirmed: true, block_height: 140 }))
      else if (request.url.includes("bb".repeat(32)) || request.url.includes("dd".repeat(32))) response.end(JSON.stringify({ confirmed: false }))
      else if (broadcasts.some((b) => request.url?.includes(parseTxHex(b.hex).id))) response.end(JSON.stringify({ confirmed: false }))
      else { response.writeHead(404); response.end() }
    } else if (request.url?.endsWith(`/api/tx/${"bb".repeat(32)}`)) {
      response.end(JSON.stringify({ txid: "bb".repeat(32) }))
    } else if (request.url?.endsWith("/blocks/tip/height")) response.end("150")
    else { response.writeHead(404); response.end() }
  })
  for (const server of [btcServer, xbtServer, api]) server.listen(0, "127.0.0.1")
  await Promise.all([once(btcServer, "listening"), once(xbtServer, "listening"), once(api, "listening")])
  const port = (server: net.Server) => { const addr = server.address(); assert.ok(addr && typeof addr !== "string"); return addr.port }
  const invoke = async (args: string[], success = true) => {
    const child = spawn(process.execPath, [launcher, ...args, ...(args.includes("--timeout") ? [] : ["--timeout", "5"]), "--json"], { cwd: temporary, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    const timer = setTimeout(() => {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
      else child.kill("SIGKILL")
    }, 30_000)
    const [code] = await once(child, "close")
    clearTimeout(timer)
    assert.equal(code, success ? 0 : 1, `${args.join(" ")}\n${stderr}\n${stdout}`)
    if (!success) { assert.equal(stdout, ""); return { error: stderr, result: null, stderr } }
    return { result: JSON.parse(stdout), stderr, error: "" }
  }
  try {
    assert.equal(parseArgs(["balance", "--json"]).json, true)
    const created = (await invoke(["wallet", "create", "--name", "generated24", "--password-file", passwordFile, "--passphrase-file", passphraseFile])).result
    assert.equal(created.mnemonic.split(" ").length, 24)
    const exported = (await invoke(["wallet", "export-seed", "--wallet", created.wallet.id, "--password-file", passwordFile, "--include-passphrase"])).result
    assert.equal(exported.mnemonic, created.mnemonic)
    assert.equal(exported.passphrase, "separate BIP39 passphrase")
    assert.match((await invoke(["wallet", "export-seed", "--wallet", created.wallet.id], false)).error, /terminal or an explicit secret file/)
    const wrongFile = join(temporary, "wrong.txt")
    await writeFile(wrongFile, "wrong-password")
    assert.match((await invoke(["wallet", "export-seed", "--wallet", created.wallet.id, "--password-file", wrongFile], false)).error, /password/i)
    const created12 = (await invoke(["wallet", "create", "--name", "generated12", "--words", "12"])).result
    assert.equal(created12.mnemonic.split(" ").length, 12)
    const imported = (await invoke(["wallet", "import", "--name", "fixture", "--seed-file", "seed.txt"])).result.wallet
    assert.equal((await invoke(["wallet", "list"])).result.wallets.length, 3)
    assert.equal((await invoke(["wallet", "export-seed", "--wallet", "fixture"])).result.mnemonic, mnemonic)
    assert.match((await invoke(["wallet", "descriptor", "--wallet", "fixture"])).result.receive, /^wpkh\(\[[0-9a-f]{8}\/84'\/0'\/0'\].*\/0\/\*\)#[a-z0-9]{8}$/)
    assert.match((await invoke(["balance"], false)).error, /Multiple wallets/)
    for (const [chain, server] of [["btc", btcServer], ["xbt", xbtServer]] as const) await invoke(["config", "set", "--chain", chain, "--electrum", "tcp://127.0.0.1:1", "--electrum", `tcp://127.0.0.1:${port(server)}`, "--mempool", `http://127.0.0.1:${port(api)}/${chain}`])
    const sources = (await invoke(["config", "show"])).result.chains
    assert.equal(sources[0].electrum.source, "Settings")
    assert.equal(sources[0].electrum.urls.length, 2)
    const balance = (await invoke(["balance", "--wallet", "fixture"])).result.balances
    assert.deepEqual(balance.map((b: { chain: string; total: number }) => [b.chain, b.total]), [["btc", 100_000], ["xbt", 200_000]])
    assert.equal((await invoke(["balance", "--chain", "btc", "--all-wallets"])).result.balances.length, 3)
    const receive = (await invoke(["receive", "--wallet", "fixture", "--label", "shared"])).result
    assert.equal(receive.index, 1)
    assert.equal((await invoke(["receive", "--wallet", "fixture"])).result.address, receive.address)
    assert.equal((await invoke(["receive", "--wallet", "fixture", "--next"])).result.index, 2)
    const nextResults = await Promise.all([invoke(["receive", "--wallet", "fixture", "--next"]), invoke(["receive", "--wallet", "fixture", "--next"])])
    assert.deepEqual(nextResults.map((r) => r.result.index).sort(), [3, 4])
    await invoke(["address", "label", address, "funding", "--wallet", "fixture"])
    const addresses = (await invoke(["addresses", "--wallet", "fixture"])).result.addresses
    const row = addresses.find((a: { address: string }) => a.address === address)
    assert.equal(row.label, "funding")
    assert.deepEqual(row.chains.map((c: { transactions: number }) => c.transactions), [1, 1])
    const transactions = (await invoke(["transactions", "--chain", "btc", "--wallet", "fixture"])).result.transactions
    assert.equal(transactions[0].confirmations, 51)
    assert.equal((await invoke(["tx-status", btc.id, "--chain", "btc", "--wallet", "fixture"])).result.confirmations, 51)
    assert.equal((await invoke(["tx-status", "aa".repeat(32), "--chain", "btc", "--wallet", "fixture"])).result.confirmations, 11)
    assert.equal((await invoke(["tx-status", "bb".repeat(32), "--chain", "btc", "--wallet", "fixture"])).result.confirmed, false)
    assert.equal((await invoke(["tx-status", "cc".repeat(32), "--chain", "btc", "--wallet", "fixture"])).result.found, false)
    assert.equal((await invoke(["tx-status", "dd".repeat(32), "--chain", "btc", "--wallet", "fixture"])).result.found, false)
    failStatus = true
    assert.match((await invoke(["tx-status", "cc".repeat(32), "--chain", "btc", "--wallet", "fixture"], false)).error, /inaccessible/)
    failStatus = false
    const send = ["send", "--wallet", imported.id, "--to", destination, "--amount-sats", "10000", "--fee-rate", "2"]
    assert.match((await invoke([...send, "--chain", "btc"], false)).error, /confirmation or --yes/)
    assert.equal(broadcasts.length, 0)
    assert.match((await invoke([...send, "--chain", "xbt", "--message", "hello", "--yes"], false)).error, /does not support --message/)
    assert.match((await invoke([...send.filter((a) => a !== "2" && a !== "--fee-rate"), "--chain", "btc", "--fee-rate", "0.5", "--yes"], false)).error, /fee-rate/)
    assert.match((await invoke(["send", "--wallet", imported.id, "--chain", "btc", "--to", destination, "--amount-sats", "9999999", "--fee-rate", "2", "--yes"], false)).error, /Insufficient funds/)
    failFees = true
    assert.match((await invoke(["send", "--wallet", imported.id, "--chain", "btc", "--to", destination, "--amount-sats", "10000", "--timeout", "3", "--yes"], false)).error, /supply --fee-rate/)
    failFees = false
    const sentBtc = await invoke([...send, "--chain", "btc", "--message", "hola", "--yes"])
    assert.equal(sentBtc.result.chain, "btc")
    assert.match(sentBtc.stderr, /"inputs"/)
    assert.equal(sentBtc.result.review.outputs.find((o: { kind: string }) => o.kind === "data").script.length, 168)
    const sentXbt = await invoke([...send, "--chain", "xbt", "--yes"])
    assert.equal(sentXbt.result.chain, "xbt")
    for (const broadcast of broadcasts) {
      const signed = Transaction.fromRaw(hexToBytes(broadcast.hex), { allowUnknownOutputs: true })
      const signature = signed.getInput(0).finalScriptWitness?.[0]
      assert.ok(signature)
      assert.equal(signature.at(-1), broadcast.chain === "btc" ? 1 : 0x21)
    }
    rejectBroadcast = true
    assert.match((await invoke([...send, "--chain", "btc", "--yes"], false)).error, /Rejected by fixture network/)
    assert.equal(broadcasts.length, 2)
    rejectBroadcast = false

    // forward: rules, crontab blocks, unattended sweeps with OP_RETURN
    await writeFile(crontabFile, "0 3 * * * /usr/bin/true # unrelated\n")
    const foreign = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
    type RuleOptions = { chain?: string; from?: string; to?: string; every?: string; cap?: string; wallet?: string }
    const rule = (extra: string[], o: RuleOptions = {}) => ["forward", "add", "--wallet", o.wallet ?? "fixture", "--chain", o.chain ?? "btc", "--from", o.from ?? address, "--to", o.to ?? destination, "--every", o.every ?? "5", "--max-fee-rate", o.cap ?? "5", ...extra]
    assert.match((await invoke(rule([]), false)).error, /confirmation or --yes/)
    assert.match((await invoke(rule(["--yes"], { chain: "xbt" }), false)).error, /OP_RETURN/)
    assert.match((await invoke(rule(["--yes"], { from: foreign }), false)).error, /does not belong/)
    assert.match((await invoke(rule(["--yes"], { to: address }), false)).error, /same address/)
    assert.match((await invoke(rule(["--yes"], { to: address.toUpperCase() }), false)).error, /same address/)
    assert.match((await invoke(rule(["--yes"], { every: "7" }), false)).error, /--every/)
    assert.match((await invoke(rule(["--yes"], { cap: "0" }), false)).error, /max-fee-rate/)
    const lockedAddress = (await invoke(["addresses", "--wallet", created.wallet.id])).result.addresses[0].address
    const encryptedRule = rule(["--yes"], { wallet: created.wallet.id, from: lockedAddress })
    assert.match((await invoke(encryptedRule, false)).error, /--password-file/)
    assert.match((await invoke([...encryptedRule, "--password-file", passwordFile], false)).error, /permissions/)
    await chmod(wrongFile, 0o600)
    assert.match((await invoke([...encryptedRule, "--password-file", wrongFile], false)).error, /password/i)
    assert.equal(broadcasts.length, 2)

    const capped = (await invoke(rule(["--yes"], { cap: "1" }))).result
    assert.match(capped.rule.id, /^[0-9a-f]{8}$/)
    assert.equal(capped.rule.opReturn, "random-90")
    assert.equal(capped.cron.schedule, "*/5 * * * *")
    const crontab = await readFile(crontabFile, "utf8")
    assert.match(crontab, /unrelated/)
    assert.ok(crontab.includes(`# BEGIN gorila-forward ${capped.rule.id}`) && crontab.includes(`# END gorila-forward ${capped.rule.id}`))
    assert.ok(crontab.includes(`forward run ${capped.rule.id}`))
    assert.ok(crontab.includes(`DATABASE_URL='file:${join(temporary, "wallet.db")}'`))
    const skipped = (await invoke(["forward", "run", capped.rule.id])).result
    assert.equal(skipped.status, "skipped")
    assert.match(skipped.reason, /fee above cap/)
    assert.equal(broadcasts.length, 2)

    const fresh = (await invoke(rule(["--yes", "--min-conf", "60"]))).result
    assert.equal((await invoke(["forward", "run", fresh.rule.id])).result.status, "idle")

    const message = "forwarded by gorila"
    const tagged = (await invoke(rule(["--yes", "--message", message], { every: "60" }))).result
    assert.equal(tagged.cron.schedule, "0 * * * *")
    const taggedPlan = (await invoke(["forward", "run", tagged.rule.id, "--dry-run"])).result
    assert.equal(taggedPlan.status, "dry-run")
    assert.ok(Buffer.from(taggedPlan.dataHex, "hex").toString("utf8").startsWith(message))

    const sweeping = (await invoke(rule(["--yes"]))).result
    const dry = await Promise.all([invoke(["forward", "run", sweeping.rule.id, "--dry-run"]), invoke(["forward", "run", sweeping.rule.id, "--dry-run"])])
    for (const d of dry) {
      assert.equal(d.result.status, "dry-run")
      assert.equal(d.result.dataHex.length, 180)
      assert.deepEqual(d.result.inputs.map((input: { txid: string }) => input.txid), [btc.id])
      assert.equal(d.result.amount + d.result.fee, 100_000)
    }
    assert.notEqual(dry[0].result.dataHex, dry[1].result.dataHex)
    assert.equal(broadcasts.length, 2)
    const runs = await Promise.all([invoke(["forward", "run", sweeping.rule.id]), invoke(["forward", "run", sweeping.rule.id])])
    assert.equal(broadcasts.length, 3)
    assert.equal(runs.filter((r) => r.result.status === "sent").length, 1)
    const sent = runs.find((r) => r.result.status === "sent")!.result
    const forwarded = parseTxHex(broadcasts[2].hex)
    assert.equal(forwarded.id, sent.txid)
    assert.equal(forwarded.inputsLength, 1)
    assert.equal(forwarded.outputsLength, 2)
    const outputs = [0, 1].map((i) => forwarded.getOutput(i))
    const data = outputs.find((o) => o.script?.[0] === 0x6a)!
    assert.equal(data.script!.length, 93)
    assert.equal(outputs.find((o) => o.script?.[0] !== 0x6a)!.amount, BigInt(sent.amount))
    assert.equal(sent.amount + sent.fee, 100_000)
    assert.equal(sent.feeRate, 2)
    assert.equal((await invoke(["forward", "run", sweeping.rule.id])).result.status, "idle")
    assert.equal(broadcasts.length, 3)

    const listed = (await invoke(["forward", "list"])).result.rules
    assert.equal(listed.length, 4)
    assert.ok(listed.every((r: { cron: string }) => r.cron === "installed"))
    assert.equal(listed.find((r: { id: string }) => r.id === sweeping.rule.id).lastRun.status, "sent")
    const detail = (await invoke(["forward", "show", sweeping.rule.id])).result
    assert.equal(detail.runs[0].txid, sent.txid)
    assert.ok(detail.cron.line.includes(`forward run ${sweeping.rule.id}`))
    assert.equal((await invoke(["forward", "show", capped.rule.id])).result.runs[0].status, "skipped")
    await writeFile(crontabFile, (await readFile(crontabFile, "utf8")).split("\n").filter((line) => !line.includes(fresh.rule.id)).join("\n"))
    assert.equal((await invoke(["forward", "list"])).result.rules.find((r: { id: string }) => r.id === fresh.rule.id).cron, "missing")
    const removed = (await invoke(["forward", "remove", sweeping.rule.id])).result
    assert.equal(removed.cronRemoved, true)
    const after = await readFile(crontabFile, "utf8")
    assert.ok(!after.includes(sweeping.rule.id))
    assert.ok(after.includes(capped.rule.id) && after.includes("unrelated"))
    assert.match((await invoke(["forward", "show", sweeping.rule.id], false)).error, /Unknown forward rule/)
    assert.equal((await invoke(["forward", "remove", fresh.rule.id])).result.cronRemoved, false)
    assert.equal((await invoke(["forward", "list"])).result.rules.length, 2)
    const unterminated = `# BEGIN gorila-forward ${capped.rule.id}\n* * * * * forward run ${capped.rule.id}\n0 4 * * * /usr/bin/true # after\n`
    await writeFile(crontabFile, unterminated)
    assert.match((await invoke(["forward", "remove", capped.rule.id], false)).error, /no "# END gorila-forward/)
    assert.equal(await readFile(crontabFile, "utf8"), unterminated)
    assert.match((await invoke(["balance", "--wallet", "fixture", "--electrum", "tcp://evil:1"], false)).error, /not valid/)
    console.log("CLI checks passed: all commands, shared database, secrets, satoshi balances, review/sign/broadcast fixtures, two-process cursor, foreign cwd and JSON")
  } finally {
    for (const socket of sockets) socket.destroy()
    btcServer.close(); xbtServer.close(); api.closeAllConnections(); api.close()
    await rm(temporary, { recursive: true, force: true })
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
