import { generateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { CliError, parseArgs, positiveInteger, selectWallet, type Args } from "@/lib/cli/args"
import { secret, confirm } from "@/lib/cli/input"
import { config } from "@/lib/server/config"
import { db } from "@/lib/server/db"
import { getSettings, parseSettings, saveSettings } from "@/lib/server/settings"
import { changeWalletPassword, createSeedWallet, exportSeed, exportDescriptors, listWallets, unlockAccounts } from "@/lib/server/wallets"
import { receiveAddress } from "@/lib/server/receive"
import { setLabel } from "@/lib/server/labels"
import { openSyncSession } from "@/lib/server/watcher"
import { signPsbt } from "@/lib/server/signer"
import { broadcastHex, validateBroadcast } from "@/lib/server/broadcast"
import { deriveAddress, type WalletInfo, type Snapshot } from "@/lib/wallet"
import { CHAINS, familyOf, syncedChains, type Chain } from "@/lib/chains"
import { INPUT_VSIZE, buildPsbt, feeAt, planTx, type Coin } from "@/lib/tx"
import { forwardCommand } from "@/lib/cli/forward"

export const HELP = `gorila - Bitcoin (BTC), Blake2b (XBT) and local regtest, amounts in satoshis

wallet list
wallet create --name NAME [--words 12|24] [--password-file FILE] [--passphrase-file FILE]
wallet import --name NAME [--seed-file FILE] [--password-file FILE] [--passphrase-file FILE]
wallet password [--password-file FILE] [--new-password-file FILE]
wallet export-seed [--include-passphrase] [--password-file FILE]
wallet descriptor [--chain btc|xbt|regtest]
receive [--chain btc|xbt|regtest] [--next] [--label TEXT]
addresses [--chain btc|xbt|regtest]
address label ADDRESS TEXT [--chain btc|xbt|regtest]
balance [--chain btc|xbt|regtest|all] [--all-wallets]
transactions --chain btc|xbt|regtest
tx-status TXID --chain btc|xbt|regtest
config show
config set --chain btc|xbt|regtest [--electrum URL ...] [--mempool URL ...]
send --chain btc|xbt|regtest --to ADDRESS --amount-sats N [--message TEXT] [--fee-rate N] [--yes]
forward add --chain btc|regtest (--from ADDRESS | --from-wallet) --to ADDRESS --every MINUTES --max-fee-rate N [--amount-sats N] [--balance-above-sats N] [--min-conf N] [--message TEXT] [--password-file FILE] [--yes]
forward list
forward show ID [--runs N]
forward remove ID
forward run ID [--dry-run]

Common: --wallet ID_OR_NAME, --json, --timeout SECONDS (default 120), --help
Network commands accept --password-file FILE to enable a missing encrypted wallet account.
Secrets use hidden terminal prompts or explicit files. --passphrase prompts for a BIP39 passphrase.
forward add installs a crontab entry that sends --amount-sats exactly (fee extra), or sweeps the source.
--balance-above-sats requires eligible wallet balance strictly above N, not a reserve.
Each send carries an OP_RETURN (--message, or 90 random bytes); fee caps apply to estimate and effective fee.
`

const commandOptions: Record<string, readonly string[]> = {
  "wallet list": [],
  "wallet create": ["name", "words", "password-file", "passphrase-file", "passphrase"],
  "wallet import": ["name", "seed-file", "password-file", "passphrase-file", "passphrase"],
  "wallet password": ["password-file", "new-password-file"],
  "wallet export-seed": ["password-file", "include-passphrase"],
  "wallet descriptor": ["chain", "password-file"],
  receive: ["label", "next", "chain", "password-file"], addresses: ["chain", "password-file"], "address label": ["chain", "password-file"],
  balance: ["chain", "all-wallets", "password-file"], transactions: ["chain", "password-file"], "tx-status": ["chain", "password-file"],
  "config show": [], "config set": ["chain", "electrum", "mempool"],
  send: ["chain", "to", "amount-sats", "message", "fee-rate", "yes", "password-file"],
  "forward add": ["chain", "from", "from-wallet", "to", "amount-sats", "balance-above-sats", "every", "min-conf", "max-fee-rate", "message", "password-file", "yes"],
  "forward list": [], "forward show": ["runs"], "forward remove": [], "forward run": ["dry-run"],
}
function required(args: Args, name: string) {
  const value = args.value(name)
  if (value === undefined || value === "") throw new CliError(`--${name} is required`)
  return value
}
function chainArg(args: Args, fallback?: "btc"): "btc" | "xbt" | "regtest" {
  const chain = args.value("chain") ?? fallback
  if (chain !== "btc" && chain !== "xbt" && chain !== "regtest") throw new CliError("--chain must be btc, xbt or regtest")
  return chain
}
const walletResult = (w: WalletInfo) => ({ id: w.id, name: w.name, kind: w.kind, watchOnly: w.watchOnly, needsPassword: w.needsPassword, passphrase: w.passphrase })
const confirmations = (height: number, tip: number) => height > 0 ? Math.max(0, tip - height + 1) : 0

async function transactionStatus(txid: string, chain: Chain, snapshots: Snapshot[], timeoutMs: number) {
  const snapshot = snapshots.find((s) => s.chain === chain)
  const tx = snapshot?.txs.find((t) => t.txid === txid)
  if (tx && snapshot) return { chain, txid, found: true, confirmed: tx.height > 0, height: tx.height > 0 ? tx.height : null, confirmations: confirmations(tx.height, snapshot.height) }
  const sources = config.sources(chain, await getSettings()).mempool
  let missing = false
  const errors: string[] = []
  for (const base of sources) {
    try {
      const res = await fetch(`${base}/api/tx/${txid}/status`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)) })
      if (res.status === 404) { missing = true; continue }
      if (!res.ok) throw new CliError(`HTTP ${res.status}`)
      const status: unknown = await res.json()
      if (!status || typeof status !== "object" || !("confirmed" in status) || typeof status.confirmed !== "boolean") throw new CliError("Malformed transaction status")
      if (!status.confirmed) {
        const transactionResponse = await fetch(`${base}/api/tx/${txid}`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)) })
        if (transactionResponse.status === 404) { missing = true; continue }
        if (!transactionResponse.ok) throw new CliError(`Transaction HTTP ${transactionResponse.status}`)
        const transaction: unknown = await transactionResponse.json()
        if (!transaction || typeof transaction !== "object" || !("txid" in transaction) || transaction.txid !== txid) throw new CliError("Malformed transaction response")
        return { chain, txid, found: true, confirmed: false, height: null, confirmations: 0 }
      }
      if (!("block_height" in status) || typeof status.block_height !== "number" || !Number.isSafeInteger(status.block_height) || status.block_height <= 0) throw new CliError("Malformed block height")
      const tipResponse = await fetch(`${base}/api/blocks/tip/height`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)) })
      if (!tipResponse.ok) throw new CliError(`Tip HTTP ${tipResponse.status}`)
      const tip = Number(await tipResponse.text())
      if (!Number.isSafeInteger(tip) || tip < status.block_height) throw new CliError("Malformed chain tip")
      return { chain, txid, found: true, confirmed: true, height: status.block_height, confirmations: confirmations(status.block_height, tip) }
    } catch (error) { errors.push(`${base}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (missing) return { chain, txid, found: false }
  throw new CliError(`Transaction status servers inaccessible: ${errors.join("; ") || "no sources configured"}`)
}

export async function runCli(argv: readonly string[]) {
  const args = parseArgs(argv)
  if (args.flags.has("help") || !args.positionals.length) return { help: HELP }
  const first = args.positionals[0]
  const grouped = ["wallet", "config", "address", "forward"].includes(first)
  const command = grouped ? args.positionals.slice(0, 2).join(" ") : first
  const allowed = commandOptions[command]
  if (!allowed) throw new CliError(`Unknown command: ${command}. Use --help`)
  const common = ["wallet", "json", "timeout", "help"]
  for (const option of [...Object.keys(args.values), ...args.flags]) {
    if (!common.includes(option) && !allowed.includes(option)) throw new CliError(`--${option} is not valid for ${command}`)
  }
  const forwardWithId = ["forward show", "forward remove", "forward run"].includes(command)
  const positionalCount = command === "address label" ? 4 : forwardWithId ? 3 : command === "tx-status" ? 2 : grouped ? 2 : 1
  if (args.positionals.length !== positionalCount) throw new CliError(`Invalid arguments for ${command}. Use --help`)
  const timeoutMs = positiveInteger(args.value("timeout") ?? "120", "timeout") * 1000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 2_147_483_647) throw new CliError("timeout is too large")
  if (command.startsWith("forward ")) return forwardCommand(command, args, timeoutMs)
  if (command === "config show") {
    const settings = await getSettings()
    return { chains: (["btc", "xbt", "regtest"] as const).map((chain) => {
      const sources = config.sources(chain, settings)
      const origin = (kind: "electrum" | "mempool", env: string) => settings.sources[chain]?.[kind]?.length ? "Settings" : process.env[env]?.split(",").some((v) => v.trim()) ? ".env/environment" : "defaults"
      return { chain, electrum: { urls: sources.electrum, source: origin("electrum", `${chain.toUpperCase()}_ELECTRUM`) }, mempool: { urls: sources.mempool, source: origin("mempool", `MEMPOOL_${chain.toUpperCase()}_URL`) } }
    }) }
  }
  if (command === "config set") {
    const chain = chainArg(args)
    if (!args.values.electrum && !args.values.mempool) throw new CliError("Supply --electrum or --mempool")
    const settings = await getSettings()
    const patch = parseSettings({ sources: { ...settings.sources, [chain]: { ...settings.sources[chain], ...(args.values.electrum ? { electrum: args.values.electrum } : {}), ...(args.values.mempool ? { mempool: args.values.mempool } : {}) } } })
    await saveSettings(patch)
    return { chain, ...config.sources(chain, await getSettings()) }
  }
  if (command === "wallet create" || command === "wallet import") {
    const name = required(args, "name")
    const words = args.value("words") ?? "24"
    if (words !== "12" && words !== "24") throw new CliError("--words must be 12 or 24")
    const mnemonic = command === "wallet create" ? generateMnemonic(wordlist, words === "12" ? 128 : 256) : await secret(args.value("seed-file"), "BIP39 recovery words")
    if (![12, 24].includes(mnemonic.trim().split(/\s+/).length)) throw new CliError("Recovery words must have 12 or 24 words")
    const password = await secret(args.value("password-file"), "Wallet password (empty for none)", false)
    const passphrase = args.value("passphrase-file") || args.flags.has("passphrase") ? await secret(args.value("passphrase-file"), "BIP39 passphrase") : ""
    const wallet = await createSeedWallet({ name, mnemonic, password, passphrase })
    return { wallet: walletResult(wallet), ...(command === "wallet create" ? { mnemonic } : {}) }
  }
  const wallets = await listWallets()
  if (command === "wallet list") return { wallets: wallets.map(walletResult) }
  if (command === "balance" && args.flags.has("all-wallets") && args.value("wallet")) throw new CliError("Use --all-wallets or --wallet")
  const selected = command === "balance" && args.flags.has("all-wallets") ? wallets : command === "tx-status" && !wallets.length ? [] : [selectWallet(wallets, args.value("wallet"))]
  if (command === "wallet password") {
    const wallet = selected[0]
    if (wallet.kind !== "seed") throw new CliError("Only software wallets have a wallet password")
    const password = wallet.needsPassword || args.value("password-file") ? await secret(args.value("password-file"), "Current wallet password") : ""
    const newPassword = await secret(args.value("new-password-file"), "New wallet password")
    if (!args.value("new-password-file") && newPassword !== await secret(undefined, "Repeat new wallet password")) throw new CliError("Passwords don't match")
    await changeWalletPassword(wallet.id, password, newPassword)
    return { walletId: wallet.id, needsPassword: true }
  }
  let chains: Chain[] = ["btc", "xbt"]
  if (command === "balance") {
    const requested = args.value("chain") ?? "all"
    chains = requested === "all" ? ["btc", "xbt"] : [chainArg(args)]
  } else if (["transactions", "tx-status", "send"].includes(command)) chains = [chainArg(args)]
  else if (args.value("chain")) chains = syncedChains(chainArg(args))
  const family = familyOf(chains[0])
  const passwords = new Map<string, string>()
  if (command !== "wallet export-seed") {
    for (let i = 0; i < selected.length; i++) {
      const candidate = selected[i]
      if (candidate.accounts[family]) continue
      if (candidate.kind !== "seed") {
        if (command === "balance" && args.flags.has("all-wallets")) continue // e.g. a testnet-only watch wallet
        throw new CliError(`Wallet has no ${family} account`)
      }
      const password = await secret(args.value("password-file"), "Wallet password")
      passwords.set(candidate.id, password)
      selected[i] = await unlockAccounts(candidate.id, password)
    }
  }
  const wallet = selected[0]
  if (command === "wallet export-seed") {
    if (!wallet) throw new CliError("No wallet selected")
    const password = wallet.needsPassword || args.value("password-file") ? await secret(args.value("password-file"), "Wallet password") : ""
    return exportSeed(wallet.id, password, args.flags.has("include-passphrase"))
  }
  if (command === "wallet descriptor") {
    if (!wallet) throw new CliError("No wallet selected")
    const account = wallet.accounts[family]
    if (!account) throw new CliError("Wallet has no account on the selected network")
    return { walletId: wallet.id, family, fingerprint: account.fingerprint.toString(16).padStart(8, "0"), path: account.path, xpub: account.xpub, ...await exportDescriptors(wallet.id, family) }
  }
  if (command === "address label") {
    if (!wallet) throw new CliError("No wallet selected")
    const address = args.positionals[2]
    if (!await db.address.findFirst({ where: { walletId: wallet.id, address, family } })) throw new CliError("Address does not belong to this wallet; run addresses to discover it")
    await setLabel(wallet.id, chainArg(args, "btc"), "addr", address, args.positionals[3], null)
    return { walletId: wallet.id, address, label: args.positionals[3] }
  }
  if (command === "tx-status" && !/^[0-9a-f]{64}$/i.test(args.positionals[1])) throw new CliError("TXID must be 64 hex characters")
  if (command === "send") {
    if (!wallet || wallet.watchOnly) throw new CliError("Watch-only wallets cannot sign")
    required(args, "to")
    positiveInteger(required(args, "amount-sats"), "amount-sats")
    if (chains[0] === "xbt" && args.value("message") !== undefined) throw new CliError("XBT does not support --message")
    if (args.value("fee-rate") !== undefined && (!Number.isFinite(Number(args.value("fee-rate"))) || Number(args.value("fee-rate")) < 1 || Number(args.value("fee-rate")) > 1000)) throw new CliError("fee-rate must be between 1 and 1000 sat/vB")
    if (!args.flags.has("yes") && !process.stdin.isTTY) throw new CliError("Sending requires terminal confirmation or --yes")
  }
  const session = selected.length ? await openSyncSession(selected, chains, timeoutMs) : undefined
  try {
    const snapshots = session?.snapshots() ?? []
    if (command === "tx-status") return transactionStatus(args.positionals[1].toLowerCase(), chainArg(args), snapshots, timeoutMs)
    if (command === "balance") return { balances: snapshots.map((s) => {
      const confirmed = s.addresses.reduce((n, a) => n + a.confirmed, 0)
      const pending = s.addresses.reduce((n, a) => n + a.unconfirmed, 0)
      return { walletId: s.walletId, chain: s.chain, currency: CHAINS[s.chain].unit, confirmed, pending, total: confirmed + pending }
    }) }
    if (!wallet) throw new CliError("No wallet selected")
    if (command === "receive") return { walletId: wallet.id, ...await receiveAddress(wallet.id, chainArg(args, "btc"), { next: args.flags.has("next"), label: args.value("label") }) }
    if (command === "addresses") {
      const [addresses, states, labels] = await Promise.all([
        db.address.findMany({ where: { walletId: wallet.id, family }, orderBy: [{ change: "asc" }, { index: "asc" }] }),
        db.addressState.findMany({ where: { walletId: wallet.id, chain: { in: syncedChains(chains[0]) } } }),
        db.label.findMany({ where: { walletId: wallet.id, type: "addr", chain: chainArg(args, "btc") } }),
      ])
      return { walletId: wallet.id, addresses: addresses.map((a) => ({ address: a.address, index: a.index, change: a.change, label: labels.find((l) => l.ref === a.address)?.label ?? null, chains: syncedChains(chains[0]).map((chain) => {
        const state = states.find((s) => s.address === a.address && s.chain === chain)
        const history: [string, number][] = JSON.parse(state?.history ?? "[]")
        return { chain, used: state?.used ?? false, transactions: new Set(history.map(([txid]) => txid)).size }
      }) })) }
    }
    const snapshot = snapshots[0]
    if (!snapshot || !session) throw new CliError("No synchronized wallet")
    if (command === "transactions") return { walletId: wallet.id, chain: snapshot.chain, transactions: [...snapshot.txs].sort((a, b) => (b.time ?? Infinity) - (a.time ?? Infinity)).map((t) => ({ ...t, date: t.time ? new Date(t.time * 1000).toISOString() : null, confirmations: confirmations(t.height, snapshot.height) })) }
    if (command !== "send") throw new CliError("Unsupported command")
    const chain = chainArg(args)
    const client = session.client(chain)
    if (!args.value("fee-rate")) {
      try { await client.waitForFees(Math.min(timeoutMs, 20_000)) }
      catch (error) { throw new CliError(`No fee estimate available: supply --fee-rate (${error instanceof Error ? error.message : String(error)})`) }
    }
    const rate = args.value("fee-rate") ? Number(args.value("fee-rate")) : client.fees?.hourFee
    if (!rate || !Number.isFinite(rate) || rate < 1) throw new CliError("No fee estimate available: supply --fee-rate")
    if (client.fees && rate < client.fees.minimumFee) throw new CliError(`fee-rate is below the network minimum (${client.fees.minimumFee} sat/vB)`)
    const account = wallet.accounts[family]
    if (!account) throw new CliError("Wallet has no account on the selected network")
    // Same pool as the web send page: not frozen, confirmed (or our own unconfirmed change), worth more than it costs to spend.
    const candidates: Coin[] = snapshot.utxos.filter((u) => !u.frozen).map((u) => {
      const address = snapshot.addresses.find((a) => a.address === u.address)
      if (!address) throw new CliError("UTXO address was not discovered")
      return { ...u, change: address.change, index: address.index }
    }).filter((c) => (c.height > 0 || c.change === 1) && c.value > rate * INPUT_VSIZE)
    const usedChange = await db.addressState.findMany({ where: { walletId: wallet.id, chain: { in: syncedChains(chains[0]) }, used: true }, select: { address: true } })
    const used = new Set(usedChange.map((a) => a.address))
    let changeIndex = 0
    while (used.has(deriveAddress(account.xpub, 1, changeIndex, family).address)) changeIndex++
    const plan = planTx({ chain, recipients: [{ address: required(args, "to"), amount: positiveInteger(args.value("amount-sats"), "amount-sats") }], candidates, fee: feeAt(rate), changeAddress: deriveAddress(account.xpub, 1, changeIndex, family).address, ...(chain !== "xbt" ? { data: new TextEncoder().encode(args.value("message") ?? "") } : {}) })
    const review = { walletId: wallet.id, chain, inputs: plan.inputs, outputs: plan.outputs.map((o) => ({ kind: o.kind, address: o.address ?? null, amount: o.amount, script: bytesToHex(o.script) })), fee: plan.fee, vsize: plan.vsize, feeRate: rate }
    process.stderr.write(`${JSON.stringify(review, null, 2)}\n`)
    if (!args.flags.has("yes")) await confirm()
    const password = passwords.get(wallet.id) ?? (wallet.needsPassword || args.value("password-file") ? await secret(args.value("password-file"), "Wallet password") : "")
    const psbt = buildPsbt(plan, { chain, xpub: account.xpub, fingerprint: account.fingerprint, accountPath: account.path, tipHeight: snapshot.height }).toPSBT()
    const signed = await signPsbt(wallet.id, chain, psbt, password, client)
    validateBroadcast(chain, signed.hex)
    const txid = await broadcastHex(client, signed.hex)
    return { chain, txid, fee: signed.fee, vsize: signed.vsize, review }
  } finally { await session?.close() }
}
