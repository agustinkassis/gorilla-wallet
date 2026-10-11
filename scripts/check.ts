// Run: pnpm check  (react-server condition lets us import the server-only modules; uses its own data/check.db)
import assert from "node:assert/strict"
import fs from "node:fs"
import { HDKey } from "@scure/bip32"
import { mnemonicToSeedSync } from "@scure/bip39"
import { RawTx, SigHash, Transaction, p2pkh, p2wpkh } from "@scure/btc-signer"
import { secp256k1 } from "@noble/curves/secp256k1.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { finalizeEvent, generateSecretKey, getPublicKey, nip98 } from "nostr-tools"
import { familyPath } from "../lib/chains"
import { amountInput, deriveAddresses, displayXpub, formatAmount, normalizeXpub, parseAccountKey, parseAmount, parseCoins, scriptHash, txEvents, type Snapshot, type Tx } from "../lib/wallet"
import { db } from "../lib/server/db"
import { WrongPasswordError, isLocked, seal, unseal } from "../lib/server/secret"
import { createSeedWallet, deleteWallet, importWatchWallet, listWallets, setFingerprint, signingAccount, unlockAccounts } from "../lib/server/wallets"
import { addressFor, buildPsbt, cpfpFee, feeAt, importSigned, opReturnScript, outputRuleError, planTx, rbfFee, scriptFor, type Coin } from "../lib/tx"
import { SIGHASH_ALL_UNIFIED, unifiedSighash, type ScriptType } from "../lib/unified-sighash"
import { requireNostr } from "../lib/server/auth"
import { validRef } from "../lib/server/labels"
import { parseSettings } from "../lib/server/settings"
import { headerTime } from "../lib/server/watcher"
import { signWith, type SignContext } from "../lib/server/sign-core"

const throws = async (fn: () => unknown, re: RegExp) => {
  try {
    await fn()
  } catch (e) {
    return assert.match((e as Error).message, re)
  }
  assert.fail(`expected error ${re}`)
}

