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
 *   conn.procedures.<camelCaseName>({ ...namedParams }) -> Promise<Return>
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
      /**
       * Build the map for a GitHub repo, from the browser.
       *
       * `index_repo` is a PROCEDURE, not a reducer: it may do IO (it fetches
       * the repo's git tree from GitHub) and it RETURNS a status string, which
       * is the whole reason a browser can drive it honestly. Roughly 3.4s for
       * any repo size -- django/django is 7,087 blobs and lands in under four
       * seconds -- because the work happens inside the database, not here.
       *
       * Preferred over the websocket the page already has open, so there is no
       * cross-origin request to be blocked. `indexRepoOverHttp` is the fallback
       * for a page that is not connected.
       */
      indexRepo: (owner, repo) => {
        const fn = conn?.procedures?.indexRepo || conn?.procedures?.index_repo
        if (typeof fn !== 'function') return indexRepoOverHttp(owner, repo)
        return fn.call(conn.procedures, { owner, repo, githubToken: '' })
      },
      /**
       * Deepen an existing map: real import edges, and a real size for every
       * block. Separate from `indexRepo` on purpose — indexing reads the file
       * TREE and is instant, this reads the file CONTENTS and is not, and
       * nobody who pastes a 3,000-file repo should pay for that unasked.
       *
       * Resumable: `offset` walks the repo's file nodes in id order, so the
       * caller drives batches and can stop whenever it likes. `apiKey` is
       * optional — with '' the regex half still runs, which is the half that
       * writes the import edges and the block heights.
       */
      enrichRepo: (repoId, offset, limit, apiKey) => {
        const fn = conn?.procedures?.enrichRepo || conn?.procedures?.enrich_repo
        if (typeof fn !== 'function') {
          return Promise.reject(new Error('enrich_repo is not published on this module'))
        }
        return fn.call(conn.procedures, {
          repoId,
          offset: Number(offset) || 0,
          limit: Number(limit) || 20,
          apiKey: apiKey || '',
        })
      },
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


/** `wss://host` -> `https://host`. The two endpoints are the same host. */
function httpBase() {
  return String(STDB_URI).replace(/^ws/, 'http').replace(/\/+$/, '')
}

/**
 * The same procedure over plain HTTP, for a page with no live connection.
 *
 * Verified working unauthenticated against the deployed module: a POST of the
 * positional argument array to /v1/database/<db>/call/<procedure> returns the
 * procedure's return value as a JSON string.
 */
export async function indexRepoOverHttp(owner, repo) {
  const url = `${httpBase()}/v1/database/${STDB_MODULE}/call/index_repo`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([owner, repo, '']),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`the database refused the request (HTTP ${res.status})`)
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'string' ? parsed : text
  } catch {
    return text
  }
}

/**
 * The same procedure over the websocket, on a connection opened just for it.
 *
 * The websocket cannot be refused by a cross-origin policy, so this is what
 * catches the one failure mode the HTTP path has that the app itself does not.
 */
export function indexRepoOverSocket(owner, repo) {
  return new Promise((resolve, reject) => {
    let conn = null
    let settled = false
    const done = (fn, arg) => {
      if (settled) return
      settled = true
      try { conn?.disconnect?.() } catch { /* noop */ }
      fn(arg)
    }
    let token
    try { token = localStorage.getItem('map-room-token') || undefined } catch { token = undefined }
    try {
      conn = DbConnection.builder()
        .withUri(STDB_URI)
        .withDatabaseName(STDB_MODULE)
        .withToken(token)
        .onConnect((connection) => {
          const fn = connection?.procedures?.indexRepo || connection?.procedures?.index_repo
          if (typeof fn !== 'function') {
            done(reject, new Error('index_repo is not published on this module'))
            return
          }
          fn.call(connection.procedures, { owner, repo, githubToken: '' })
            .then((out) => done(resolve, String(out)))
            .catch((e) => done(reject, e instanceof Error ? e : new Error(String(e))))
        })
        .onConnectError((_c, err) => done(reject, new Error(err?.message || 'could not reach the database')))
        .build()
    } catch (e) {
      done(reject, e instanceof Error ? e : new Error(String(e)))
    }
    setTimeout(() => done(reject, new Error('the database did not answer in 30 seconds')), 30000)
  })
}

