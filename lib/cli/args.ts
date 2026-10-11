import type { WalletInfo } from "@/lib/wallet"

export class CliError extends Error {}
const booleanOptions = new Set(["json", "next", "all-wallets", "yes", "include-passphrase", "passphrase", "help", "dry-run"])
const valueOptions = new Set(["wallet", "chain", "timeout", "name", "words", "seed-file", "password-file", "passphrase-file", "label", "electrum", "mempool", "to", "amount-sats", "message", "fee-rate", "from", "every", "min-conf", "max-fee-rate", "runs"])

export function parseArgs(argv: readonly string[]) {
  const positionals: string[] = []
  const values: Record<string, string[]> = {}
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--") { positionals.push(...argv.slice(i + 1)); break }
    if (arg === "-h") { flags.add("help"); continue }
    if (!arg.startsWith("--")) { positionals.push(arg); continue }
    const equal = arg.indexOf("=")
    const key = arg.slice(2, equal < 0 ? undefined : equal)
    if (booleanOptions.has(key)) {
      if (equal >= 0) throw new CliError(`--${key} does not take a value`)
      flags.add(key)
    } else if (valueOptions.has(key)) {
      const value = equal < 0 ? argv[++i] : arg.slice(equal + 1)
      if (value === undefined || value.startsWith("--")) throw new CliError(`--${key} requires a value`)
      if (values[key] && key !== "electrum" && key !== "mempool") throw new CliError(`--${key} may be supplied only once`)
      ;(values[key] ??= []).push(value)
    } else throw new CliError(`Unknown option: --${key}`)
  }
  return { positionals, values, flags, json: flags.has("json"), value: (key: string) => values[key]?.[0] }
}
export type Args = ReturnType<typeof parseArgs>
export function positiveInteger(value: string | undefined, name: string) {
  const n = Number(value)
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(n) || n <= 0) throw new CliError(`${name} must be a positive integer`)
  return n
}
export function selectWallet(wallets: WalletInfo[], selector?: string) {
  if (!wallets.length) throw new CliError("No wallets: use gorila wallet create or import")
  if (!selector) {
    if (wallets.length !== 1) throw new CliError("Multiple wallets: specify --wallet ID_OR_NAME")
    return wallets[0]
  }
  const byId = wallets.find((w) => w.id === selector)
  if (byId) return byId
  const matches = wallets.filter((w) => w.name === selector)
  if (matches.length > 1) throw new CliError("Wallet name is ambiguous: specify its ID")
  if (!matches.length) throw new CliError(`Unknown wallet: ${selector}`)
  return matches[0]
}
