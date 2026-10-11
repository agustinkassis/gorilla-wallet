import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'

export async function harness() {
  const root = resolve(import.meta.dirname, '../..')
  const project = `gorila-regtest-${process.pid}-${Date.now()}`
  const directory = resolve(process.env.REGTEST_EVIDENCE_DIR || join(tmpdir(), project, 'evidence'))
  mkdirSync(directory, { recursive: true })
  const temporary = mkdtempSync(join(tmpdir(), `${project}-`))
  const env = { ...process.env, DATABASE_URL: `file:${join(temporary, 'wallet.db')}`, SEED_PHRASE: '', NODE_ENV: 'test' }
  const cases = [], invocations = [], requests = []
  let rpcUrl
  const composeArgs = ['compose', '-p', project, '-f', join(root, 'compose.regtest.yml')]
  const compose = (...args) => {
    const p = spawnSync('docker', [...composeArgs, ...args], { encoding: 'utf8', timeout: 120000 })
    assert.equal(p.status, 0, p.stderr || p.error?.message)
    return p.stdout.trim()
  }
  const rpc = (method, ...args) => {
    const response = spawnSync('curl', ['--silent', '--show-error', '--max-time', '15', '--user', 'user:pass', '--data', JSON.stringify({ jsonrpc: '1.0', id: 'regtest-suite', method, params: args }), rpcUrl], { encoding: 'utf8', timeout: 20000 })
    assert.equal(response.status, 0, response.stderr || response.error?.message)
    const body = JSON.parse(response.stdout)
    assert.equal(body.error, null, JSON.stringify(body.error))
    return body.result
  }
  const wait = async (label, predicate) => {
    const deadline = Date.now() + 60000
    let detail
    while (Date.now() < deadline) {
      try { if (await predicate()) return } catch (error) { detail = String(error) }
      await new Promise(done => setTimeout(done, 200))
    }
    throw new Error(`Timed out: ${label}: ${detail ?? ''}`)
  }
  const cli = async (args, success = true) => {
    const invocation = [process.execPath, join(root, 'bin/gorila.mjs'), ...args, '--json', ...(args.includes('--timeout') ? [] : ['--timeout', '20'])]
    const child = spawn(invocation[0], invocation.slice(1), { cwd: temporary, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 45000)
    const [code] = await once(child, 'close')
    clearTimeout(timer)
    const record = { invocation, code, stdout, stderr }
    const artifact = join(directory, `cli-${String(invocations.length + 1).padStart(4, '0')}.json`)
    writeFileSync(artifact, JSON.stringify(record, null, 2))
    invocations.push({ artifact, invocation, code })
    assert.equal(code, success ? 0 : 1, `${args.join(' ')}\n${stdout}\n${stderr}`)
    if (!success) { assert.equal(stdout, ''); return stderr }
    return JSON.parse(stdout)
  }
  const check = async (name, action) => {
    const start = invocations.length
    try {
      const observable = await action()
      cases.push({ name, status: 'passed', invocations: invocations.slice(start), observable: observable ?? true })
      console.log(`PASS ${cases.length}: ${name}`)
      return observable
    } catch (error) {
      cases.push({ name, status: 'failed', invocations: invocations.slice(start), error: String(error) })
      throw error
    } finally { writeFileSync(join(directory, 'cases.json'), JSON.stringify(cases, null, 2)) }
  }
  let proxy, electrumProxy
  let api, electrum, miningAddress, esplora, electrumUpstream
  const sockets = new Set()
  const faults = { httpUnavailable: false, feesUnavailable: false }
  const close = async () => {
    if (proxy) { proxy.closeAllConnections(); proxy.close() }
    for (const socket of sockets) socket.destroy()
    if (electrumProxy) electrumProxy.close()
    try {
      writeFileSync(join(directory, 'http.json'), JSON.stringify(requests, null, 2))
      writeFileSync(join(directory, 'containers.log'), compose('logs', '--no-color'))
    } finally {
      try { compose('down', '--volumes', '--remove-orphans') }
      finally { rmSync(temporary, { recursive: true, force: true }) }
    }
    writeFileSync(join(directory, 'cleanup.json'), JSON.stringify({ project, remaining: compose('ps', '-aq'), temporaryRemoved: true }))
  }
  const start = async () => {
    compose('up', '-d')
    rpcUrl = `http://${compose('port', 'bitcoind', '18443')}`
    await wait('Core RPC', () => rpc('getblockchaininfo').chain === 'regtest')
    rpc('createwallet', 'miner')
    miningAddress = rpc('getnewaddress')
    rpc('generatetoaddress', 101, miningAddress)
    esplora = `http://${compose('port', 'electrs', '3000')}`
    electrumUpstream = `tcp://${compose('port', 'electrs', '50001')}`
    await wait('Esplora initial tip', async () => Number(await (await fetch(`${esplora}/blocks/tip/height`)).text()) === 101)
    proxy = http.createServer(async (req, res) => {
      requests.push({ method: req.method, path: req.url })
      try {
        if (faults.httpUnavailable || (faults.feesUnavailable && req.url.endsWith('/fees/recommended'))) { res.writeHead(503); res.end('Injected transport outage'); return }
        if (req.url.endsWith('/fees/recommended')) {
          const info = rpc('getmempoolinfo')
          const minimum = Math.max(1, Math.ceil(Math.max(info.mempoolminfee, info.minrelaytxfee) * 100000))
          const estimates = [1, 3, 6, 12].map(target => rpc('estimatesmartfee', target))
          if (estimates.some(estimate => !estimate.feerate)) { res.writeHead(503); res.end('Core has no fee estimate'); return }
          const [fastestFee, halfHourFee, hourFee, economyFee] = estimates.map(estimate => Math.ceil(estimate.feerate * 100000))
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ fastestFee, halfHourFee, hourFee, economyFee, minimumFee: minimum })); return
        }
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const upstream = await fetch(esplora + req.url.replace(/^\/api/, ''), { method: req.method, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}), signal: AbortSignal.timeout(10000) })
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'text/plain' })
        res.end(await upstream.text())
      } catch (error) { res.writeHead(502); res.end(String(error)) }
    })
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
    api = `http://127.0.0.1:${proxy.address().port}`
    electrumProxy = net.createServer(socket => {
      const target = new URL(electrumUpstream)
      const upstream = net.connect({ host: target.hostname, port: Number(target.port) })
      for (const connection of [socket, upstream]) {
        sockets.add(connection)
        connection.on('close', () => sockets.delete(connection))
      }
      upstream.pipe(socket)
      upstream.on('error', () => socket.destroy())
      upstream.on('close', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      socket.on('close', () => upstream.destroy())
      let buffer = ''
      socket.on('data', chunk => {
        buffer += chunk.toString()
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          const request = JSON.parse(line)
          if (faults.feesUnavailable && request.method === 'blockchain.estimatefee') {
            socket.write(JSON.stringify({ id: request.id, error: { code: -32603, message: 'Injected fee source outage' } }) + '\n')
          } else upstream.write(line + '\n')
        }
      })
    })
    electrumProxy.listen(0, '127.0.0.1'); await once(electrumProxy, 'listening')
    electrum = `tcp://127.0.0.1:${electrumProxy.address().port}`
    writeFileSync(join(directory, 'environment.json'), JSON.stringify({ project, temporary, database: env.DATABASE_URL, electrum, api, esplora, node: process.version }, null, 2))
    await cli(['config', 'set', '--chain', 'regtest', '--electrum', electrum, '--mempool', api])
  }
  const indexed = async () => {
    const height = rpc('getblockcount')
    await wait('index height', async () => Number(await (await fetch(`${api}/api/blocks/tip/height`)).text()) === height)
  }
  const mine = async () => { const hashes = rpc('generatetoaddress', 1, miningAddress); await indexed(); return hashes[0] }
  const indexedTx = async txid => wait(`indexed transaction ${txid}`, async () => (await fetch(`${api}/api/tx/${txid}`)).ok)
  const rebuildIndexer = async () => {
    compose('rm', '--stop', '--force', '--volumes', 'electrs')
    compose('up', '-d', '--no-deps', 'electrs')
    esplora = `http://${compose('port', 'electrs', '3000')}`
    electrumUpstream = `tcp://${compose('port', 'electrs', '50001')}`
    await indexed()
  }
  const nodeTx = txid => rpc('getrawtransaction', txid, true)
  const secret = (name, text) => { const path = join(temporary, name); writeFileSync(path, text, { mode: 0o600 }); return path }
  return { root, directory, temporary, env, cases, cli, check, rpc, wait, start, close, mine, indexed, indexedTx, rebuildIndexer, nodeTx, secret, faults, get api() { return api }, get electrum() { return electrum } }
}
