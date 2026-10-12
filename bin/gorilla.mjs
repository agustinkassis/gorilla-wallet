#!/usr/bin/env node
import { realpathSync, existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..')
const localRequire = createRequire(resolve(root, 'package.json'))
const caller = process.cwd()
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('gorilla requires Node 24 or newer')
  process.exit(1)
}
process.chdir(root)
localRequire('@next/env').loadEnvConfig(root, false, { info() {}, error: (...args) => console.error(...args) })
process.env.GORILLA_CALLER_CWD = caller
const args = process.argv.slice(2)
function needsMigration() {
  const url = process.env.DATABASE_URL ?? 'file:./data/wallet.db'
  if (!url.startsWith('file:')) return true
  const path = resolve(root, url.slice(5))
  if (!existsSync(path)) return true
  const Database = localRequire('better-sqlite3')
  const database = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'").get()
    if (!table) return true
    const applied = new Set(database.prepare('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL').all().map((row) => row.migration_name))
    return readdirSync(resolve(root, 'prisma/migrations'), { withFileTypes: true }).some((entry) => entry.isDirectory() && !applied.has(entry.name))
  } finally { database.close() }
}
if (args.length && !args.includes('--help') && !args.includes('-h')) {
  for (let attempt = 0; attempt < 4 && needsMigration(); attempt++) {
    const migration = spawnSync(process.execPath, [localRequire.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { cwd: root, env: process.env, encoding: 'utf8' })
    if (migration.status === 0 && !migration.error) break
    if (attempt < 3 && /database is locked|SQLITE_BUSY/i.test(migration.stderr ?? '')) {
      await new Promise((done) => setTimeout(done, 200 * (attempt + 1)))
      continue
    }
    console.error(migration.stderr || migration.error?.message || 'Database migration failed')
    process.exit(1)
  }
}
const child = spawnSync(process.execPath, [localRequire.resolve('tsx/cli'), '--conditions=react-server', '--tsconfig', resolve(root, 'tsconfig.json'), resolve(root, 'scripts/gorilla.ts'), ...args], { cwd: root, env: process.env, stdio: 'inherit' })
if (child.error) console.error(child.error.message)
process.exit(child.status ?? 1)
