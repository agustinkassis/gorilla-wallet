// `gorila forward …`: rules that sweep a wallet address to another address with an OP_RETURN, run by cron.
import { randomBytes } from "node:crypto"
import { mkdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { CliError, positiveInteger, selectWallet, type Args } from "@/lib/cli/args"
import { confirm, secret } from "@/lib/cli/input"
import { installBlock, installedIds, readCrontab, removeBlock, schedule, shellQuote } from "@/lib/cli/crontab"
import { db } from "@/lib/server/db"
import { listWallets, signingAccount, unlockAccounts } from "@/lib/server/wallets"
import { runForward } from "@/lib/server/forward"
import { familyOf, type Chain } from "@/lib/chains"
import { opReturnScript, PlanError, scriptFor } from "@/lib/tx"
import { bytesToHex } from "@noble/hashes/utils.js"
import type { ForwardRule, ForwardRun } from "@/lib/generated/prisma/client"

function required(args: Args, name: string) {
  const value = args.value(name)
  if (value === undefined || value === "") throw new CliError(`--${name} is required`)
  return value
}

/** The SQLite URL with an absolute path, so cron (another cwd) opens the same database. */
function databaseUrl() {
  const url = process.env.DATABASE_URL ?? "file:./data/wallet.db"
  if (!url.startsWith("file:")) return url
  const path = url.slice(5)
  return `file:${isAbsolute(path) ? path : resolve(process.cwd(), path)}`
}

const iso = (date: Date | null) => date?.toISOString() ?? null

function ruleResult(rule: ForwardRule, walletName?: string) {
  return {
    id: rule.id, walletId: rule.walletId, wallet: walletName ?? null, chain: rule.chain, from: rule.fromAddress, to: rule.toAddress,
    everyMinutes: rule.everyMinutes, schedule: schedule(rule.everyMinutes), minConf: rule.minConf, maxFeeRate: rule.maxFeeRate,
    opReturn: rule.message === null ? "random-90" : "message", message: rule.message, passwordFile: rule.passwordFile,
    createdAt: iso(rule.createdAt), lastCheckedAt: iso(rule.lastCheckedAt),
  }
}

function runResult(run: ForwardRun) {
  return {
    id: run.id, startedAt: iso(run.startedAt), status: run.status, reason: run.reason, txid: run.txid,
    amount: run.amount === null ? null : Number(run.amount), fee: run.fee === null ? null : Number(run.fee), feeRate: run.feeRate,
    inputs: JSON.parse(run.inputs) as unknown[], dataHex: run.dataHex,
  }
}

/** installed | missing per rule id, or null when the crontab can't be read. */
function cronStatus() {
  try {
    const ids = installedIds(readCrontab())
    return (id: string) => (ids.has(id) ? "installed" : "missing")
  } catch { return () => "unknown" }
}

async function findRule(id: string) {
  const rule = await db.forwardRule.findUnique({ where: { id } })
  if (!rule) throw new CliError(`Unknown forward rule: ${id}`)
  return rule
}

async function walletNames() {
  return new Map((await db.wallet.findMany({ select: { id: true, name: true } })).map((w) => [w.id, w.name]))
}

async function add(args: Args) {
  const chainValue = args.value("chain")
  if (chainValue === "xbt") throw new CliError("XBT does not allow OP_RETURN outputs: forward supports --chain btc or regtest")
  if (chainValue !== "btc" && chainValue !== "regtest") throw new CliError("--chain must be btc or regtest")
  const chain: Chain = chainValue
  const yes = args.flags.has("yes")
  if (!yes && (!process.stdin.isTTY || !process.stderr.isTTY)) throw new CliError("Creating a forward rule requires terminal confirmation or --yes")

  const wallet = selectWallet(await listWallets(), args.value("wallet"))
  if (wallet.watchOnly) throw new CliError("Watch-only wallets cannot sign")
  const family = familyOf(chain)
  const from = required(args, "from").trim()
  const to = required(args, "to").trim()
  // Compare scripts, not strings: an upper-case bech32 copy of --from would otherwise sweep A to itself every run.
  let same: boolean
  try { same = bytesToHex(scriptFor(from, chain)) === bytesToHex(scriptFor(to, chain)) } catch (error) { throw new CliError(error instanceof Error ? error.message : String(error)) }
  if (same) throw new CliError("--from and --to are the same address")
  const every = positiveInteger(required(args, "every"), "every")
  const cron = schedule(every)
  const minConfValue = args.value("min-conf") ?? "1"
  const minConf = Number(minConfValue)
  if (!/^\d+$/.test(minConfValue) || minConf > 1000) throw new CliError("--min-conf must be an integer between 0 and 1000")
  const maxFeeRate = Number(required(args, "max-fee-rate"))
  if (!Number.isFinite(maxFeeRate) || maxFeeRate < 1 || maxFeeRate > 1000) throw new CliError("--max-fee-rate must be between 1 and 1000 sat/vB")
  const message = args.value("message")
  if (message !== undefined) {
    if (!message) throw new CliError("--message cannot be empty; omit it for 90 random bytes")
    try { opReturnScript(new TextEncoder().encode(message), chain) } catch (error) { throw new CliError(error instanceof PlanError ? error.message : String(error)) }
  }

  const passwordArg = args.value("password-file")
  let passwordFile: string | null = null
  let password = ""
  if (wallet.needsPassword) {
    if (!passwordArg) throw new CliError("This wallet is encrypted: unattended forwarding needs --password-file FILE (chmod 600)")
    passwordFile = resolve(process.env.GORILA_CALLER_CWD ?? process.cwd(), passwordArg)
    const mode = statSync(passwordFile).mode & 0o777
    if (process.platform !== "win32" && mode & 0o077) throw new CliError(`--password-file must not be readable by group or others: run chmod 600 ${passwordFile} (current permissions ${mode.toString(8)})`)
    password = await secret(passwordFile, "Wallet password")
  } else if (passwordArg) throw new CliError("This wallet has no password: omit --password-file")
  const unlocked = wallet.accounts[family] ? wallet : wallet.kind === "seed" && password ? await unlockAccounts(wallet.id, password) : undefined
  if (!unlocked?.accounts[family]) throw new CliError("Wallet has no account on the selected network")
  await signingAccount(wallet.id, family, password)
  if (!(await db.address.findFirst({ where: { walletId: wallet.id, address: from, family } })))
    throw new CliError("--from address does not belong to this wallet; run addresses to discover it")

  const review = { wallet: wallet.name, walletId: wallet.id, chain, from, to, everyMinutes: every, schedule: cron, minConf, maxFeeRate, opReturn: message === undefined ? "random-90" : "message", message: message ?? null }
  process.stderr.write(`${JSON.stringify(review, null, 2)}\n`)
  if (!yes) await confirm("Create this forward rule? Type yes: ", "Cancelled; no forward rule was created")

  const id = randomBytes(4).toString("hex")
  const logFile = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "gorila", `forward-${id}.log`)
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 })
  const env = [`DATABASE_URL=${shellQuote(databaseUrl())}`, ...(process.env.NODE_EXTRA_CA_CERTS ? [`NODE_EXTRA_CA_CERTS=${shellQuote(resolve(process.env.NODE_EXTRA_CA_CERTS))}`] : [])]
  const line = `${cron} ${env.join(" ")} ${shellQuote(process.execPath)} ${shellQuote(resolve("bin/gorila.mjs"))} forward run ${id} --json >> ${shellQuote(logFile)} 2>&1`
  const rule = await db.forwardRule.create({
    data: { id, walletId: wallet.id, chain, fromAddress: from, toAddress: to, everyMinutes: every, minConf, maxFeeRate, message: message ?? null, passwordFile, cronLine: line, logFile },
  })
  try { installBlock(id, line) } catch (error) {
    await db.forwardRule.delete({ where: { id } })
    throw error
  }
  return { rule: ruleResult(rule, wallet.name), cron: { status: "installed", schedule: cron, line, log: logFile } }
}

