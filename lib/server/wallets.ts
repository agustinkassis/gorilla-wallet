import "server-only"
import { randomUUID } from "node:crypto"
import { HDKey } from "@scure/bip32"
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { FAMILIES, familyPath, type Family } from "@/lib/chains"
import { config } from "@/lib/server/config"
import { accountDescriptors } from "@/lib/descriptors"
import { db } from "@/lib/server/db"
import { isLocked, seal, unseal } from "@/lib/server/secret"
import { DERIVATION_PATH, parseAccountKey, type Account, type WalletInfo, type WalletKind } from "@/lib/wallet"

export const ENV_WALLET_ID = "env"

export class WalletError extends Error {}
export class WatchOnlyError extends WalletError {
  constructor() {
    super("This is a watch-only wallet: it has no keys to sign with")
  }
}

const normalizeMnemonic = (m: string) => m.trim().toLowerCase().split(/\s+/).join(" ")
const FAMILY_IDS = Object.keys(FAMILIES) as Family[]
const DEFAULT_PATH: Record<Family, string> = { main: "m/84'/0'/0'", test: "m/84'/1'/0'", regtest: "m/84'/1'/0'" }

const masterKey = (mnemonic: string, passphrase: string) => HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic, passphrase))
const accountAt = (master: HDKey, path: string): Account => ({ xpub: master.derive(path).publicExtendedKey, path, fingerprint: master.fingerprint })
/** Accounts for `families`, from one account path on `pathFamily` (the coin type follows each family). */
const accountsFor = (master: HDKey, path: string, pathFamily: Family, families = FAMILY_IDS) =>
  families.map((family) => ({ family, ...accountAt(master, family === pathFamily ? path : familyPath(path, family)) }))

// The .env seed (optional). Derived once; never written to the database.
let envCache: { master: HDKey; accounts: (Account & { family: Family })[] } | null | undefined
function envSeed() {
  if (envCache !== undefined) return envCache
  const mnemonic = config.seedPhrase && normalizeMnemonic(config.seedPhrase)
  const master = mnemonic && validateMnemonic(mnemonic, wordlist) ? masterKey(mnemonic, "") : null
  envCache = master ? { master, accounts: accountsFor(master, config.derivationPath, "main") } : null
  return envCache
}

const listeners = new Set<() => void>()
/** Notified when wallets are added, renamed or removed (the stream re-sends the list, sync restarts). */
export const onWalletsChange = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))
const changed = () => listeners.forEach((l) => l())

type Row = { id: string; name: string; kind: string; encSeed: string | null; passphrase: boolean }
type Accounts = Partial<Record<Family, Account>>
const info = (w: Row, accounts: Accounts): WalletInfo => ({
  id: w.id,
  name: w.name,
  kind: w.kind as WalletKind,
  accounts,
  watchOnly: w.kind === "watch",
  needsPassword: w.kind === "seed" && isLocked(w.encSeed!),
  passphrase: w.passphrase,
})

async function loadAccounts() {
  const byWallet = new Map<string, Accounts>()
  for (const { walletId, family, xpub, path, fingerprint } of await db.walletAccount.findMany()) {
    if (!byWallet.has(walletId)) byWallet.set(walletId, {})
    byWallet.get(walletId)![family as Family] = { xpub, path, fingerprint }
  }
  return byWallet
}

/** Keep the env wallet in step with .env; if its seed changed, drop the old seed's cached data. */
async function syncEnvWallet() {
  const env = envSeed()
  if (!env) return
  const have = await db.walletAccount.findMany({ where: { walletId: ENV_WALLET_ID } })
  const want = (f: string) => env.accounts.find((a) => a.family === f)
  if (have.length === env.accounts.length && have.every((a) => a.xpub === want(a.family)?.xpub && a.path === want(a.family)?.path)) return
  if (have.some((a) => a.xpub !== want(a.family)?.xpub)) await wipeCache(ENV_WALLET_ID)
  await db.$transaction([
    db.wallet.upsert({ where: { id: ENV_WALLET_ID }, create: { id: ENV_WALLET_ID, name: "Default wallet", kind: "env" }, update: {} }),
    db.walletAccount.deleteMany({ where: { walletId: ENV_WALLET_ID } }),
    db.walletAccount.createMany({ data: env.accounts.map((a) => ({ walletId: ENV_WALLET_ID, ...a })) }),
  ])
}

const wipeCache = (walletId: string) =>
  db.$transaction([
    db.address.deleteMany({ where: { walletId } }),
    db.addressState.deleteMany({ where: { walletId } }),
    db.utxo.deleteMany({ where: { walletId } }),
    db.tx.deleteMany({ where: { walletId } }),
    db.receiveCursor.deleteMany({ where: { walletId } }),
  ])

