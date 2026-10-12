import assert from "node:assert/strict"
import { descriptorChecksum } from "../lib/descriptors"
import { db } from "../lib/server/db"
import { receiveAddress } from "../lib/server/receive"
import { WrongPasswordError } from "../lib/server/secret"
import * as walletOps from "../lib/server/wallets"
import { createSeedWallet, deleteWallet, exportDescriptors, exportSeed, importWatchWallet } from "../lib/server/wallets"

async function main() {
  assert.ok(process.env.DATABASE_URL?.endsWith("wallet-core-check.db"), "Use isolated wallet-core-check.db")
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
  const wallet = await createSeedWallet({ name: "core checks", mnemonic, password: "correct horse", passphrase: "BIP39 test" })
  const plain = await createSeedWallet({ name: "plain checks", mnemonic, passphrase: "keep this BIP39 passphrase" })
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

    const changeWalletPassword = walletOps.changeWalletPassword
    assert.equal(typeof changeWalletPassword, "function", "Existing wallets must support password changes")
    const plainReceive = await receiveAddress(plain.id, "btc", { next: true, label: "keep this tag" })
    await db.walletAccount.deleteMany({ where: { walletId: plain.id, family: "regtest" } })
    await db.tx.create({ data: { walletId: plain.id, chain: "btc", txid: "ab".repeat(32), height: 1, amount: 123n } })
    await db.forwardRule.create({ data: { id: "pwd-test", walletId: plain.id, chain: "btc", fromAddress: plainReceive.address, toAddress: plainReceive.address, everyMinutes: 5, maxFeeRate: 10, cronLine: "test only", logFile: "test only" } })
    const metadata = () => Promise.all([
      db.wallet.findUnique({ where: { id: plain.id }, select: { id: true, name: true, kind: true, passphrase: true, createdAt: true } }),
      db.walletAccount.findMany({ where: { walletId: plain.id }, orderBy: { family: "asc" } }),
      db.address.findMany({ where: { walletId: plain.id } }),
      db.receiveCursor.findMany({ where: { walletId: plain.id } }),
      db.label.findMany({ where: { walletId: plain.id } }),
      db.tx.findMany({ where: { walletId: plain.id } }),
      db.forwardRule.findMany({ where: { walletId: plain.id } }),
    ])
    const beforePassword = await metadata()
    const beforeSeed = (await db.wallet.findUniqueOrThrow({ where: { id: plain.id } })).encSeed
    for (const invalid of ["", "short", null, 123]) await assert.rejects(changeWalletPassword(plain.id, "", invalid), /8 characters/)
    assert.equal((await db.wallet.findUniqueOrThrow({ where: { id: plain.id } })).encSeed, beforeSeed)
    await changeWalletPassword(plain.id, "", "password123")
    assert.deepEqual(await metadata(), beforePassword)
    const sealedSeed = (await db.wallet.findUniqueOrThrow({ where: { id: plain.id } })).encSeed!
    assert.equal(JSON.parse(sealedSeed).kdf, "scrypt")
    assert.ok(!sealedSeed.includes(mnemonic))
    await assert.rejects(exportSeed(plain.id), /password/)
    await assert.rejects(changeWalletPassword(plain.id, "", "replacement123"), /current.*password/)
    await assert.rejects(changeWalletPassword(plain.id, "wrong password", "replacement123"), WrongPasswordError)
    assert.equal((await db.wallet.findUniqueOrThrow({ where: { id: plain.id } })).encSeed, sealedSeed)
    assert.deepEqual(await exportSeed(plain.id, "password123", true), { mnemonic, passphrase: "keep this BIP39 passphrase" })
    const signingBefore = (await walletOps.signingAccount(plain.id, "main", "password123")).keyFor(0, 0).publicKey
    await changeWalletPassword(plain.id, "password123", "replacement123")
    await assert.rejects(exportSeed(plain.id, "password123"), WrongPasswordError)
    assert.deepEqual(await exportSeed(plain.id, "replacement123", true), { mnemonic, passphrase: "keep this BIP39 passphrase" })
    assert.deepEqual((await walletOps.signingAccount(plain.id, "main", "replacement123")).keyFor(0, 0).publicKey, signingBefore)
    assert.deepEqual(await metadata(), beforePassword)
    await assert.rejects(changeWalletPassword(watch.id, "", "replacement123"), /software wallet/i)
    await assert.rejects(changeWalletPassword("missing-wallet", "", "replacement123"), /Unknown wallet/)
    await db.wallet.create({ data: { id: "password-env-check", name: "env check", kind: "env" } })
    try { await assert.rejects(changeWalletPassword("password-env-check", "", "replacement123"), /software wallet/i) }
    finally { await db.wallet.delete({ where: { id: "password-env-check" } }) }
    const rotations = await Promise.allSettled([changeWalletPassword(plain.id, "replacement123", "race-password-A"), changeWalletPassword(plain.id, "replacement123", "race-password-B")])
    assert.equal(rotations.filter((r) => r.status === "fulfilled").length, 1)
    const winner = rotations[0].status === "fulfilled" ? "race-password-A" : "race-password-B"
    const loser = rotations[0].status === "fulfilled" ? "race-password-B" : "race-password-A"
    assert.deepEqual(await exportSeed(plain.id, winner, true), { mnemonic, passphrase: "keep this BIP39 passphrase" })
    await assert.rejects(exportSeed(plain.id, loser), WrongPasswordError)
    assert.deepEqual(await metadata(), beforePassword)
    console.log("PASS wallet password: encrypt/decrypt, rotate, reject wrong/empty/short passwords, preserve keys and metadata, reject watch/env wallets, concurrent rotation has one winner")

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
    await db.forwardRule.deleteMany({ where: { walletId: plain.id } })
    await deleteWallet(wallet.id)
    await deleteWallet(watch.id)
    await deleteWallet(plain.id)
    assert.equal(await db.receiveCursor.count({ where: { walletId: { in: [wallet.id, watch.id, plain.id] } } }), 0)
    await db.$disconnect()
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
