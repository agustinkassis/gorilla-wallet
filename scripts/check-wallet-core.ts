import assert from "node:assert/strict"
import { descriptorChecksum } from "../lib/descriptors"
import { db } from "../lib/server/db"
import { receiveAddress } from "../lib/server/receive"
import { WrongPasswordError } from "../lib/server/secret"
import { createSeedWallet, deleteWallet, exportDescriptors, exportSeed, importWatchWallet } from "../lib/server/wallets"

async function main() {
  assert.ok(process.env.DATABASE_URL?.endsWith("wallet-core-check.db"), "Use isolated wallet-core-check.db")
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
  const wallet = await createSeedWallet({ name: "core checks", mnemonic, password: "correct horse", passphrase: "BIP39 test" })
  const plain = await createSeedWallet({ name: "plain checks", mnemonic })
  const account = wallet.accounts.main
  assert.ok(account)
  const watch = await importWatchWallet({ name: "watch checks", xpub: account.xpub, fingerprint: account.fingerprint.toString(16).padStart(8, "0") })
  try {
    assert.equal(descriptorChecksum("raw(deadbeef)"), "89f8spxm")
    assert.throws(() => descriptorChecksum("raw(Ü)"), /Invalid descriptor/)
    const descriptors = await exportDescriptors(watch.id, "main")
    assert.ok(descriptors.receive.startsWith(`wpkh([${account.fingerprint.toString(16).padStart(8, "0")}/84'/0'/0']${account.xpub}/0/*)#`))
    assert.match(descriptors.change, /\/1\/\*\)#[a-z0-9]{8}$/)
    assert.doesNotMatch(JSON.stringify(descriptors), /xprv|mnemonic|passphrase/)
    assert.match((await exportDescriptors(wallet.id, "test")).receive, /\]tpub/)
    console.log("PASS descriptors: BIP380 reference checksum, key origin, public receive/change branches and testnet key")

    await assert.rejects(exportSeed(wallet.id), /password/)
    await assert.rejects(exportSeed(wallet.id, "wrong password"), WrongPasswordError)
    assert.deepEqual(await exportSeed(wallet.id, "correct horse"), { mnemonic })
    assert.deepEqual(await exportSeed(wallet.id, "correct horse", true), { mnemonic, passphrase: "BIP39 test" })
    assert.deepEqual(await exportSeed(plain.id), { mnemonic })
    await assert.rejects(exportSeed(watch.id), /Watch-only/)
    console.log("PASS seed export: password required, incorrect password rejected, explicit passphrase, passwordless and watch-only cases")

    const first = await receiveAddress(wallet.id, "btc", { label: "shared label" })
    assert.equal(first.index, 0)
    const onXbt = await receiveAddress(wallet.id, "xbt") // same address on XBT, but labels are per chain
    assert.equal(onXbt.label, undefined)
    assert.deepEqual({ ...onXbt, label: first.label }, first)
    await db.$disconnect()
    assert.deepEqual(await receiveAddress(wallet.id, "btc"), first)
    const next = await receiveAddress(wallet.id, "xbt", { next: true })
    assert.equal(next.index, 1)
    assert.equal(await db.addressState.count({ where: { walletId: wallet.id, used: true } }), 0)
    assert.equal(await db.label.count({ where: { walletId: wallet.id, chain: "btc", ref: first.address, label: "shared label" } }), 1)
    await db.addressState.create({ data: { walletId: wallet.id, chain: "xbt", address: next.address, used: true } })
    const afterXbt = await receiveAddress(wallet.id, "btc")
    assert.equal(afterXbt.index, 2)
    await db.addressState.create({ data: { walletId: wallet.id, chain: "btc", address: afterXbt.address, used: true } })
    assert.equal((await receiveAddress(wallet.id, "xbt")).index, 3)
    assert.equal((await receiveAddress(wallet.id, "signet")).index, 0)
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => receiveAddress(wallet.id, "btc", { next: true })))
    assert.deepEqual(concurrent.map((r) => r.index).sort(), [4, 5, 6])
    assert.equal((await receiveAddress(wallet.id, "xbt")).index, 6)
    assert.equal((await receiveAddress(watch.id, "btc")).index, 0)
    console.log("PASS receive: repeat/persist, family sharing, explicit advance, skips do not mark used, BTC/XBT usage, shared label, independent test family, concurrent advances, watch-only")
  } finally {
    await deleteWallet(wallet.id)
    await deleteWallet(watch.id)
    await deleteWallet(plain.id)
    assert.equal(await db.receiveCursor.count({ where: { walletId: { in: [wallet.id, watch.id, plain.id] } } }), 0)
    await db.$disconnect()
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
