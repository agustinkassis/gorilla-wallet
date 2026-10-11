import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { StringDecoder } from "node:string_decoder"
import { CliError } from "@/lib/cli/args"

export async function secret(file: string | undefined, prompt: string, required = true): Promise<string> {
  if (file) return (await readFile(resolve(process.env.GORILA_CALLER_CWD ?? process.cwd(), file), "utf8")).replace(/\r?\n$/, "")
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    if (!required) return ""
    throw new CliError(`${prompt}: a terminal or an explicit secret file is required`)
  }
  const input = process.stdin
  input.setRawMode(true)
  input.resume()
  try {
    process.stderr.write(`${prompt}: `)
    return await new Promise<string>((resolveInput, reject) => {
      let value = ""
      const decoder = new StringDecoder("utf8")
      const onData = (chunk: Buffer) => {
        for (const c of decoder.write(chunk)) {
          if (c === "\u0003" || c === "\u0004") { cleanup(); reject(new CliError("Cancelled")); return }
          if (c === "\r" || c === "\n") { cleanup(); resolveInput(value); return }
          if (c === "\u007f" || c === "\b") value = value.slice(0, -1)
          else if (c >= " ") value += c
        }
      }
      const onEnd = () => { cleanup(); reject(new CliError("Secret input closed")) }
      const cleanup = () => { input.off("data", onData); input.off("end", onEnd) }
      input.on("data", onData)
      input.once("end", onEnd)
    })
  } finally {
    input.setRawMode(false)
    input.pause()
    process.stderr.write("\n")
  }
}

export async function confirm(question = "Sign and broadcast? Type yes: ", cancelled = "Cancelled; transaction was not signed or broadcast") {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new CliError("Sending requires terminal confirmation or --yes")
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const abort = new AbortController()
  rl.once("SIGINT", () => abort.abort())
  try {
    const answer = await rl.question(question, { signal: abort.signal }).catch((error: unknown) => {
      if (abort.signal.aborted) throw new CliError(cancelled)
      throw error
    })
    if (answer.trim() !== "yes") throw new CliError(cancelled)
  } finally { rl.close() }
}