/**
 * Build the map for a GitHub repo. The one entry point the funnel calls.
 *
 * HTTP first because it needs no second socket, then the websocket, which
 * cannot be blocked cross-origin. Only a NETWORK-level failure falls through:
 * a 4xx/5xx from the database is a real answer and is reported as one, never
 * retried into a different-looking error.
 */
export async function indexRepo(owner, repo) {
  try {
    return await indexRepoOverHttp(owner, repo)
  } catch (e) {
    if (e instanceof TypeError) return indexRepoOverSocket(owner, repo)
    throw e
  }
}

/**
 * `enrich_repo` over plain HTTP, for a page that never opens a socket.
 *
 * Positional argument array, exactly as CONTRACT-V2 records: u64/u32 args are
 * JSON NUMBERS, not strings. Returns the procedure's own progress line.
 */
export async function enrichRepoOverHttp(repoId, offset, limit, apiKey) {
  const url = `${httpBase()}/v1/database/${STDB_MODULE}/call/enrich_repo`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([Number(repoId), Number(offset) || 0, Number(limit) || 20, apiKey || '']),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`the database refused the request (HTTP ${res.status})`)
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'string' ? parsed : text
  } catch {
    return text
  }
}

/**
 * Parse `ok offset=0 done=20 total=70 …` into something a progress bar can use.
 * A line that does not start `ok` is an error the caller has to show, not hide.
 */
export function parseEnrich(line) {
  const s = String(line || '')
  if (!s.startsWith('ok ')) return { ok: false, error: s || 'no answer' }
  const out = { ok: true, raw: s }
  for (const part of s.split(/\s+/)) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i)
    const v = part.slice(i + 1)
    const n = Number(v.replace('%', ''))
    out[k] = Number.isFinite(n) && v !== '' ? n : v
  }
  return out
}

/**
 * A live feed of every repo on the map and every agent working on one.
 *
 * The room's own subscription is scoped to ONE repo, because that is all a map
 * needs. The gallery is the opposite: it needs one row per repo and the agent
 * rows for all of them, and it needs them to move without a refresh — a repo
 * someone indexes in another tab has to appear, and an agent going offline has
 * to go dark. So it opens its own short-lived connection rather than widening
 * the room's.
 *
 * Both tables are small (one row per repo; one row per session per actor), and
 * the connection is closed the moment the gallery unmounts — every route out of
 * the funnel is a real navigation, so it never overlaps with the map's.
 *
 * `onChange({ repos, sessions })` fires on every applied change. Returns a
 * dispose function.
 */
export function watchDirectory(onChange) {
  let conn = null
  let dead = false
  const repos = new Map()
  const sessions = new Map()

  const emit = () => {
    if (dead) return
    onChange({ repos: [...repos.values()], sessions: [...sessions.values()] })
  }

  const bind = (handle, store, keyOf) => {
    if (!handle) return
    handle.onInsert?.((_c, row) => { store.set(keyOf(row), row); emit() })
    handle.onUpdate?.((_c, _o, row) => { store.set(keyOf(row), row); emit() })
    handle.onDelete?.((_c, row) => { store.delete(keyOf(row)); emit() })
  }

  let token
  try { token = localStorage.getItem('map-room-token') || undefined } catch { token = undefined }

  try {
    conn = DbConnection.builder()
      .withUri(STDB_URI)
      .withDatabaseName(STDB_MODULE)
      .withToken(token)
      .onConnect((connection, _identity, tok) => {
        if (dead) { try { connection.disconnect() } catch { /* noop */ } ; return }
        try { if (tok) localStorage.setItem('map-room-token', tok) } catch { /* private mode */ }
        bind(connection.db?.repo, repos, (r) => String(r.id))
        bind(
          connection.db?.agentSession || connection.db?.agent_session,
          sessions,
          (r) => String(r.id)
        )
        connection.subscriptionBuilder()
          .onApplied(() => emit())
          .onError(() => emit())
          .subscribe(['SELECT * FROM repo', 'SELECT * FROM agent_session'])
      })
      .onConnectError(() => emit())
      .build()
  } catch {
    emit()
  }

  return () => {
    dead = true
    try { conn?.disconnect?.() } catch { /* noop */ }
  }
}
