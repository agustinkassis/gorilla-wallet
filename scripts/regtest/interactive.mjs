import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function interactive(h) {
  const password = 'regtest-password'
  const terminal = async (name, args, actions) => {
    const child = spawn('python3', [join(h.root, 'scripts/regtest/terminal.py')], { cwd: h.temporary, env: h.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdin.end(JSON.stringify({ command: [process.execPath, join(h.root, 'bin/gorilla.mjs'), ...args, '--json', '--timeout', '20'], actions: actions.map(([prompt, input]) => ({ prompt, hex: Buffer.from(input).toString('hex') })) }))
    const [code] = await once(child, 'close')
    assert.equal(code, 0, stderr)
    const result = JSON.parse(stdout)
    writeFileSync(join(h.directory, `terminal-${name}.json`), JSON.stringify({ args, ...result }, null, 2))
    return result
  }
  await h.check('hidden terminal password exports encrypted seed', async () => {
    const expected = await h.cli(['wallet', 'export-seed', '--wallet', 'B', '--password-file', join(h.temporary, 'password.txt')])
    const result = await terminal('export', ['wallet', 'export-seed', '--wallet', 'B'], [['Wallet password:', `${password}\r`]])
    assert.equal(result.code, 0)
    assert.equal(JSON.parse(result.stdout).mnemonic, expected.mnemonic)
    assert.ok(!result.terminal.includes(password))
    return { seedMatches: true, passwordHidden: true }
  })
  const address = (await h.cli(['receive', '--wallet', 'A', '--chain', 'regtest'])).address
  const args = ['send', '--wallet', 'B', '--chain', 'regtest', '--to', address, '--amount-sats', '10000', '--fee-rate', '2']
  for (const [name, input] of [['decline', 'no\r'], ['interrupt', '\u0003']]) {
    await h.check(`terminal ${name} cancels send without broadcast`, async () => {
      const before = h.rpc('getrawmempool').sort()
      const result = await terminal(name, args, [['Type yes:', input]])
      assert.equal(result.code, 1)
      assert.match(result.terminal, /Cancelled/)
      assert.equal(result.stdout, '')
      assert.deepEqual(h.rpc('getrawmempool').sort(), before)
      return { mempoolUnchanged: true }
    })
  }
  await h.check('terminal confirmation and hidden password publish confirmed send', async () => {
    const result = await terminal('confirm', args, [['Type yes:', 'yes\r'], ['Wallet password:', `${password}\r`]])
    assert.equal(result.code, 0)
    assert.ok(!result.terminal.includes(password))
    const sent = JSON.parse(result.stdout)
    assert.ok(h.rpc('getrawmempool').includes(sent.txid))
    await h.mine()
    assert.ok(h.nodeTx(sent.txid).confirmations > 0)
    return { txid: sent.txid, passwordHidden: true, confirmations: h.nodeTx(sent.txid).confirmations }
  })
}