/** A software wallet's missing family accounts, derived from its seed (unsealed with `password` for this call only). */
async function addMissingAccounts(w: Row, accounts: Accounts, password: string) {
  const [refFamily, ref] = (Object.entries(accounts)[0] ?? ["main", { path: DEFAULT_PATH.main }]) as [Family, Pick<Account, "path">]
  const missing = FAMILY_IDS.filter((f) => !accounts[f])
  if (!missing.length) return
  const { mnemonic, passphrase } = JSON.parse(await unseal(w.encSeed!, password)) as { mnemonic: string; passphrase: string }
  const data = accountsFor(masterKey(mnemonic, passphrase), ref.path, refFamily, missing).map((a) => ({ walletId: w.id, ...a }))
  await db.walletAccount.createMany({ data })
}

/**
 * All usable wallets (the env wallet only while .env has a valid seed), oldest first. Passwordless software wallets
 * get their missing family accounts on the way (wallets created before testnets existed).
 */
export async function listWallets(): Promise<WalletInfo[]> {
  await syncEnvWallet()
  const [rows, accounts] = await Promise.all([db.wallet.findMany({ orderBy: { createdAt: "asc" } }), loadAccounts()])
  const open = rows.filter((w) => w.kind === "seed" && !isLocked(w.encSeed!) && FAMILY_IDS.some((f) => !accounts.get(w.id)?.[f]))
  if (open.length) {
    for (const w of open) await addMissingAccounts(w, accounts.get(w.id) ?? {}, "")
    return listWallets()
  }
  return rows.filter((r) => r.kind !== "env" || envSeed()).map((r) => info(r, accounts.get(r.id) ?? {}))
}

export async function getWallet(id: unknown): Promise<WalletInfo> {
  const w = typeof id === "string" ? (await listWallets()).find((x) => x.id === id) : undefined
  if (!w) throw new WalletError("Unknown wallet")
  return w
}

function checkName(name: unknown) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 40) throw new WalletError("Give the wallet a name (up to 40 characters)")
  return name.trim()
}
function checkPath(path: unknown, family: Family) {
  const p = typeof path === "string" && path.trim() ? path.trim() : DEFAULT_PATH[family]
  if (!DERIVATION_PATH.test(p)) throw new WalletError("Invalid derivation path")
  return p
}
function checkFamily(f: unknown): Family {
  if (f === undefined) return "main"
  if (!FAMILY_IDS.includes(f as Family)) throw new WalletError("Unknown network family")
  return f as Family
}

/**
 * New software wallet from recovery words (generated in the app or imported), with an account on every family.
 * `path` is the account on `family` (the network selected while adding it); the others follow its coin type.
 * The seed is sealed with `password`, if any.
 */
export async function createSeedWallet(o: { name: unknown; mnemonic: unknown; passphrase?: unknown; path?: unknown; password?: unknown; family?: unknown }) {
  const name = checkName(o.name)
  const mnemonic = typeof o.mnemonic === "string" ? normalizeMnemonic(o.mnemonic) : ""
  if (!validateMnemonic(mnemonic, wordlist)) throw new WalletError("Invalid recovery words (BIP39 English, 12–24 words)")
  const passphrase = typeof o.passphrase === "string" ? o.passphrase : ""
  const family = checkFamily(o.family)
  const path = checkPath(o.path, family)
  const password = o.password ?? ""
  if (typeof password !== "string" || (password && password.length < 8)) throw new WalletError("Wallet password must be at least 8 characters, or none")
  const id = randomUUID()
  const accounts = accountsFor(masterKey(mnemonic, passphrase), path, family)
  await db.$transaction([
    db.wallet.create({
      data: { id, name, kind: "seed", passphrase: !!passphrase, encSeed: await seal(JSON.stringify({ mnemonic, passphrase }), password) },
    }),
    db.walletAccount.createMany({ data: accounts.map((a) => ({ walletId: id, ...a })) }),
  ])
  changed()
  return getWallet(id)
}

/** Enable a password-protected software wallet on the families it lacks (wallets created before testnets existed). */
export async function unlockAccounts(id: unknown, password: unknown) {
  const w = await getWallet(id)
  if (w.kind !== "seed") throw new WalletError("Only software wallets derive more accounts: import a tpub/vpub as a watch-only wallet instead")
  if (typeof password !== "string") throw new WalletError("Enter the wallet password")
  await addMissingAccounts((await db.wallet.findUniqueOrThrow({ where: { id: w.id } })) as Row, w.accounts, password)
  changed()
  return getWallet(w.id)
}

