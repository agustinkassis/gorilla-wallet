// Desktop bundle inputs (Tauri beforeBuildCommand): the Next.js standalone server, and the Node running this script
// as the `gorilla-node` sidecar. Run it with the Node that installed node_modules: better-sqlite3 is native.
import { execFileSync, execSync } from "node:child_process"
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { createRequire } from "node:module"

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || /host: (\S+)/.exec(execSync("rustc -vV").toString())[1]

// Fails here, not at app launch, when better-sqlite3 was built for another Node ABI.
new (createRequire(import.meta.url)("better-sqlite3"))(":memory:").close()

execSync("pnpm build", { stdio: "inherit", env: { ...process.env, STANDALONE: "1" } })

const out = "src-tauri/server"
rmSync(out, { recursive: true, force: true })
// Dereference symlinks (Turbopack's external aliases): installers can't carry them.
// Never ship a local .env (it may hold SEED_PHRASE); sharp (next/image, unused here) would be over half the size.
const skip = /[\\/](\.env|sharp|@img)[^\\/]*$/
cpSync(".next/standalone", out, { recursive: true, dereference: true, filter: (src) => !skip.test(src) })
cpSync(".next/static", `${out}/.next/static`, { recursive: true })
cpSync("prisma/migrations", `${out}/migrations`, { recursive: true })
copyFileSync("src-tauri/start.mjs", `${out}/start.mjs`)

// Developer ID builds (APPLE_SIGNING_IDENTITY, see README): Tauri signs the app and the Node sidecar but not native
// modules among the resources, and notarization rejects any Mach-O without a Developer ID signature and timestamp.
const identity = process.env.APPLE_SIGNING_IDENTITY
if (process.platform === "darwin" && identity && identity !== "-")
  for (const file of readdirSync(out, { recursive: true }).filter((f) => /\.(node|dylib)$/.test(f)))
    execFileSync("codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", identity, `${out}/${file}`], { stdio: "inherit" })

mkdirSync("src-tauri/binaries", { recursive: true })
copyFileSync(process.execPath, `src-tauri/binaries/gorilla-node-${triple}${process.platform === "win32" ? ".exe" : ""}`)
