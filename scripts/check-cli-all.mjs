import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const requireLocal = createRequire(import.meta.url)
const temporary = mkdtempSync(join(tmpdir(), 'gorila-core-'))
function run(args, env = {}) {
  const child = spawnSync(process.execPath, args, { cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, SEED_PHRASE: '', REGTEST_ELECTRUM: '', MEMPOOL_REGTEST_URL: '', ...env }, stdio: 'inherit' })
  if (child.status !== 0 || child.error) throw new Error(child.error?.message ?? `Check failed: ${args.at(-1)} (${child.status})`)
}
try {
  const tsx = requireLocal.resolve('tsx/cli')
  run([tsx, 'scripts/check-cli-args.ts'])
  for (const [script, database] of [['scripts/check-wallet-core.ts', 'wallet-core-check.db'], ['scripts/check-regtest-core.ts', 'regtest-core-check.db'], ['scripts/check-sync-session.ts', 'sync-check.db'], ['scripts/check-forward.ts', 'forward-check.db']]) {
    const env = { DATABASE_URL: `file:${join(temporary, database)}` }
    run([requireLocal.resolve('prisma/build/index.js'), 'migrate', 'deploy'], env)
    run([tsx, '--conditions=react-server', script], env)
  }
  run([tsx, '--conditions=react-server', 'scripts/check-cli.ts'])
} finally { rmSync(temporary, { recursive: true, force: true }) }