/** Watch-only wallet from an account xpub/zpub (mainnet) or tpub/vpub (testnets). Fingerprint optional (external signers). */
export async function importWatchWallet(o: { name: unknown; xpub: unknown; path?: unknown; fingerprint?: unknown; family?: unknown }) {
  const name = checkName(o.name)
  let key: ReturnType<typeof parseAccountKey>
  try {
    key = parseAccountKey(String(o.xpub ?? ""))
  } catch (e) {
    throw new WalletError((e as Error).message)
  }
  const family = o.family === undefined ? key.family : checkFamily(o.family)
  if (family !== key.family && !(family === "regtest" && key.family === "test")) throw new WalletError("Extended public key does not match the network family")
  // typed fields win over the key's origin; without either the wallet still works, the fingerprint can be added later
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
  const fp = checkFingerprint(text(o.fingerprint) ?? key.fingerprint)
  const id = randomUUID()
  await db.$transaction([
    db.wallet.create({ data: { id, name, kind: "watch" } }),
    db.walletAccount.create({
      data: { walletId: id, family, xpub: key.xpub, path: checkPath(text(o.path) ?? key.path, family), fingerprint: fp },
    }),
  ])
  changed()
  return getWallet(id)
}

function checkFingerprint(fp: string | undefined) {
  if (fp === undefined) return 0
  if (!/^[0-9a-fA-F]{8}$/.test(fp)) throw new WalletError("Master fingerprint is 8 hex characters")
  return parseInt(fp, 16)
}

/** Watch-only wallets: set the master fingerprint afterwards (PSBTs need it for hardware wallets to sign). */
export async function setFingerprint(id: unknown, fingerprint: unknown) {
  const w = await getWallet(id)
  if (w.kind !== "watch") throw new WalletError("Only watch-only wallets take a fingerprint: the others know theirs")
  const fp = checkFingerprint(typeof fingerprint === "string" ? fingerprint.trim() : "")
  await db.walletAccount.updateMany({ where: { walletId: w.id }, data: { fingerprint: fp } })
  changed()
}

export async function renameWallet(id: unknown, name: unknown) {
  const w = await getWallet(id)
  await db.wallet.update({ where: { id: w.id }, data: { name: checkName(name) } })
  changed()
}

/** Remove a wallet and everything cached for it. The env wallet is managed by .env. */
export async function deleteWallet(id: unknown) {
  const w = await getWallet(id)
  if (w.kind === "env") throw new WalletError("The default wallet comes from .env: remove SEED_PHRASE there instead")
  await wipeCache(w.id)
  await db.$transaction([
    db.label.deleteMany({ where: { walletId: w.id } }),
    db.walletAccount.deleteMany({ where: { walletId: w.id } }),
    db.wallet.delete({ where: { id: w.id } }),
  ])
  changed()
}

/**
 * Keys for signing on `family`. env: from .env; seed: decrypted with the wallet password (if it has one), in memory
 * for this call only; watch: refused.
 */
export async function signingAccount(id: unknown, family: Family, password?: unknown) {
  const w = await getWallet(id)
  if (w.kind === "watch") throw new WatchOnlyError()
  const account = w.accounts[family]
  if (!account) throw new WalletError(`This wallet isn't enabled on ${FAMILIES[family].label} yet`)
  let acct: HDKey
  if (w.kind === "env") acct = envSeed()!.master.derive(account.path)
  else {
    const pw = typeof password === "string" ? password : ""
    if (w.needsPassword && !pw) throw new WalletError("Enter the wallet password to sign")
    const row = await db.wallet.findUniqueOrThrow({ where: { id: w.id } })
    const { mnemonic, passphrase } = JSON.parse(await unseal(row.encSeed!, pw)) as { mnemonic: string; passphrase: string }
    acct = masterKey(mnemonic, passphrase).derive(account.path)
  }
  return {
    fingerprint: account.fingerprint,
    accountPath: account.path,
    keyFor: (change: number, index: number) => {
      const k = acct.deriveChild(change).deriveChild(index)
      return { privateKey: k.privateKey!, publicKey: k.publicKey! }
    },
  }
}

/** Recovery material is only returned by an explicit export call, never by wallet metadata. */
export async function exportSeed(id: unknown, password?: unknown, includePassphrase = false): Promise<{ mnemonic: string; passphrase?: string }> {
  const wallet = await getWallet(id)
  if (wallet.kind === "watch") throw new WalletError("Watch-only wallets have no recovery words to export")
  let secret: { mnemonic: string; passphrase: string }
  if (wallet.kind === "env") {
    if (!config.seedPhrase) throw new WalletError("No environment seed configured")
    secret = { mnemonic: normalizeMnemonic(config.seedPhrase), passphrase: "" }
  } else {
    const pw = typeof password === "string" ? password : ""
    if (wallet.needsPassword && !pw) throw new WalletError("Enter the wallet password to export recovery words")
    const row = await db.wallet.findUniqueOrThrow({ where: { id: wallet.id } })
    if (!row.encSeed) throw new WalletError("Wallet has no recovery words")
    secret = JSON.parse(await unseal(row.encSeed, pw))
  }
  return { mnemonic: secret.mnemonic, ...(includePassphrase ? { passphrase: secret.passphrase } : {}) }
}

export async function exportDescriptors(id: unknown, family: Family) {
  const wallet = await getWallet(id)
  const account = wallet.accounts[family]
  if (!account) throw new WalletError(`This wallet isn't enabled on ${FAMILIES[family].label} yet`)
  return accountDescriptors(account, family)
}
