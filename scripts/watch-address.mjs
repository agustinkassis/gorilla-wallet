import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { Agent, fetch, WebSocket } from 'undici'

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`)

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    mempool: { type: 'string' }, insecure: { type: 'boolean', default: false },
    interval: { type: 'string', default: '10' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('node scripts/watch-address.mjs ADDRESS --mempool URL [--insecure] [--interval SECONDS]\nCtrl+C detiene el monitor. No necesita wallet ni claves privadas.')
    return
  }
  if (positionals.length !== 1 || !/^[a-zA-Z0-9]{14,120}$/.test(positionals[0])) throw new Error('Indicá una única dirección válida')
  if (!values.mempool) throw new Error('--mempool URL es obligatorio')
  const base = new URL(values.mempool)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('--mempool debe ser una URL HTTP(S) sin credenciales, query ni fragmento')
  const interval = Number(values.interval)
  if (!Number.isInteger(interval) || interval < 1 || interval > 3600) throw new Error('--interval debe ser un entero de 1 a 3600 segundos')
  const address = positionals[0]
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`
  const wsUrl = new URL('api/v1/ws', base)
  wsUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  // A private dispatcher scopes the self-signed exception to this monitor, never the wallet.
  const agent = new Agent({ connect: { rejectUnauthorized: !values.insecure, timeout: 8000 } })
  const abort = new AbortController()
  const stop = () => abort.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  if (values.insecure) log(`ADVERTENCIA: certificado TLS sin verificar únicamente para ${base.origin}`)
  const seen = new Map()
  let initialized = false
  let mempoolEndpoint = true

  function transaction(tx, silent = false, removed = false) {
    if (!tx || typeof tx.txid !== 'string') return
    const previous = seen.get(tx.txid)
    if (removed) {
      if (previous?.active) { previous.active = false; log(`RETIRADA de mempool | txid: ${tx.txid}`) }
      return
    }
    const received = (tx.vout ?? []).filter((v) => v.scriptpubkey_address === address).reduce((sum, v) => sum + v.value, 0)
    const spent = (tx.vin ?? []).filter((v) => v.prevout?.scriptpubkey_address === address).reduce((sum, v) => sum + v.prevout.value, 0)
    if (!received && !spent) return
    // A buffered mempool event may be older than the REST confirmation obtained on reconnect.
    const confirmed = previous?.confirmed || tx.status?.confirmed === true
    seen.set(tx.txid, { confirmed, active: true, tx })
    if (silent) return
    if (!previous) {
      const net = received - spent
      log(`${net > 0 ? 'RECIBIDO +' : 'SALIDA '}${net} sats | txid: ${tx.txid}${confirmed ? ' | ya confirmada' : ''}`)
    } else if (confirmed && !previous.confirmed) {
      log(`CONFIRMADO | txid: ${tx.txid} | bloque: ${tx.status.block_height ?? '?'}`)
    } else if (!previous.active) {
      log(`REINGRESADA | txid: ${tx.txid}`)
    }
  }

  function message(raw) {
    let data
    try { data = JSON.parse(raw) } catch { log('Mensaje no JSON ignorado'); return }
    if (!data || typeof data !== 'object') return
    if (data.pong) log('PONG. Escuchando cambios…')
    for (const key of ['address-transactions', 'block-transactions', 'address-removed-transactions']) {
      if (Array.isArray(data[key])) for (const tx of data[key]) transaction(tx, false, key === 'address-removed-transactions')
    }
  }

  async function snapshot() {
    const present = new Set()
    for (const suffix of ['txs', 'txs/mempool']) {
      if (suffix === 'txs/mempool' && !mempoolEndpoint) continue
      const response = await fetch(new URL(`api/address/${address}/${suffix}`, base), {
        dispatcher: agent, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      })
      // Electrum-backed explorers may expose combined history but not Esplora's mempool-only route.
      if (suffix === 'txs/mempool' && response.status === 404) {
        await response.body?.cancel()
        mempoolEndpoint = false
        log('Endpoint mempool-only no disponible; usando historial combinado y WebSocket')
        continue
      }
      if (!response.ok) throw new Error(`Historial HTTP ${response.status}`)
      const txs = await response.json()
      if (!Array.isArray(txs)) throw new Error('Historial inválido')
      for (const tx of txs) { present.add(tx.txid); transaction(tx, !initialized) }
    }
    if (initialized) for (const [txid, entry] of seen) {
      if (!entry.active || entry.confirmed || present.has(txid)) continue
      // Absence from a paginated history is not proof of eviction; it may have confirmed while offline.
      try {
        const response = await fetch(new URL(`api/tx/${txid}/status`, base), {
          dispatcher: agent, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
        })
        if (response.status === 404) { await response.body?.cancel(); transaction(entry.tx, false, true) }
        else {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const status = await response.json()
          if (status.confirmed === true) transaction({ ...entry.tx, status })
        }
      } catch (error) {
        if (abort.signal.aborted) throw error
        log(`No se pudo reconciliar ${txid}: ${error.message}`)
      }
    }
    if (!initialized) { initialized = true; log(`BASE: ${seen.size} transacciones previas (no se anuncian como pagos nuevos)`) }
  }

  async function listen() {
    const socket = new WebSocket(wsUrl, { dispatcher: agent })
    const pending = []
    let ready = false
    let lastMessage = Date.now()
    let failure
    let finish
    const closed = new Promise((resolve) => { finish = resolve })
    const opened = new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('WebSocket falló (revisá red y certificado TLS)')), { once: true })
      socket.addEventListener('close', () => reject(new Error('WebSocket cerrado antes de conectar')), { once: true })
    })
    // Handle rejection even if a signal arrives before we await the handshake.
    opened.catch(() => {})
    const close = () => { socket.close(); finish() }
    socket.addEventListener('close', () => finish())
    socket.addEventListener('error', () => { failure = new Error('Error de WebSocket'); finish() })
    socket.addEventListener('message', (event) => {
      lastMessage = Date.now()
      if (ready) message(event.data)
      else pending.push(event.data)
    })
    abort.signal.addEventListener('abort', close, { once: true })
    const heartbeat = setInterval(() => {
      if (Date.now() - lastMessage > Math.max(30000, interval * 3000)) {
        failure = new Error('Sin respuesta del WebSocket'); close()
      } else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ action: 'ping' }))
    }, interval * 1000)
    try {
      await Promise.race([opened, closed.then(() => { throw new Error('Conexión cerrada') })])
      socket.send(JSON.stringify({ 'track-address': address }))
      // Subscribe before REST, buffering messages so events cannot fall into the startup gap.
      await snapshot()
      ready = true
      for (const raw of pending) message(raw)
      log(`CONECTADO ${wsUrl} | dirección: ${address}`)
      socket.send(JSON.stringify({ action: 'ping' }))
      await closed
      if (failure) throw failure
    } finally {
      clearInterval(heartbeat)
      abort.signal.removeEventListener('abort', close)
      socket.close()
    }
  }

  try {
    while (!abort.signal.aborted) {
      try { await listen() } catch (error) {
        if (!abort.signal.aborted) log(`ERROR: ${error.message}`)
      }
      if (!abort.signal.aborted) {
        log('DESCONECTADO. Reconectando en 2 segundos…')
        await delay(2000, undefined, { signal: abort.signal }).catch(() => {})
      }
    }
  } finally {
    await agent.destroy()
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    log('Monitor detenido')
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
