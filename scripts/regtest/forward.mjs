import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// forward rules against a real node: a fake crontab records the installed blocks; runs are invoked directly.
export async function forward(h) {
  const { cli, check, rpc } = h
  const crontab = join(h.temporary, 'crontab.txt')
  const bin = join(h.temporary, 'fake-crontab.sh')
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "-l" ]; then [ -f '${crontab}' ] && exec cat '${crontab}'; echo 'no crontab for regtest' >&2; exit 1; fi\nif [ "$1" = "-" ]; then exec cat > '${crontab}'; fi\nexit 2\n`, { mode: 0o755 })
  h.env.GORILA_CRONTAB_BIN = bin
  h.env.XDG_STATE_HOME = join(h.temporary, 'state')
  const chain = ['--chain', 'regtest']
  await check('forward: create wallet F', async () => (await cli(['wallet', 'create', '--name', 'F'])).wallet)
  const from = await check('forward: F receive address', async () => cli(['receive', '--wallet', 'F', ...chain]))
  const to = rpc('getnewaddress')
  const funding = rpc('sendtoaddress', from.address, 0.01)
  await h.indexedTx(funding)
  const rule = await check('forward: add rule with random OP_RETURN installs a crontab block', async () => {
    const r = await cli(['forward', 'add', '--wallet', 'F', ...chain, '--from', from.address, '--to', to, '--every', '5', '--max-fee-rate', '1000', '--yes'])
    assert.ok(readFileSync(crontab, 'utf8').includes(`forward run ${r.rule.id}`))
    return r.rule
  })
  await check('forward: unconfirmed funding is not forwarded', async () => {
    const r = await cli(['forward', 'run', rule.id])
    assert.equal(r.status, 'idle')
    return r
  })
  await h.mine()
  const sent = await check('forward: confirmed funding is swept to B with a 90-byte random OP_RETURN', async () => {
    const r = await cli(['forward', 'run', rule.id])
    assert.equal(r.status, 'sent')
    await h.indexedTx(r.txid)
    const tx = h.nodeTx(r.txid)
    assert.deepEqual(tx.vin.map(input => input.txid), [funding])
    assert.equal(tx.vout.length, 2)
    assert.equal(Math.round(tx.vout.find(output => output.scriptPubKey.address === to).value * 1e8), r.amount)
    assert.equal(r.amount + r.fee, 1_000_000)
    const data = tx.vout.find(output => output.scriptPubKey.type === 'nulldata')
    assert.equal(data.scriptPubKey.hex, `6a4c5a${r.dataHex}`)
    assert.ok(rpc('getrawmempool').includes(r.txid))
    return r
  })
  await check('forward: spent coins are not forwarded again', async () => {
    const r = await cli(['forward', 'run', rule.id])
    assert.equal(r.status, 'idle')
    return r
  })
  await check('forward: show records the sent run', async () => {
    const r = await cli(['forward', 'show', rule.id])
    assert.equal(r.runs[0].txid, sent.txid)
    assert.equal(r.cron.status, 'installed')
    return r
  })
  await check('forward: remove deletes the rule and its crontab block', async () => {
    const r = await cli(['forward', 'remove', rule.id])
    assert.equal(r.cronRemoved, true)
    assert.ok(!readFileSync(crontab, 'utf8').includes(rule.id))
    assert.equal((await cli(['forward', 'list'])).rules.length, 0)
    return r
  })
}