;(async () => {
  if (!process.env.DATABASE_URL?.includes("check.db")) throw new Error("pnpm check must run against data/check.db, never the wallet database")

  // --- Keys & addresses: BIP84 test vector -------------------------------------------------
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
  const master = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic))
  const account = master.derive("m/84'/0'/0'")
  const xpub = account.publicExtendedKey
  assert.deepEqual(deriveAddresses(xpub, "main", 2), ["bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"])
  assert.equal(deriveAddresses(xpub, "main", 1, 1)[0], "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el")
  // BIP84 account zpub → the same key as an xpub
  assert.deepEqual(normalizeXpub("zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs"), { xpub, family: "main" })
  assert.deepEqual(normalizeXpub(xpub), { xpub, family: "main" })
  await throws(() => normalizeXpub(account.privateExtendedKey), /xpub\/zpub/)
  // testnets and signet: coin type 1' (m/84'/1'/0'), tb1 addresses, vpub/tpub keys
  const testXpub = master.derive("m/84'/1'/0'").publicExtendedKey
  assert.equal(deriveAddresses(testXpub, "test", 1)[0], "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl")
  assert.deepEqual(normalizeXpub(displayXpub(testXpub, "test")), { xpub: testXpub, family: "test" })
  assert.equal(familyPath("m/84'/0'/0'", "test"), "m/84'/1'/0'")
  assert.equal(familyPath("m/84'/1'/3'", "main"), "m/84'/0'/3'")

  // --- Seed encryption: right password opens it, wrong one fails authentication ----------------
  const sealed = await seal("abandon … about", "correct horse")
  assert.equal(await unseal(sealed, "correct horse"), "abandon … about")
  await assert.rejects(unseal(sealed, "wrong horse"), WrongPasswordError)
  // no password: stored as-is, flagged unlocked
  assert.ok(isLocked(sealed) && !isLocked(await seal("abandon … about", "")))
  assert.equal(await unseal(await seal("abandon … about", ""), ""), "abandon … about")

  assert.equal(scriptHash("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "main"), "8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161")
  assert.equal(
    headerTime(
      "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c",
    ),
    1231006505,
  )
  assert.equal(parseCoins("0.0015"), 150_000)
  assert.equal(parseCoins("1"), 100_000_000)
  assert.equal(parseCoins("0.123456789"), null)
  assert.equal(parseCoins("abc"), null)
  // sats unit: whole numbers only (a "." is never a thousands separator), and fields round-trip across the switch
  assert.equal(parseAmount("150,000", "sats"), 150_000)
  assert.equal(parseAmount("0.0015", "sats"), null)
  assert.equal(parseAmount("150.000", "sats"), null)
  assert.equal(formatAmount(150_000, "sats"), "150,000")
  assert.equal(parseAmount(amountInput(parseAmount("0.0015", "btc")!, "sats"), "sats"), 150_000)
  assert.equal(amountInput(parseAmount("150000", "sats")!, "btc"), "0.00150000")

  // --- Incoming-tx events -----------------------------------------------------------------
  const snap = (txs: Tx[], synced = true): Snapshot => ({
    walletId: "w", chain: "btc", connected: true, synced, server: null, height: 100, explorer: "", fees: null, addresses: [], utxos: [], txs,
  })
  const tx = (txid: string, height: number, amount: number): Tx => ({ txid, height, amount, time: null })
  const old = tx("old", 50, 1000)
  assert.deepEqual(txEvents(undefined, snap([old])), [])
  assert.deepEqual(txEvents(snap([], false), snap([old])), [])
  const kinds = (a: Tx[], b: Tx[]) => txEvents(snap(a), snap(b)).map((e) => `${e.kind}:${e.tx.txid}`)
  assert.deepEqual(kinds([old], [old, tx("in", 0, 500), tx("out", 0, -500)]), ["received:in"])
  assert.deepEqual(kinds([old, tx("in", 0, 500)], [old, tx("in", 101, 500)]), ["confirmed:in"])
  assert.deepEqual(kinds([old], [old, tx("fast", 101, 700)]), ["received:fast"])

  // --- SIGHASH_UNIFIED: all 166 Knots reference vectors -----------------------------------
  // scripts/vectors/unified_sighash.json: bitcoinknots/bitcoin v29.4.2.knots20260508, src/test/data (MIT)
  const vectors = JSON.parse(fs.readFileSync(new URL("./vectors/unified_sighash.json", import.meta.url), "utf8")).slice(1)
  for (const [scriptCode, raw, idx, hashType, scriptType, spentOutputs, expected] of vectors) {
    const t = RawTx.decode(hexToBytes(raw))
    const got = unifiedSighash(
      { version: t.version, lockTime: t.lockTime, inputs: t.inputs, outputs: t.outputs },
      idx,
      spentOutputs.map(([v, s]: [number, string]) => ({ amount: BigInt(v), script: hexToBytes(s) })),
      hashType,
      scriptType as ScriptType,
      hexToBytes(scriptCode),
    )
    assert.equal(bytesToHex(got), expected, `unified vector type ${scriptType} hashType ${hashType}`)
  }
  assert.equal(vectors.length, 166)

  // --- Planner: chain rules, OP_RETURN guard, coin selection, fee policies ---------------------
  const addr0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
  const change0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el"
  const dest = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"
  assert.equal(opReturnScript(new Uint8Array(), "btc").length, 84) // padded: Blake rejects > 83
  assert.ok(opReturnScript(new Uint8Array(500), "btc").length > 84)
  assert.match(outputRuleError("xbt", opReturnScript(new Uint8Array(), "btc"))!, /not allowed on Blake/)
  assert.match(outputRuleError("xbt", Uint8Array.of(0x6a, 1, 0))!, /not allowed on Blake/) // policy, though consensus allows ≤ 83
  assert.match(outputRuleError("xbt", new Uint8Array(35))!, /34 bytes/)
  assert.match(outputRuleError("btc", Uint8Array.of(0x6a, 1, 0))!, /≥ 84/)
  assert.equal(outputRuleError("btc", opReturnScript(new Uint8Array(10), "btc")), null)
  // chains without a replay pair: no padding, no minimum, their own addresses
  assert.equal(opReturnScript(Uint8Array.of(1, 2), "tbtc4").length, 4)
  assert.equal(outputRuleError("signet", Uint8Array.of(0x6a, 1, 0)), null)
  await throws(() => scriptFor(addr0, "tbtc4"), /Invalid Testnet4 address/)
  assert.equal(addressFor(scriptFor("tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl", "tbtc3"), "signet"), "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl")

  const coin = (txid: string, value: number, height = 100): Coin => ({ txid, vout: 0, value, address: addr0, change: 0, index: 0, height })
  const coins = [coin("a".repeat(64), 50_000), coin("b".repeat(64), 20_000), coin("c".repeat(64), 5_000)]
  // single best-fit coin, with change
  let p = planTx({ chain: "btc", recipients: [{ address: dest, amount: 10_000 }], candidates: coins, fee: feeAt(2), changeAddress: change0 })
  assert.deepEqual(p.inputs.map((c) => c.value), [20_000])
  assert.equal(p.outputs.find((o) => o.kind === "change")!.amount + 10_000 + p.fee, 20_000)
  // changeless when the excess is smaller than a change output's cost
  p = planTx({ chain: "btc", recipients: [{ address: dest, amount: 4_700 }], candidates: coins, fee: feeAt(1), changeAddress: change0 })
  assert.equal(p.outputs.some((o) => o.kind === "change"), false)
  assert.equal(p.fee, 300)
  // accumulation when no single coin is enough
  p = planTx({ chain: "btc", recipients: [{ address: dest, amount: 60_000 }], candidates: coins, fee: feeAt(1), changeAddress: change0 })
  assert.equal(p.inputs.length, 2)
  // send max sweeps everything selected, no change
  p = planTx({ chain: "btc", recipients: [{ address: dest, amount: 0 }], sendMax: true, candidates: coins, fee: feeAt(1), changeAddress: change0 })
  assert.equal(p.outputs[0].amount + p.fee, 75_000)
  await throws(() => planTx({ chain: "btc", recipients: [{ address: dest, amount: 100 }], candidates: coins, fee: feeAt(1), changeAddress: change0 }), /dust/)
  await throws(() => planTx({ chain: "btc", recipients: [{ address: dest, amount: 1e9 }], candidates: coins, fee: feeAt(1), changeAddress: change0 }), /Insufficient/)
  await throws(() => planTx({ chain: "btc", recipients: [{ address: "nope", amount: 1e4 }], candidates: coins, fee: feeAt(1), changeAddress: change0 }), /Invalid Bitcoin address/)
  await throws(
    () => planTx({ chain: "xbt", recipients: [{ address: dest, amount: 1e4 }], candidates: coins, fee: feeAt(1), changeAddress: change0, data: new Uint8Array(1) }),
    /not allowed on Blake/,
  )
  p = planTx({ chain: "btc", recipients: [{ address: dest, amount: 10_000 }], candidates: coins, fee: feeAt(1), changeAddress: change0, data: new Uint8Array(3) })
  assert.ok(p.outputs.some((o) => o.kind === "data" && o.script.length === 84))
  // BIP125: replacement pays more than the original + its own relay cost; CPFP reaches the package rate
  assert.equal(rbfFee(2, 1000)(150), 1150)
  assert.equal(rbfFee(20, 1000)(150), 3000)
  assert.equal(cpfpFee(10, 200, 200)(110), 2900)

  // --- Signing round trip on both chains (BIP84 test seed) ----------------------------------
  const funding = new Transaction({ allowUnknownInputs: true })
  funding.addInput({ txid: "11".repeat(32), index: 0 })
  funding.addOutputAddress(addr0, 100_000n)
  const fundingId = funding.id
  const ctx = (overrides: Partial<SignContext> = {}): SignContext => ({
    fingerprint: master.fingerprint,
    accountPath: "m/84'/0'/0'",
    keyFor: (c, i) => {
      const k = account.deriveChild(c).deriveChild(i)
      return { privateKey: k.privateKey!, publicKey: k.publicKey! }
    },
    prevOut: async (txid, vout) => {
      assert.equal(txid, fundingId)
      return funding.getOutput(vout)
    },
    frozen: new Set(),
    ...overrides,
  })
  const fundCoin: Coin = { txid: fundingId, vout: 0, value: 100_000, address: addr0, change: 0, index: 0, height: 100 }
  const psbtFor = (chain: "btc" | "xbt", data?: Uint8Array) => {
    const plan = planTx({ chain, recipients: [{ address: dest, amount: 40_000 }], candidates: [fundCoin], fee: feeAt(3), changeAddress: change0, data })
    return buildPsbt(plan, { chain, xpub, fingerprint: master.fingerprint, accountPath: "m/84'/0'/0'", tipHeight: 970_000 }).toPSBT()
  }
  const pub0 = account.deriveChild(0).deriveChild(0).publicKey!

  const btc = await signWith("btc", psbtFor("btc", new Uint8Array(5)), ctx())
  let signed = Transaction.fromRaw(hexToBytes(btc.hex), { allowUnknownOutputs: true })
  let [sig, pub] = signed.getInput(0).finalScriptWitness!
  assert.equal(sig[sig.length - 1], SigHash.ALL)
  assert.deepEqual(pub, pub0)
  assert.ok(
    secp256k1.verify(sig.slice(0, -1), signed.preimageWitnessV0(0, p2pkh(pub0).script, SigHash.ALL, 100_000n), pub0, { prehash: false, format: "der" }),
    "BTC signature verifies against the BIP143 preimage",
  )
  assert.equal(signed.lockTime, 970_000)
  assert.equal(signed.getInput(0).sequence, 0xfffffffd)

  const xbt = await signWith("xbt", psbtFor("xbt"), ctx())
  signed = Transaction.fromRaw(hexToBytes(xbt.hex), { allowUnknownOutputs: true })
  ;[sig, pub] = signed.getInput(0).finalScriptWitness!
  assert.equal(sig[sig.length - 1], SIGHASH_ALL_UNIFIED, "Blake signature carries ALL|UNIFIED")
  const unsigned = {
    version: signed.version,
    lockTime: signed.lockTime,
    inputs: [{ txid: signed.getInput(0).txid!, index: 0, sequence: signed.getInput(0).sequence! }],
    outputs: Array.from({ length: signed.outputsLength }, (_, i) => signed.getOutput(i) as { amount: bigint; script: Uint8Array }),
  }
  const uh = unifiedSighash(unsigned, 0, [{ amount: 100_000n, script: p2wpkh(pub0).script }], SIGHASH_ALL_UNIFIED, 1, p2pkh(pub0).script)
  assert.ok(secp256k1.verify(sig.slice(0, -1), uh, pub0, { prehash: false, format: "der" }), "Blake signature verifies against the UNIFIED sighash")
  assert.ok(
    !secp256k1.verify(sig.slice(0, -1), signed.preimageWitnessV0(0, p2pkh(pub0).script, SIGHASH_ALL_UNIFIED, 100_000n), pub0, { prehash: false, format: "der" }),
    "…and not against Bitcoin's BIP143 message for the same byte (replay protection)",
  )

  // external signer round trip: a finalized tx, or a PSBT with partial sigs, must match what we built
  const btcPsbt = psbtFor("btc")
  const btcSigned = await signWith("btc", btcPsbt, ctx())
  assert.equal(importSigned("btc", btcPsbt, btcSigned.hex).txid, btcSigned.txid)
  const partial = Transaction.fromPSBT(btcPsbt)
  partial.signIdx(account.deriveChild(0).deriveChild(0).privateKey!, 0, [SigHash.ALL]) // signed, not finalized
  assert.equal(importSigned("btc", btcPsbt, partial.toPSBT()).txid, btcSigned.txid)
  const otherPlan = planTx({ chain: "btc", recipients: [{ address: dest, amount: 40_000 }], candidates: [fundCoin], fee: feeAt(3), changeAddress: change0 })
  const otherPsbt = buildPsbt(otherPlan, { chain: "btc", xpub, fingerprint: master.fingerprint, accountPath: "m/84'/0'/0'", tipHeight: 970_001 }).toPSBT()
  await throws(() => importSigned("btc", otherPsbt, btcSigned.hex), /different transaction/) // other locktime → other tx
  const xbtPsbt = psbtFor("xbt")
  const xbtSigned = await signWith("xbt", xbtPsbt, ctx())
  assert.equal(importSigned("xbt", xbtPsbt, xbtSigned.hex).txid, xbtSigned.txid)
  const xbtAsBtc = Transaction.fromPSBT(xbtPsbt)
  xbtAsBtc.updateInput(0, { sighashType: SigHash.ALL }, true) // a signer that ignores UNIFIED
  xbtAsBtc.signIdx(account.deriveChild(0).deriveChild(0).privateKey!, 0, [SigHash.ALL]) // legacy sig on a Blake tx
  await throws(() => importSigned("xbt", xbtPsbt, xbtAsBtc.toPSBT()), /SIGHASH_UNIFIED/)

  // signer refusals
  await throws(() => signWith("btc", psbtFor("btc"), ctx({ frozen: new Set([`${fundingId}:0`]) })), /frozen/)
  await throws(() => signWith("btc", psbtFor("btc"), ctx({ fingerprint: 0x12345678 })), /not from this wallet/)
  await throws(() => signWith("btc", psbtFor("btc"), ctx({ prevOut: async () => ({ script: p2wpkh(pub0).script, amount: 99_999n }) })), /amount or script/)
  await throws(() => signWith("xbt", psbtFor("btc", new Uint8Array(5)), ctx()), /not allowed on Blake/)

  // --- Wallets: .env default, software (password), watch-only ---------------------------------
  process.env.SEED_PHRASE = mnemonic
  process.env.DERIVATION_PATH = "m/84'/0'/0'"
  const envWallet = (await listWallets()).find((w) => w.id === "env")!
  assert.equal(envWallet.accounts.main?.xpub, xpub)
  assert.equal(envWallet.accounts.test?.xpub, testXpub)
  assert.equal((await signingAccount("env", "main")).fingerprint, master.fingerprint)
  const soft = await createSeedWallet({ name: "check soft", mnemonic, password: "password1" })
  assert.ok(soft.needsPassword && !soft.watchOnly)
  assert.deepEqual(soft.accounts.test, { xpub: testXpub, path: "m/84'/1'/0'", fingerprint: master.fingerprint })
  await throws(() => signingAccount(soft.id, "main"), /password/)
  await assert.rejects(signingAccount(soft.id, "main", "nope-nope"), WrongPasswordError)
  assert.deepEqual((await signingAccount(soft.id, "main", "password1")).keyFor(0, 0).publicKey, account.deriveChild(0).deriveChild(0).publicKey)
  assert.deepEqual((await signingAccount(soft.id, "test", "password1")).keyFor(0, 0).publicKey, master.derive("m/84'/1'/0'/0/0").publicKey)
  // a wallet from before testnets: its test account comes back with the password (unlock), not without it
  await db.walletAccount.delete({ where: { walletId_family: { walletId: soft.id, family: "test" } } })
  await throws(() => signingAccount(soft.id, "test", "password1"), /isn't enabled on Testnet/)
  await assert.rejects(unlockAccounts(soft.id, "nope-nope"), WrongPasswordError)
  assert.equal((await unlockAccounts(soft.id, "password1")).accounts.test?.xpub, testXpub)
  await throws(() => createSeedWallet({ name: "check short", mnemonic, password: "short" }), /8 characters/)
  const open = await createSeedWallet({ name: "check open", mnemonic })
  assert.ok(!open.needsPassword)
  assert.deepEqual((await signingAccount(open.id, "main")).keyFor(0, 0).publicKey, account.deriveChild(0).deriveChild(0).publicKey)
  // passwordless: a missing family is derived on its own
  await db.walletAccount.delete({ where: { walletId_family: { walletId: open.id, family: "test" } } })
  assert.equal((await listWallets()).find((w) => w.id === open.id)?.accounts.test?.xpub, testXpub)
  const watch = await importWatchWallet({ name: "check watch", xpub: "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs" })
  // descriptors / key origins fill the fingerprint and path (an account xpub alone can't carry them)
  const zpub = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs"
  assert.deepEqual(parseAccountKey(`wpkh([73C5DA0A/84h/0h/0h]${zpub}/0/*)#abcdefgh`), { xpub, family: "main", fingerprint: "73c5da0a", path: "m/84'/0'/0'" })
  assert.deepEqual(parseAccountKey(`[73c5da0a/84'/0'/0']${zpub}`), { xpub, family: "main", fingerprint: "73c5da0a", path: "m/84'/0'/0'" })
  assert.deepEqual(parseAccountKey(` ${zpub} `), { xpub, family: "main" })
  assert.throws(() => parseAccountKey(`sh(wpkh([73c5da0a/49h/0h/0h]${zpub}/0/*))`), /native SegWit/)
  const described = await importWatchWallet({ name: "check descriptor", xpub: `wpkh([73c5da0a/84h/0h/7h]${zpub}/0/*)` })
  assert.deepEqual(described.accounts.main, { xpub, path: "m/84'/0'/7'", fingerprint: 0x73c5da0a })
  await setFingerprint(watch.id, "0badf00d")
  assert.equal((await listWallets()).find((w) => w.id === watch.id)?.accounts.main?.fingerprint, 0x0badf00d)
  await throws(() => setFingerprint(watch.id, "nope"), /8 hex/)
  await deleteWallet(described.id)
  assert.ok(watch.watchOnly && watch.accounts.main?.xpub === xpub && !watch.accounts.test)
  await throws(() => signingAccount(watch.id, "main"), /watch-only/)
  const watchTest = await importWatchWallet({ name: "check watch test", xpub: displayXpub(testXpub, "test") })
  assert.deepEqual(watchTest.accounts, { test: { xpub: testXpub, path: "m/84'/1'/0'", fingerprint: 0 } })
  await deleteWallet(watchTest.id)
  await throws(() => deleteWallet("env"), /\.env/)
  await deleteWallet(soft.id)
  await deleteWallet(open.id)
  await deleteWallet(watch.id)

  // --- settings: hidden networks are known chains, deduplicated ----------------------------------
  assert.deepEqual(parseSettings({ hidden: ["xbt", "signet", "xbt"] }), { hidden: ["xbt", "signet"] })
  assert.throws(() => parseSettings({ hidden: ["doge"] }), /Invalid setting/)
  assert.throws(() => parseSettings({ hidden: "xbt" }), /Invalid setting/)

  // --- labels: one chain each, address refs checked against that chain's network ---------------
  assert.ok(validRef("addr", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "btc"))
  assert.ok(validRef("addr", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "xbt"))
  assert.ok(validRef("addr", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "tbtc4"))
  assert.ok(!validRef("addr", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "btc"), "testnet address on mainnet")
  assert.ok(!validRef("addr", " bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "btc"), "untrimmed ref")
  assert.ok(validRef("output", `${"ab".repeat(32)}:1`, "btc") && !validRef("utxo", "x", "btc"))

  // --- no ALLOWED_PUBKEYS: open, but only to localhost and this app's own pages -------------------
  const url = "http://localhost:3000/api/stream"
  process.env.ALLOWED_PUBKEYS = ""
  const local = (headers: Record<string, string>) => requireNostr(new Request(url, { method: "POST", headers }))
  assert.equal(await local({ host: "localhost:3000" }), null)
  assert.equal(await local({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }), null)
  assert.equal((await local({ host: "evil.example:3000" }))?.status, 403, "DNS rebinding refused")
  assert.equal((await local({ host: "192.168.1.4:3000" }))?.status, 403, "LAN host refused")
  assert.equal((await local({ host: "localhost:3000", origin: "http://evil.example" }))?.status, 403, "other site refused")
  assert.equal((await local({ host: "localhost:3000", origin: "http://localhost:5173" }))?.status, 403, "other local app refused")
  assert.equal((await local({ host: "localhost:3000", origin: "null" }))?.status, 403, "opaque origin refused")

  // --- NIP-98: allowlist + payload binding ------------------------------------------------------
  const allowed = generateSecretKey()
  process.env.ALLOWED_PUBKEYS = getPublicKey(allowed)
  const tokenFor = (sk: Uint8Array, u = url, method = "GET", body?: object) => nip98.getToken(u, method, (e) => finalizeEvent(e, sk), true, body)
  const req = (auth?: string, method = "GET") => new Request(url, { method, headers: auth ? { authorization: auth } : {} })
  assert.equal(await requireNostr(req(await tokenFor(allowed))), null)
  assert.equal((await requireNostr(req(await tokenFor(generateSecretKey()))))?.status, 403)
  assert.equal((await requireNostr(req()))?.status, 401)
  assert.equal((await requireNostr(req(await tokenFor(allowed, "http://evil.example/api/stream"))))?.status, 401)
  const body = { chain: "btc", hex: "00" }
  const posted = await tokenFor(allowed, url, "POST", body)
  assert.equal((await requireNostr(req(posted, "POST"), { ...body, hex: "01" }))?.status, 401, "tampered body rejected")
  assert.equal(await requireNostr(req(posted, "POST"), body), null)
  assert.equal((await requireNostr(req(posted, "POST"), body))?.status, 401, "replayed write rejected")
  assert.equal((await requireNostr(req(await tokenFor(allowed, url, "POST"), "POST"), body))?.status, 401, "POST without payload tag rejected")

  console.log("all checks passed")
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
