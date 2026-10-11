import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHAINS, WEB_CHAIN_IDS, familyOf, minDataScript, syncedChains } from "../lib/chains"
import { runCli } from "../lib/cli/run"
import { config } from "../lib/server/config"
import { parseSettings } from "../lib/server/settings"
import { openSyncSession } from "../lib/server/watcher"
import { db } from "../lib/server/db"
import { receiveAddress } from "../lib/server/receive"
import { createSeedWallet, deleteWallet, exportDescriptors, getWallet, importWatchWallet } from "../lib/server/wallets"
import { DEFAULT_SETTINGS, addressScript, displayXpub, scriptHash } from "../lib/wallet"

async function main() {
  assert.ok(process.env.DATABASE_URL?.endsWith("regtest-core-check.db"), "Use isolated regtest-core-check.db")
  const temporary = await mkdtemp(join(tmpdir(), "gorila-regtest-core-"))
  const ids: string[] = []
  try {
    // Given the built-in regtest registry, when resolving its sources and policy, then no public chain is selected.
    assert.equal(familyOf("regtest"), "regtest")
    assert.deepEqual(syncedChains("regtest"), ["regtest"])
    assert.deepEqual(CHAINS.regtest.electrum, [])
    assert.deepEqual(CHAINS.regtest.mempool, [])
    assert.equal(new Set<string>(WEB_CHAIN_IDS).has("regtest"), false)
    assert.equal(minDataScript("regtest"), 84)
    assert.deepEqual(config.sources("regtest", DEFAULT_SETTINGS), { electrum: [], mempool: [] })
    assert.throws(() => parseSettings({ chain: "regtest" }), /Invalid setting/)
    console.log("PASS regtest has isolated family, no public defaults, hidden web choice, and BTC data minimum")

    // Given one seed, when receiving on both families, then identical scripts coexist under distinct addresses/cursors.
    const wallet = await createSeedWallet({ name: "regtest core", mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", password: "correct horse" })
    ids.push(wallet.id)
    await assert.rejects(openSyncSession([wallet], ["regtest"], 1000), /No Electrum server configured for Regtest/)
    const regtest = await receiveAddress(wallet.id, "regtest", { label: "regtest only" })
    const test = await receiveAddress(wallet.id, "signet")
    assert.match(regtest.address, /^bcrt1q/)
    assert.match(test.address, /^tb1q/)
    assert.equal(regtest.path, "m/84'/1'/0'/0/0")
    assert.equal(scriptHash(regtest.address, "regtest"), scriptHash(test.address, "test"))
    assert.deepEqual(addressScript(regtest.address, "regtest"), addressScript(test.address, "test"))
    assert.throws(() => addressScript(test.address, "regtest"))
    assert.equal(await db.address.count({ where: { walletId: wallet.id } }), 2)
    await receiveAddress(wallet.id, "regtest", { next: true })
    assert.equal((await receiveAddress(wallet.id, "signet")).index, 0)
    assert.equal((await receiveAddress(wallet.id, "signet")).label, undefined)
    console.log("PASS migrated schema stores test/regtest identical scripthashes with independent cursors and labels")

    // Given a regtest tpub, when importing watch-only, then descriptors and receive addresses use the regtest account.
    const account = wallet.accounts.regtest
    assert.ok(account)
    const watch = await importWatchWallet({ name: "regtest watch", family: "regtest", xpub: displayXpub(account.xpub, "regtest"), fingerprint: account.fingerprint.toString(16).padStart(8, "0") })
    ids.push(watch.id)
    const descriptors = await exportDescriptors(watch.id, "regtest")
    assert.match(descriptors.receive, /\/84'\/1'\/0'\]tpub[^/]+\/0\/\*\)#[a-z0-9]{8}$/)
    assert.match(descriptors.change, /\/1\/\*\)#[a-z0-9]{8}$/)
    assert.equal((await receiveAddress(watch.id, "regtest")).address, regtest.address)
    assert.equal(watch.watchOnly, true)
    assert.equal(watch.accounts.test, undefined)
    await assert.rejects(importWatchWallet({ name: "wrong family", family: "regtest", xpub: account.xpub }), /network family/)
    console.log("PASS watch-only regtest tpub import and descriptors preserve account origin and bcrt addresses")

    // Given an encrypted legacy wallet missing regtest, when CLI receives passwords, then only the correct password enables it.
    await db.walletAccount.delete({ where: { walletId_family: { walletId: wallet.id, family: "regtest" } } })
    const passwordFile = join(temporary, "password.txt")
    await writeFile(passwordFile, "wrong password", { mode: 0o600 })
    const command = ["wallet", "descriptor", "--wallet", wallet.id, "--chain", "regtest", "--password-file", passwordFile]
    await assert.rejects(runCli(command))
    assert.equal((await getWallet(wallet.id)).accounts.regtest, undefined)
    await writeFile(passwordFile, "correct horse")
    const result = await runCli(command)
    assert.ok("family" in result)
    assert.equal(result.family, "regtest")
    assert.equal(result.path, "m/84'/1'/0'")
    assert.deepEqual((await getWallet(wallet.id)).accounts.regtest, account)
    console.log("PASS CLI rejects wrong password without creating account and enables legacy regtest with correct password")

    // Given explicit regtest sources, when CLI shows config, then it reports them after the existing default chains.
    await runCli(["config", "set", "--chain", "regtest", "--electrum", "tcp://127.0.0.1:50001", "--mempool", "http://127.0.0.1:3002"])
    const shown = await runCli(["config", "show"])
    assert.ok("chains" in shown && shown.chains)
    assert.deepEqual(shown.chains.map((entry) => entry.chain), ["btc", "xbt", "regtest"])
    assert.deepEqual(shown.chains[2].electrum.urls, ["tcp://127.0.0.1:50001"])
    assert.deepEqual(shown.chains[2].mempool.urls, ["http://127.0.0.1:3002"])
    console.log("PASS CLI config show reports regtest overrides after BTC/XBT")
  } finally {
    for (const id of ids) await deleteWallet(id)
    await db.setting.deleteMany()
    await db.$disconnect()
    await rm(temporary, { recursive: true, force: true })
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