export async function forwardCommand(command: string, args: Args, timeoutMs: number) {
  if (command === "forward add") return add(args)
  if (command === "forward list") {
    const [rules, names, status] = await Promise.all([db.forwardRule.findMany({ orderBy: { createdAt: "asc" } }), walletNames(), cronStatus()])
    return { rules: await Promise.all(rules.map(async (rule) => {
      const last = await db.forwardRun.findFirst({ where: { ruleId: rule.id }, orderBy: { id: "desc" } })
      return { ...ruleResult(rule, names.get(rule.walletId)), cron: status(rule.id), lastRun: last ? runResult(last) : null }
    })) }
  }
  const id = args.positionals[2]
  if (command === "forward show") {
    const rule = await findRule(id)
    const count = positiveInteger(args.value("runs") ?? "20", "runs")
    const runs = await db.forwardRun.findMany({ where: { ruleId: id }, orderBy: { id: "desc" }, take: Math.min(count, 1000) })
    return { rule: ruleResult(rule, (await walletNames()).get(rule.walletId)), cron: { status: cronStatus()(id), schedule: schedule(rule.everyMinutes), line: rule.cronLine, log: rule.logFile }, runs: runs.map(runResult) }
  }
  if (command === "forward remove") {
    const rule = await findRule(id)
    const cronRemoved = removeBlock(id)
    await db.$transaction([db.forwardRun.deleteMany({ where: { ruleId: id } }), db.forwardRule.delete({ where: { id } })])
    return { removed: id, cronRemoved, log: rule.logFile }
  }
  if (command === "forward run") {
    await findRule(id)
    return runForward(id, { dryRun: args.flags.has("dry-run"), timeoutMs })
  }
  throw new CliError(`Unknown command: ${command}. Use --help`)
}
