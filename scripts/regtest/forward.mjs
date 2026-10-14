import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, constants, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

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

  const db = new Database(h.env.DATABASE_URL.slice(5))
  const sats = value => Math.round(value * 1e8)
  const key = input => `${input.txid}:${input.vout}`
  const keys = inputs => inputs.map(key).sort()
  const total = inputs => inputs.reduce((sum, input) => sum + input.value, 0)
  const pool = () => rpc('getrawmempool').sort()
  const run = (rule, dry = false) => cli(['forward', 'run', rule.id, ...(dry ? ['--dry-run'] : [])])
  const show = rule => cli(['forward', 'show', rule.id])
  const remove = rule => cli(['forward', 'remove', rule.id])
  const replace = (args, option, value) => args.map((arg, i) => args[i - 1] === option ? value : arg)
  const funds = async (address, amount) => {
    const txid = rpc('sendtoaddress', address, amount / 1e8)
    await h.indexedTx(txid)
    const output = h.nodeTx(txid).vout.find(v => v.scriptPubKey.address === address)
    assert.equal(sats(output.value), amount)
    return { txid, vout: output.n, value: amount }
  }
  const fixture = async (name, passwordFile, exclusions = true) => {
    const auth = passwordFile ? ['--password-file', passwordFile] : []
    const wallet = (await cli(['wallet', 'create', '--name', name, ...auth])).wallet
    const receive = (await cli(['receive', '--wallet', name, ...chain, ...auth])).address
    const second = (await cli(['receive', '--wallet', name, ...chain, '--next'])).address
    const third = (await cli(['receive', '--wallet', name, ...chain, '--next'])).address
    const descriptor = await cli(['wallet', 'descriptor', '--wallet', name, ...chain])
    const changes = rpc('deriveaddresses', descriptor.change, [0, 3])
    const addresses = [receive, second, changes[0]]
    const amounts = [120_000, 230_000, 350_000]
    const txid = rpc('sendmany', '', Object.fromEntries(addresses.map((address, i) => [address, amounts[i] / 1e8])))
    await h.indexedTx(txid)
    const node = h.nodeTx(txid)
    const eligible = addresses.map((address, i) => ({ txid, vout: node.vout.find(v => v.scriptPubKey.address === address).n, value: amounts[i] }))
    const frozen = exclusions ? await funds(third, 900_000) : null
    await h.mine()
    await cli(['balance', '--wallet', name, ...chain])
    if (frozen) db.prepare('INSERT OR REPLACE INTO Label(walletId,chain,type,ref,spendable) VALUES(?,?,?,?,?)').run(wallet.id, 'regtest', 'output', key(frozen), 0)
    const pending = exclusions ? await funds(changes[1], 800_000) : null
    return { name, wallet, receive, second, third, changes, eligible, frozen, pending, auth }
  }
  const addArgs = (f, source, amountSats = null, balanceAboveSats = null, extra = [], destination = rpc('getnewaddress')) => [
    'forward', 'add', '--wallet', f.name, ...chain,
    ...(source === 'wallet' ? ['--from-wallet'] : ['--from', f.receive]),
    '--to', destination, '--every', '5', '--max-fee-rate', '1000', '--yes', ...f.auth,
    ...(amountSats === null ? [] : ['--amount-sats', String(amountSats)]),
    ...(balanceAboveSats === null ? [] : ['--balance-above-sats', String(balanceAboveSats)]), ...extra,
  ]
  const add = async (f, source, amountSats = null, balanceAboveSats = null, extra = []) => {
    const r = await cli(addArgs(f, source, amountSats, balanceAboveSats, extra))
    const expected = { source, mode: amountSats === null ? 'sweep' : 'fixed', amountSats, balanceAboveSats, from: source === 'wallet' ? null : f.receive }
    for (const [field, value] of Object.entries(expected)) assert.equal(r.rule[field], value, field)
    assert.ok(readFileSync(crontab, 'utf8').includes(`forward run ${r.rule.id}`))
    const shown = await show(r.rule)
    const listed = (await cli(['forward', 'list'])).rules.find(rule => rule.id === r.rule.id)
    for (const result of [shown.rule, listed]) {
      assert.ok(result)
      for (const [field, value] of Object.entries(expected)) assert.equal(result[field], value, field)
    }
    return r.rule
  }
  const assertPlan = (r, allowed, observedBalance, amountSats, changeAddress) => {
    assert.equal(r.observedBalance, observedBalance)
    assert.ok(Number.isSafeInteger(r.amount) && r.amount > 0)
    assert.ok(Number.isSafeInteger(r.fee) && r.fee > 0)
    assert.ok(r.inputs.length > 0)
    assert.equal(new Set(keys(r.inputs)).size, r.inputs.length)
    for (const input of r.inputs) assert.deepEqual(input, allowed.find(coin => key(coin) === key(input)))
    if (amountSats === null) {
      assert.deepEqual(keys(r.inputs), keys(allowed))
      assert.equal(r.change, null)
      assert.equal(r.amount + r.fee, total(allowed))
    } else {
      assert.equal(r.amount, amountSats)
      assert.ok(r.change && Number.isSafeInteger(r.change.amount) && r.change.amount > 0)
      assert.deepEqual(Object.keys(r.change).sort(), ['address', 'amount'])
      assert.equal(r.change.address, changeAddress)
      assert.equal(r.amount + r.fee + r.change.amount, total(r.inputs))
    }
    assert.match(r.dataHex, /^[a-f0-9]{180}$/)
  }
  const assertSent = async (rule, r) => {
    assert.equal(r.status, 'sent')
    await h.indexedTx(r.txid)
    const node = h.nodeTx(r.txid)
    assert.deepEqual(keys(node.vin), keys(r.inputs))
    for (const input of r.inputs) {
      const parent = h.nodeTx(input.txid).vout.find(v => v.n === input.vout)
      assert.equal(sats(parent.value), input.value)
      assert.equal(rpc('gettxout', input.txid, input.vout, true), null)
    }
    const recipient = node.vout.filter(v => v.scriptPubKey.address === rule.to)
    assert.equal(recipient.length, 1)
    assert.equal(sats(recipient[0].value), r.amount)
    assert.equal(node.vout.length, r.change === null ? 2 : 3)
    if (r.change) {
      const change = node.vout.filter(v => v.scriptPubKey.address === r.change.address)
      assert.equal(change.length, 1)
      assert.equal(sats(change[0].value), r.change.amount)
    }
    const data = node.vout.filter(v => v.scriptPubKey.type === 'nulldata')
    assert.equal(data.length, 1)
    assert.equal(data[0].value, 0)
    assert.equal(data[0].scriptPubKey.hex, `6a4c5a${r.dataHex}`)
    assert.ok(node.vin.every(input => input.txinwitness?.[0].endsWith('01')))
    assert.equal(node.vout.reduce((sum, output) => sum + sats(output.value), 0) + r.fee, total(r.inputs))
    assert.equal(sats(rpc('getmempoolentry', r.txid).fees.base), r.fee)
    const history = (await show(rule)).runs.find(entry => entry.txid === r.txid)
    assert.ok(history)
    assert.equal(history.status, 'sent')
    assert.deepEqual(keys(history.inputs), keys(r.inputs))
    assert.deepEqual([...history.inputs].sort((a, b) => key(a).localeCompare(key(b))), [...r.inputs].sort((a, b) => key(a).localeCompare(key(b))))
    assert.equal(history.observedBalance, r.observedBalance)
    assert.equal(history.amount, r.amount)
    assert.equal(history.fee, r.fee)
    return node
  }
  const dryRun = async (rule, allowed, observedBalance, amountSats, changeAddress) => {
    const before = await show(rule)
    const mempool = pool()
    // A broken secret proves preview never reaches signing, not merely that it avoids publication.
    const password = rule.passwordFile ? readFileSync(rule.passwordFile) : null
    if (password) writeFileSync(rule.passwordFile, 'deliberately-wrong-password')
    let r
    try { r = await run(rule, true) } finally { if (password) writeFileSync(rule.passwordFile, password) }
    assert.equal(r.status, 'dry-run')
    assert.equal(r.txid, undefined)
    assertPlan(r, allowed, observedBalance, amountSats, changeAddress)
    assert.deepEqual(pool(), mempool)
    const after = await show(rule)
    assert.deepEqual(after.runs, before.runs)
    assert.equal(after.rule.lastCheckedAt, before.rule.lastCheckedAt)
    for (const input of allowed) assert.ok(rpc('gettxout', input.txid, input.vout, true))
    return r
  }

  try {
    for (const source of ['address', 'wallet']) {
      for (const mode of ['sweep', 'fixed']) {
        const f = await check(`forward: fund ${source}/${mode} on multiple receive and change addresses`, () => fixture(`F-${source}-${mode}`))
        const amount = mode === 'sweep' ? null : source === 'wallet' ? 600_000 : 50_000
        const limit = source === 'wallet' && mode === 'fixed' ? 699_999 : null
        const allowed = source === 'wallet' ? f.eligible : [f.eligible[0]]
        const change = source === 'wallet' ? f.changes[2] : f.receive
        const r = await check(`forward: ${source}/${mode} persists and reports source and mode`, () => add(f, source, amount, limit))
        await check(`forward: ${source}/${mode} previews without broadcast or history`, () => dryRun(r, allowed, 700_000, amount, change))
        await check(`forward: ${source}/${mode} real outputs conserve selected funds and exclude frozen/unconfirmed inputs`, async () => {
          const result = await run(r)
          assertPlan(result, allowed, 700_000, amount, change)
          if (source === 'wallet') assert.deepEqual(keys(result.inputs), keys(f.eligible))
          if (limit !== null) assert.ok(result.change.amount < limit)
          await assertSent(r, result)
          for (const excluded of [f.frozen, f.pending]) assert.ok(rpc('gettxout', excluded.txid, excluded.vout, true))
          const addresses = (await cli(['addresses', '--wallet', f.name, ...chain])).addresses
          if (result.change && source === 'wallet') assert.equal(addresses.find(a => a.address === result.change.address).change, 1)
          return result
        })
        await check(`forward: ${source}/${mode} does not reuse sent inputs in another rule`, async () => {
          const other = await add(f, source, amount)
          const before = pool()
          const result = await run(other)
          // A sweep with nothing left to spend stays idle; a fixed amount cannot be paid, so the attempt is recorded.
          assert.equal(result.status, mode === 'sweep' ? 'idle' : 'skipped')
          assert.equal(result.observedBalance, source === 'wallet' ? 0 : 580_000)
          if (mode === 'fixed') assert.match(result.reason, /insufficient/i)
          assert.deepEqual(pool(), before)
          const runs = (await show(other)).runs
          assert.equal(runs.length, mode === 'sweep' ? 0 : 1)
          if (mode === 'fixed') assert.deepEqual(runs[0].inputs, [])
          await remove(other)
          return result
        })
        await remove(r)
      }
    }

    await check('forward: fixed wallet history records selected inputs, not the entire eligible candidate pool', async () => {
      const f = await fixture('F-selected', undefined, false)
      const rule = await add(f, 'wallet', 100_000)
      const preview = await dryRun(rule, f.eligible, 700_000, 100_000, f.changes[1])
      assert.equal(preview.inputs.length, 1)
      const result = await run(rule)
      assertPlan(result, f.eligible, 700_000, 100_000, f.changes[1])
      assert.equal(result.inputs.length, 1)
      assert.deepEqual(keys(result.inputs), keys(preview.inputs))
      await assertSent(rule, result)
      for (const coin of f.eligible.filter(coin => !keys(result.inputs).includes(key(coin))))
        assert.ok(rpc('gettxout', coin.txid, coin.vout, true))
      await remove(rule)
      return result
    })

    await check('forward: persistent sent-input reservations exclude otherwise eligible real UTXOs', async () => {
      const f = await fixture('F-reserved', undefined, false)
      const owner = await add(f, 'address')
      const walletRule = await add(f, 'wallet')
      const reserved = f.eligible[0]
      // Deliberately retain a conservative reservation while the node still lists the outpoint as unspent.
      // Both the outpoint and the known transaction are real; only the durable reservation is a SQLite fixture.
      assert.ok(h.nodeTx(sent.txid).confirmations > 0)
      const record = db.prepare('INSERT INTO ForwardRun(ruleId,startedAt,status,txid,inputs) VALUES(?,?,?,?,?)').run(owner.id, Date.now(), 'sent', sent.txid, JSON.stringify([reserved]))
      try {
        const before = pool()
        const result = await run(owner)
        assert.equal(result.status, 'idle')
        assert.equal(result.observedBalance, 580_000)
        assert.deepEqual(pool(), before)
        assert.ok(rpc('gettxout', reserved.txid, reserved.vout, true))
        await dryRun(walletRule, f.eligible.slice(1), 580_000, null, null)
      } finally { db.prepare('DELETE FROM ForwardRun WHERE id=?').run(record.lastInsertRowid) }
      const released = await dryRun(walletRule, f.eligible, 700_000, null, null)
      await remove(owner)
      await remove(walletRule)
      return { released, reservedInput: reserved }
    })

    const threshold = await check('forward: fund threshold wallet across receive and change branches', () => fixture('F-threshold'))
    for (const source of ['address', 'wallet']) {
      for (const limit of [700_000, 700_001]) {
        await check(`forward: ${source} wallet balance equal to or below ${limit} is skipped`, async () => {
          const rule = await add(threshold, source, 50_000, limit)
          const before = pool()
          for (const dry of [true, false]) {
            const result = await run(rule, dry)
            assert.equal(result.status, 'skipped')
            assert.equal(result.observedBalance, 700_000)
            assert.match(result.reason, new RegExp(`700000.*${limit}`))
          }
          assert.deepEqual(pool(), before)
          // Only the real run is recorded, and an unmet threshold spends nothing.
          const runs = (await show(rule)).runs
          assert.equal(runs.length, 1)
          assert.equal(runs[0].status, 'skipped')
          assert.equal(runs[0].observedBalance, 700_000)
          assert.deepEqual(runs[0].inputs, [])
          assert.equal(runs[0].txid, null)
          for (const coin of threshold.eligible) assert.ok(rpc('gettxout', coin.txid, coin.vout, true))
          await remove(rule)
          return { source, observedBalance: 700_000, balanceAboveSats: limit }
        })
      }
    }
    await check('forward: zero threshold is valid and evaluates eligible balance, not frozen or pending balance', async () => {
      const rule = await add(threshold, 'wallet', null, 0)
      const result = await dryRun(rule, threshold.eligible, 700_000, null, null)
      await remove(rule)
      return result
    })
    await check('forward: satisfied wallet threshold cannot subsidize an insufficient address source', async () => {
      const rule = await add(threshold, 'address', 150_000, 699_999)
      const before = pool()
      const result = await run(rule)
      assert.equal(result.status, 'skipped')
      assert.equal(result.observedBalance, 700_000)
      assert.match(result.reason, /insufficient|not enough/i)
      assert.deepEqual(pool(), before)
      assert.ok(rpc('gettxout', threshold.eligible[0].txid, threshold.eligible[0].vout, true))
      await remove(rule)
      return result
    })
    await check('forward: strictly above wallet threshold sends from address and does not reserve the threshold', async () => {
      const rule = await add(threshold, 'address', 100_000, 699_999)
      await dryRun(rule, [threshold.eligible[0]], 700_000, 100_000, threshold.receive)
      const result = await run(rule)
      assertPlan(result, [threshold.eligible[0]], 700_000, 100_000, threshold.receive)
      await assertSent(rule, result)
      assert.ok(700_000 - result.amount - result.fee < rule.balanceAboveSats)
      assert.equal(result.change.amount, 120_000 - 100_000 - result.fee)
      await remove(rule)
      return result
    })

    await check('forward: min-conf counts exclude young receive/change outputs from eligible wallet balance', async () => {
      const f = await fixture('F-min-conf')
      const rule = await add(f, 'wallet', null, 0, ['--min-conf', '2'])
      const before = pool()
      const young = await run(rule)
      // Nothing clears min-conf yet, so even a zero threshold is not strictly exceeded.
      assert.equal(young.status, 'skipped')
      assert.equal(young.observedBalance, 0)
      assert.deepEqual(pool(), before)
      await h.mine()
      const result = await run(rule)
      assertPlan(result, f.eligible, 700_000, null, null)
      await assertSent(rule, result)
      assert.ok(rpc('gettxout', f.pending.txid, f.pending.vout, true))
      assert.ok(rpc('gettxout', f.frozen.txid, f.frozen.vout, true))
      await remove(rule)
      return result
    })

    for (const source of ['address', 'wallet']) {
      await check(`forward: ${source} fixed repeats on confirmed change and stops below wallet threshold`, async () => {
        const f = await fixture(`F-repeat-${source}`, undefined, false)
        // One source UTXO makes each subsequent cycle depend on the preceding confirmed change.
        if (source === 'wallet') {
          const sweep = await add(f, 'address')
          await assertSent(sweep, await run(sweep))
          await remove(sweep)
          // Leave a single eligible change-branch input for the wallet loop.
          const secondRule = (await cli(replace(addArgs(f, 'address'), '--from', f.second))).rule
          await assertSent(secondRule, await run(secondRule))
          await remove(secondRule)
        }
        let eligible = source === 'wallet' ? [f.eligible[2]] : [f.eligible[0]]
        let observed = source === 'wallet' ? 350_000 : 700_000
        const cycles = []
        const changes = new Set()
        // Address mode's threshold is wallet-wide; the other two funded addresses stay eligible.
        const limit = source === 'wallet' ? 60_000 : 600_000
        const repeated = await add(f, source, 50_000, limit)
        for (let cycle = 0; cycle < 8 && observed > limit; cycle++) {
          const addresses = (await cli(['addresses', '--wallet', f.name, ...chain])).addresses
          const unused = addresses.filter(a => a.change === 1 && a.chains.every(c => !c.used)).sort((a, b) => a.index - b.index)[0]
          assert.ok(unused, 'wallet discovery must include an unused change address')
          const expectedChange = source === 'address' ? f.receive : unused.address
          const result = await run(repeated)
          assertPlan(result, eligible, observed, 50_000, expectedChange)
          if (source === 'wallet') {
            assert.ok(!changes.has(result.change.address))
            assert.ok(rpc('deriveaddresses', (await cli(['wallet', 'descriptor', '--wallet', f.name, ...chain])).change, [0, 20]).includes(result.change.address))
          }
          changes.add(result.change.address)
          const node = await assertSent(repeated, result)
          cycles.push(result)
          const waiting = await run(repeated)
          assert.equal(waiting.status, 'skipped')
          assert.equal(waiting.observedBalance, source === 'wallet' ? 0 : 580_000)
          await h.mine()
          assert.ok(h.nodeTx(result.txid).confirmations > 0)
          observed -= result.amount + result.fee
          const changeOutput = node.vout.find(v => v.scriptPubKey.address === result.change.address)
          eligible = [{ txid: result.txid, vout: changeOutput.n, value: result.change.amount }]
          assert.equal((await cli(['balance', '--wallet', f.name, ...chain])).balances[0].confirmed, observed)
        }
        assert.ok(cycles.length >= 2)
        assert.ok(observed < limit)
        const before = pool()
        const stopped = await run(repeated)
        assert.equal(stopped.status, 'skipped')
        assert.equal(stopped.observedBalance, observed)
        assert.deepEqual(pool(), before)
        const history = (await show(repeated)).runs
        const sentHistory = history.filter(entry => entry.status === 'sent')
        assert.equal(sentHistory.length, cycles.length)
        assert.deepEqual(sentHistory.map(entry => entry.txid), cycles.map(entry => entry.txid).reverse())
        for (const entry of history.filter(entry => entry.status === 'skipped')) {
          assert.deepEqual(entry.inputs, [])
          assert.equal(entry.txid, null)
        }
        await remove(repeated)
        return { cycles, stopped }
      })
    }

    await check('forward: rejects invalid source/amount/threshold/chain and wallet-owned destinations without side effects', async () => {
      const f = await fixture('F-validation', undefined, false)
      const base = addArgs(f, 'wallet')
      const invalid = [
        base.filter(arg => arg !== '--from-wallet'),
        [...base, '--from', f.receive],
        ...['0', '-1', '1.5', '9007199254740992'].map(value => [...base, '--amount-sats', value]),
        ...['-1', '1.5', '9007199254740992'].map(value => [...base, '--balance-above-sats', value]),
        ...['xbt', 'tbtc4'].map(value => replace(base, '--chain', value)),
        ...[f.receive, f.second, f.changes[0], f.changes[3].toUpperCase()].map(value => replace(base, '--to', value)),
      ]
      const before = pool()
      const rules = (await cli(['forward', 'list'])).rules
      const cron = readFileSync(crontab, 'utf8')
      for (const args of invalid) {
        const error = await cli(args, false)
        assert.match(error, /from|amount|balance|chain|OP_RETURN|wallet|own/i)
        assert.deepEqual(pool(), before)
        assert.deepEqual((await cli(['forward', 'list'])).rules, rules)
        assert.equal(readFileSync(crontab, 'utf8'), cron)
      }
      return { rejected: invalid.length, mempoolUnchanged: true, rulesUnchanged: true }
    })

    await check('forward: encrypted dry-run never signs and distinct rules share a persistent wallet-chain lease', async () => {
      const passwordText = 'regtest-forward-password'
      const passwordFile = h.secret('forward-password.txt', passwordText)
      const f = await fixture('F-lease', passwordFile, false)
      const first = await add(f, 'address', 50_000)
      const second = (await cli(replace(addArgs(f, 'address', 50_000), '--from', f.second))).rule
      const walletRule = await add(f, 'wallet')
      await dryRun(first, [f.eligible[0]], 700_000, 50_000, f.receive)
      await dryRun(walletRule, f.eligible, 700_000, null, null)
      // Hold a real run at password-file I/O after planning, so overlap is deterministic without a mocked node.
      unlinkSync(passwordFile)
      const fifo = spawnSync('python3', ['-c', 'import os,sys; os.mkfifo(sys.argv[1], 0o600)', passwordFile], { encoding: 'utf8' })
      assert.equal(fifo.status, 0, fifo.stderr || fifo.error?.message)
      let writer, settled = false, running
      const pending = run(first)
      pending.then(() => { settled = true }, () => { settled = true })
      try {
        await h.wait('first forward run waiting for password', () => {
          if (settled) return true
          try { writer = openSync(passwordFile, constants.O_WRONLY | constants.O_NONBLOCK); return true }
          catch (error) { if (error.code !== 'ENXIO') throw error; return false }
        })
        assert.notEqual(writer, undefined, 'the first run must hold its lease while waiting to sign')
        const lease = db.prepare('SELECT owner,expiresAt FROM ForwardLease WHERE walletId=? AND chain=?').get(f.wallet.id, 'regtest')
        assert.ok(lease && new Date(lease.expiresAt).getTime() > Date.now())
        const before = pool()
        const busy = await Promise.all([run(second), run(walletRule)])
        for (const result of busy) assert.equal(result.status, 'busy')
        assert.deepEqual(pool(), before)
        assert.equal((await show(second)).runs.length, 0)
        assert.equal((await show(walletRule)).runs.length, 0)
        assert.equal(db.prepare('SELECT owner FROM ForwardLease WHERE walletId=? AND chain=?').get(f.wallet.id, 'regtest').owner, lease.owner)
      } finally {
        if (writer === undefined) writer = openSync(passwordFile, constants.O_RDWR | constants.O_NONBLOCK)
        writeSync(writer, passwordText)
        closeSync(writer)
        try { running = await pending } finally {
          unlinkSync(passwordFile)
          writeFileSync(passwordFile, passwordText, { mode: 0o600 })
        }
      }
      assertPlan(running, [f.eligible[0]], 700_000, 50_000, f.receive)
      await assertSent(first, running)
      // A different-address rule must be free to run once the first process releases the shared lease.
      const next = await run(second)
      assertPlan(next, [f.eligible[1]], 580_000, 50_000, f.second)
      await assertSent(second, next)
      for (const rule of [first, second, walletRule]) await remove(rule)
      return { first: running, second: next, distinctRulesWereBusy: true }
    })
    await check('forward: expanded rules leave no installed crontab blocks', async () => {
      assert.equal((await cli(['forward', 'list'])).rules.length, 0)
      assert.ok(!readFileSync(crontab, 'utf8').includes('# BEGIN gorila-forward'))
      return { rules: 0 }
    })
  } finally { db.close() }
}
