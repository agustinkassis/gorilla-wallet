import { runCli } from "@/lib/cli/run"
import { parseArgs } from "@/lib/cli/args"
import { db } from "@/lib/server/db"
import { formatText } from "@/lib/cli/output"

async function main() {
  try {
    const result = await runCli(process.argv.slice(2))
    if (parseArgs(process.argv.slice(2)).json) console.log(JSON.stringify(result))
    else if ("help" in result) console.log(result.help)
    else console.log(formatText(result))
  } catch (error) {
    console.error(`gorilla: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally { await db.$disconnect() }
}
void main()
