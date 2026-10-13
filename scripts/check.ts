// Run: pnpm check  (react-server condition lets us import the server-only modules; uses its own data/check.db)
import assert from "node:assert/strict"
import fs from "node:fs"
import { HDKey } from "@scure/bip32"
import { mnemonicToSeedSync } from "@scure/bip39"
import { RawTx, SigHash, Transaction, p2pkh, p2wpkh } from "@scure/btc-signer"
import { secp256k1 } from "@noble/curves/secp256k1.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { finalizeEvent, generateSecretKey, getPublicKey, nip98 } from "nostr-tools"
import { REPLAY_LOCKTIME, familyPath, minDataScript, replayPairs, syncedChains } from "../lib/chains"
import { amountInput, deriveAddresses, displayXpub, formatAmount, normalizeXpub, parseAccountKey, parseAmount, parseCoins, scriptHash, txEvents, type Snapshot, type Tx } from "../lib/wallet"
import { db } from "../lib/server/db"
import { WrongPasswordError, isLocked, seal, unseal } from "../lib/server/secret"
import { createSeedWallet, deleteWallet, importWatchWallet, listWallets, setFingerprint, signingAccount, unlockAccounts } from "../lib/server/wallets"
import {
  addressFor,
  buildPsbt,
  cpfpFee,
  depositDataScript,
  depositOf,
  drivechainScript,
  estimateVsize,
  feeAt,
  importSigned,
  opReturnScript,
  outputRuleError,
  parseDepositAddress,
  parseTxHex,
  planTx,
  rbfFee,
  scriptFor,
  sentBy,
  vsizeOf,
  type Coin,
} from "../lib/tx"
import { SIGHASH_ALL_UNIFIED, unifiedSighash, type ScriptType } from "../lib/unified-sighash"
import { requireNostr } from "../lib/server/auth"
import { validRef } from "../lib/server/labels"
import { parseSettings } from "../lib/server/settings"
import { headerTime } from "../lib/server/watcher"
import { signWith, type SignContext } from "../lib/server/sign-core"
import { validateBroadcast } from "../lib/server/broadcast"

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
  // eCash guard: spend a coin eCash lacks, adding the smallest when the best plan has none
  const guard = (lacking: Coin[]) => ({ coins: lacking, pair: "pecx" as const })
  p = planTx({ chain: "btc", recipients: [{ address: dest, amount: 10_000 }], candidates: coins, fee: feeAt(2), changeAddress: change0, guard: guard([coins[1]]) })
  assert.deepEqual(p.inputs.map((c) => c.value), [20_000], "already guarded: unchanged")
  p = planTx({ chain: "btc", recipients: [{ address: dest, amount: 10_000 }], candidates: coins, fee: feeAt(2), changeAddress: change0, guard: guard([coins[2], coins[0]]) })
  assert.ok(p.inputs.some((c) => c.value === 5_000), "smallest lacking coin added")
  p = planTx({ chain: "btc", recipients: [{ address: dest, amount: 0 }], sendMax: true, candidates: coins, fee: feeAt(1), changeAddress: change0, guard: guard([coins[2]]) })
  assert.equal(p.inputs.length, 3, "send max still sweeps everything")
  p = planTx({ chain: "btc", recipients: [{ address: dest, amount: 0 }], sendMax: true, required: [coins[0]], fee: feeAt(1), changeAddress: change0, guard: guard([coins[2]]) })
  assert.deepEqual(p.inputs.map((c) => c.value), [50_000, 5_000], "manual max gets the guard coin")
  await throws(() => planTx({ chain: "btc", recipients: [{ address: dest, amount: 10_000 }], candidates: coins, fee: feeAt(1), changeAddress: change0, guard: guard([]) }), /split them there first/)
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
  const psbtFor = (chain: "btc" | "xbt" | "pecx", data?: Uint8Array) => {
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

  // eCash: plain SIGHASH_ALL, replay-protected by nLockTime 499,999,999 (final there, never final on Bitcoin)
  const pecx = await signWith("pecx", psbtFor("pecx"), ctx())
  signed = Transaction.fromRaw(hexToBytes(pecx.hex), { allowUnknownOutputs: true })
  assert.equal(signed.lockTime, REPLAY_LOCKTIME)
  assert.equal(signed.getInput(0).sequence, 0xfffffffd, "a non-final input makes the locktime bind")
  assert.equal(signed.getInput(0).finalScriptWitness![0].at(-1), SigHash.ALL)
  validateBroadcast("pecx", pecx.hex)
  await throws(() => validateBroadcast("btc", pecx.hex), /eCash's replay protection/)
  await throws(() => validateBroadcast("pecx", btc.hex), /must use nLockTime 499999999/)
  await throws(() => signWith("pecx", psbtFor("btc"), ctx()), /must use nLockTime 499999999/) // a client that skipped the protection
  assert.deepEqual(replayPairs("btc"), ["xbt", "pecx"], "Bitcoin replays onto Blake and eCash Beta; eCash mainnet isn't live yet")
  assert.deepEqual(syncedChains("pecx"), ["pecx", "btc"])
  assert.equal(minDataScript("btc"), 84)
  assert.equal(minDataScript("pecx"), 0, "eCash has no OP_RETURN cap to pin a tx with")

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

  // --- BIP300 deposit (M5) on eCash Beta -------------------------------------------------------
  // a real betanet deposit to Thunder (slot 9): treasury in (empty scriptSig) → new treasury, address OP_RETURN, change
  const betanet = parseTxHex(
    "0100000000010253be73b8636651106b245168ec4ab28fa4e63f6d4c33ad16e6f7bf5b2f10d1dd0000000000fdffffff81fa3e519b8489b35fcf40cf34de3eb28c1fbbf1a65c93b47b8320d380c11c610200000000fdffffff03d54f5a901700000004b701095100000000000000001d6a1b58446b65756d7a427051366d61476561646d6e686f344a45345546f70fc6c30600000016001480fa39033e7ccc82032ff7f1464e0959bb6e2dda000247304402205fd24b64110e37ab64b28062201f7acda5f4b43ca25c5a0d92f3e22ba666f87402207786f8637007f66079dddeed8920004fb3a7b112219631cbd76f5f431d77baf2012102f27a079ec12359c0c148ae2b5dcdb2023bb94dc14badb3924eadf9ed5554c6c4ff64cd1d",
  )
  const real = depositOf("pecx", betanet)!
  assert.deepEqual([real.slot, real.vout, real.value, new TextDecoder().decode(real.address)], [9, 0, 101_206_085_589n, "XDkeumzBpQ6maGeadmnho4JE4UF"])
  assert.equal(vsizeOf(betanet), 202, "weight 806: the treasury input adds 41 bytes and an empty witness")
  assert.equal(estimateVsize(1, [drivechainScript("pecx", 9), depositDataScript("XDkeumzBpQ6maGeadmnho4JE4UF"), p2wpkh(pub0).script], 1), 202)
  assert.equal(depositOf("btc", betanet), null, "OP_DRIVECHAIN only means something where drivechains run")
  assert.deepEqual(drivechainScript("pecx", 9), Uint8Array.of(0xb7, 0x01, 0x09, 0x51), "betanet's OP_DRIVECHAIN is OP_NOP8")
  // deposit address: s<slot>_<address>_<sha256(prefix)[..3]> (thunder-rust Address::format_for_deposit)
  const thunderAddress = "s9_XDkeumzBpQ6maGeadmnho4JE4UF_7ab137"
  assert.deepEqual(parseDepositAddress(` ${thunderAddress} `), { slot: 9, address: "XDkeumzBpQ6maGeadmnho4JE4UF" })
  await throws(() => parseDepositAddress("s9_XDkeumzBpQ6maGeadmnho4JE4UG_7ab137"), /checksum/)
  await throws(() => parseDepositAddress("XDkeumzBpQ6maGeadmnho4JE4UF"), /sidechain deposit address/)
  await throws(() => parseDepositAddress("s256_x_000000"), /sidechain deposit address/)

  const treasuryTx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true })
  treasuryTx.addInput({ txid: "22".repeat(32), index: 0 })
  treasuryTx.addOutput({ script: drivechainScript("pecx", 9), amount: 5_000_000n })
  const ctip = { txid: treasuryTx.id, vout: 0, value: 5_000_000 }
  const depositPlan = (c: typeof ctip | null, address = thunderAddress) =>
    planTx({ chain: "pecx", recipients: [{ address, amount: 30_000 }], candidates: [fundCoin], fee: feeAt(2), changeAddress: change0, deposit: { ctip: c } })
  const dp = depositPlan(ctip)
  assert.deepEqual(dp.outputs.map((o) => [o.kind, o.amount]), [["recipient", 5_030_000], ["data", 0], ["change", 100_000 - 30_000 - dp.fee]], "M5 order")
  assert.equal(sentBy(dp), 30_000, "the carried-over treasury isn't sent")
  const depositPsbt = (plan: typeof dp) =>
    buildPsbt(plan, { chain: "pecx", xpub, fingerprint: master.fingerprint, accountPath: "m/84'/0'/0'", tipHeight: 970_000, parents: { [ctip.txid]: treasuryTx.hex } }).toPSBT()
  const psbt = Transaction.fromPSBT(depositPsbt(dp), { allowUnknownOutputs: true })
  assert.equal(bytesToHex(psbt.getInput(0).txid!), ctip.txid, "treasury spent first")
  assert.ok(!psbt.getInput(0).bip32Derivation && !psbt.getInput(0).witnessUtxo, "nobody signs the treasury")
  const sidechainAt = (c: typeof ctip | null) => async (slot: number) => (slot === 9 ? { ctip: c } : null)
  const depositCtx = (c: typeof ctip | null = ctip, overrides: Partial<SignContext> = {}) =>
    ctx({ prevOut: async (txid, vout) => (txid === ctip.txid ? treasuryTx : funding).getOutput(vout), sidechain: sidechainAt(c), ...overrides })
  const dep = await signWith("pecx", depositPsbt(dp), depositCtx())
  const depTx = parseTxHex(dep.hex)
  assert.equal(depTx.lockTime, REPLAY_LOCKTIME, "deposits keep eCash's replay protection")
  assert.ok(!depTx.getInput(0).finalScriptSig?.length && !depTx.getInput(0).finalScriptWitness?.length, "treasury: empty scriptSig and witness")
  assert.equal(depTx.getInput(1).finalScriptWitness!.length, 2)
  assert.deepEqual({ ...depositOf("pecx", depTx)!, address: new TextDecoder().decode(depositOf("pecx", depTx)!.address) }, { slot: 9, vout: 0, value: 5_030_000n, address: "XDkeumzBpQ6maGeadmnho4JE4UF" })
  assert.equal(dep.fee, dp.fee)
  assert.ok(dep.vsize <= dp.vsize && dp.vsize - dep.vsize <= 1, "vsize estimate counts the treasury input")
  validateBroadcast("pecx", dep.hex)
  assert.equal(importSigned("pecx", depositPsbt(dp), dep.hex).txid, dep.txid, "external signer round trip skips the treasury")
  // first deposit to a slot: no treasury to spend
  const first = depositPlan(null)
  assert.ok(first.outputs[0].amount === 30_000 && !first.deposit!.ctip)
  assert.equal(parseTxHex((await signWith("pecx", depositPsbt(first), depositCtx(null))).hex).inputsLength, 1)
  // refusals: an inactive slot (anyone-can-spend output), a stale or fake treasury, a broken M5 layout
  await throws(() => signWith("pecx", depositPsbt(depositPlan(null, "s7_x_" + bytesToHex(sha256(utf8ToBytes("s7_x_")).slice(0, 3)))), depositCtx()), /slot 7 isn't active/)
  await throws(() => signWith("pecx", depositPsbt(first), depositCtx()), /current treasury/)
  await throws(() => signWith("pecx", depositPsbt(dp), depositCtx({ ...ctip, txid: "33".repeat(32) })), /not from this wallet/)
  await throws(() => signWith("pecx", depositPsbt(dp), depositCtx({ ...ctip, value: 4_000_000 })), /treasury doesn't match/)
  const swapped = Transaction.fromPSBT(depositPsbt(dp), { allowUnknownOutputs: true })
  const [o0, o1] = [swapped.getOutput(0), swapped.getOutput(1)]
  swapped.updateOutput(0, { script: o1.script, amount: o1.amount })
  swapped.updateOutput(1, { script: o0.script, amount: o0.amount })
  await throws(() => signWith("pecx", swapped.toPSBT(), depositCtx()), /followed by an OP_RETURN/)
  await throws(() => signWith("pecx", depositPsbt(dp), depositCtx(ctip, { sidechain: undefined })), /need a BIP300 enforcer/)

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
  assert.deepEqual(parseSettings({ chain: "pecx" }), { chain: "pecx" })
  assert.throws(() => parseSettings({ chain: "ecx" }), /Invalid setting/, "eCash mainnet can't be selected before it launches")

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
