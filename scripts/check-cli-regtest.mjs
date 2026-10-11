import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { harness } from './regtest/harness.mjs'
import { scenarios } from './regtest/scenarios.mjs'
import { interactive } from './regtest/interactive.mjs'
import { edges } from './regtest/edges.mjs'
import { forward } from './regtest/forward.mjs'

const h = await harness()
let passed = false
try {
  await h.start()
  await scenarios(h)
  await edges(h)
  await interactive(h)
  await forward(h)
  passed = true
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  try { await h.close() } catch (error) { console.error(error); passed = false; process.exitCode = 1 }
  writeFileSync(join(h.directory, 'result.json'), JSON.stringify({ passed, cases: h.cases.length, rounds: h.cases.filter(c => c.name.startsWith('round ') && c.status === 'passed').length }, null, 2))
  console.log(`EVIDENCE_RECORDED: ${h.directory}`)
}
