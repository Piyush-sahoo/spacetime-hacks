import { DbConnection } from '../module_bindings'
import { TABLES } from './store'
import { STDB_URI, STDB_MODULE } from './config'
import { idHex } from './util'

/**
 * Wires a real SpacetimeDB connection into the Store.
 *
 * Generated bindings (spacetimedb 2.10.0) expose:
 *   DbConnection.builder().withUri().withDatabaseName().withToken().build()
 *   conn.db.<table>.onInsert/onUpdate/onDelete   (rows use camelCase fields)
 *   conn.reducers.<camelCaseName>({ ...namedParams }) -> Promise<void>
 *   conn.subscriptionBuilder().onApplied().onError().subscribe([sql, ...])
 * SQL text still uses the snake_case wire names (repo_id, walk_id, ...).
 */

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

// The generated accessor for a multi-word table has been spelled both
// `node_cov` and `nodeCov` across codegen versions. Ask for both rather than
// betting on one: a wrong guess here silently costs the whole coverage feed.
function handleFor(conn, table) {
  const db = conn?.db
  if (!db) return null
  return db[table] || db[camel(table)] || null
}

function reducerFor(conn, name) {
  const r = conn?.reducers
  if (!r) return null
  const fn = r[camel(name)] || r[name]
  return typeof fn === 'function' ? fn.bind(r) : null
}

export async function connectLive(store) {
  store.setMeta({ status: 'connecting', mode: 'live', error: null })

  return new Promise((resolve, reject) => {
    let settled = false
    let token
    try { token = localStorage.getItem('map-room-token') || undefined } catch { token = undefined }

    const conn = DbConnection.builder()
      .withUri(STDB_URI)
      .withDatabaseName(STDB_MODULE)
      .withToken(token)
      .onConnect((connection, identity, tok) => {
        try { if (tok) localStorage.setItem('map-room-token', tok) } catch { /* private mode */ }

        // Mirror every table the published module actually has. Tables it does
        // not define are skipped rather than fatal — the v2 coverage tables
        // land mid-hackathon and the walk must not care either way.
        const present = []
        for (const t of TABLES) {
          const handle = handleFor(connection, t)
          if (!handle) continue
          present.push(t)
          handle.onInsert?.((_ctx, row) => store.upsert(t, row))
          handle.onUpdate?.((_ctx, _old, row) => store.upsert(t, row))
          handle.onDelete?.((_ctx, row) => store.remove(t, row))
        }
        api.tables = new Set(present)

        store.setMeta({
          status: 'connected',
          mode: 'live',
          identity: idHex(identity),
          tables: present,
          error: null,
        })
        if (!settled) { settled = true; resolve(api) }
      })
      .onDisconnect(() => {
        store.setMeta({ status: 'offline', error: 'connection closed' })
      })
      .onConnectError((_ctx, err) => {
        const msg = err?.message || String(err || 'connection failed')
        store.setMeta({ status: 'error', error: msg })
        if (!settled) { settled = true; reject(new Error(msg)) }
      })
      .build()

    const fail = (e) => store.setMeta({ error: String(e?.message || e) })

    const api = {
      mode: 'live',
      conn,
      tables: new Set(),
      has: (t) => api.tables.has(t),
      hasReducer: (n) => !!reducerFor(conn, n),
      // `onFailed` keeps a rejected optional subscription (the v2 tables before
      // they are published) from painting a red error over a working room.
      subscribe(queries, onApplied, onFailed) {
        if (!queries?.length) { onApplied?.(); return null }
        return conn
          .subscriptionBuilder()
          .onApplied(() => onApplied?.())
          .onError((ctx) => {
            const msg = ctx?.event?.message || 'subscription rejected'
            if (onFailed) onFailed(msg)
            else fail(msg)
          })
          .subscribe(queries)
      },
      joinRoom: (name, repoId) => conn.reducers.joinRoom({ name, repoId }).catch(fail),
      setFocus: (nodeId) => conn.reducers.setFocus({ nodeId }).catch(fail),
      startWalk: (repoId, origin, k) => conn.reducers.startWalk({ repoId, origin, k }).catch(fail),
      stepWalk: (walkId) => conn.reducers.stepWalk({ walkId }).catch(fail),
      requestExploration: (repoId, nodeId, note) => {
        const fn = reducerFor(conn, 'request_exploration')
        if (!fn) return Promise.reject(new Error('request_exploration is not published yet'))
        return fn({ repoId, nodeId, note })
      },
      disconnect: () => { try { conn.disconnect() } catch { /* noop */ } },
    }

    // Never let the landing page hang on "connecting…".
    setTimeout(() => {
      if (!settled) {
        settled = true
        store.setMeta({ status: 'error', error: `no response from ${STDB_URI} / ${STDB_MODULE}` })
        reject(new Error('connect timeout'))
      }
    }, 12000)
  })
}
