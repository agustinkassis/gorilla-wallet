// One crontab block per forward rule, delimited by markers; every other line of the user's crontab is preserved.
import { spawnSync } from "node:child_process"
import { CliError } from "@/lib/cli/args"

const MINUTES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30]
const HOURS = [1, 2, 3, 4, 6, 8, 12, 24]

/** Cron schedule running every `minutes`: a divisor of 60, or a whole number of hours dividing 24. */
export function schedule(minutes: number) {
  if (MINUTES.includes(minutes)) return minutes === 1 ? "* * * * *" : `*/${minutes} * * * *`
  if (minutes % 60 === 0 && HOURS.includes(minutes / 60)) {
    const hours = minutes / 60
    return hours === 1 ? "0 * * * *" : hours === 24 ? "0 0 * * *" : `0 */${hours} * * *`
  }
  throw new CliError(`--every must be one of ${[...MINUTES, ...HOURS.map((h) => h * 60)].join(", ")} minutes`)
}

/** POSIX single-quoted shell word; `%` is escaped because cron turns it into a newline. */
export function shellQuote(value: string) {
  if (/[\r\n]/.test(value)) throw new CliError("Paths and values in a crontab line cannot contain newlines")
  return `'${value.replace(/'/g, `'\\''`)}'`.replace(/%/g, "\\%")
}

const begin = (id: string) => `# BEGIN gorila-forward ${id}`
const end = (id: string) => `# END gorila-forward ${id}`

function crontab(args: string[], input?: string) {
  if (process.platform === "win32") throw new CliError("Forward rules need cron: Windows is not supported")
  const result = spawnSync(process.env.GORILA_CRONTAB_BIN || "crontab", args, { input, encoding: "utf8" })
  if (result.error) throw new CliError(`crontab: ${result.error.message}`)
  return result
}

export function readCrontab() {
  const result = crontab(["-l"])
  if (result.status === 0) return result.stdout
  if (/no crontab/i.test(result.stderr)) return ""
  throw new CliError(`crontab -l failed: ${result.stderr.trim() || `exit ${result.status}`}`)
}

function writeCrontab(text: string) {
  const result = crontab(["-"], text)
  if (result.status !== 0) throw new CliError(`crontab update failed: ${result.stderr.trim() || `exit ${result.status}`}`)
}

/** The crontab without rule `id`'s block, and whether it had one. */
function without(text: string, id: string) {
  const lines = text.split("\n")
  const kept: string[] = []
  let inside = false, found = false
  for (const line of lines) {
    if (line.trim() === begin(id)) { inside = true; found = true; continue }
    if (inside) { if (line.trim() === end(id)) inside = false; continue }
    kept.push(line)
  }
  // An unterminated block would swallow every line after it: refuse instead of dropping foreign entries.
  if (inside) throw new CliError(`crontab block for forward rule ${id} has no "${end(id)}" line: fix it with crontab -e`)
  return { text: kept.join("\n"), found }
}

export function installBlock(id: string, line: string) {
  const current = without(readCrontab(), id).text
  const base = current && !current.endsWith("\n") ? `${current}\n` : current
  writeCrontab(`${base}${begin(id)}\n${line}\n${end(id)}\n`)
}

/** Removes rule `id`'s block; false when the crontab had none (nothing is written then). */
export function removeBlock(id: string) {
  const { text, found } = without(readCrontab(), id)
  if (found) writeCrontab(text)
  return found
}

/** Rule ids with a complete block (BEGIN, command, END) in `text`. */
export function installedIds(text: string) {
  const ids = new Set<string>()
  const lines = text.split("\n").map((l) => l.trim())
  lines.forEach((line, i) => {
    const match = /^# BEGIN gorila-forward ([0-9a-f]{8})$/.exec(line)
    if (match && lines[i + 1]?.includes(`forward run ${match[1]}`) && lines[i + 2] === end(match[1])) ids.add(match[1])
  })
  return ids
}
