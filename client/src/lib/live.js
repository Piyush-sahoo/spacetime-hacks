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

        // Mirror every table we care about. `edge` is deliberately not
        // subscribed — the walk runs server-side, the client never needs edges.
        for (const t of TABLES) {
          if (t === 'edge') continue
          const handle = connection.db?.[t]
          if (!handle) continue
          handle.onInsert?.((_ctx, row) => store.upsert(t, row))
          handle.onUpdate?.((_ctx, _old, row) => store.upsert(t, row))
          handle.onDelete?.((_ctx, row) => store.remove(t, row))
        }

        store.setMeta({
          status: 'connected',
          mode: 'live',
          identity: idHex(identity),
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
      subscribe(queries, onApplied) {
        return conn
          .subscriptionBuilder()
          .onApplied(() => onApplied?.())
          .onError((ctx) => fail(ctx?.event?.message || 'subscription rejected'))
          .subscribe(queries)
      },
      joinRoom: (name, repoId) => conn.reducers.joinRoom({ name, repoId }).catch(fail),
      setFocus: (nodeId) => conn.reducers.setFocus({ nodeId }).catch(fail),
      startWalk: (repoId, origin, k) => conn.reducers.startWalk({ repoId, origin, k }).catch(fail),
      stepWalk: (walkId) => conn.reducers.stepWalk({ walkId }).catch(fail),
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
