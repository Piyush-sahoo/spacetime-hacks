import {
  createContext, useContext, useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { Store, useStoreVersion } from './store'
import { connectLive } from './live'
import { connectMock } from './mock'
import { ROOM_SLUG, WALK_K, STEP_MS, STALL_TAKEOVER_MS } from './config'
import { key, idHex, cmpBig, asBig, tsMs } from './util'
import { buildTerritory, NEW_LAND_KIND } from './territory'
import { buildAtlas } from './iso'
import { routesFor, timelineOf } from './route'
import { assignSlots, splitSession, OTHER_SLOT, NEUTRAL_SLOT, slotColor } from './actors'

// How recently an agent_session must have reported to count as working now.
// `agent_session.online` is set true by report_touch and nothing ever sets it
// false, so recency is the only honest liveness signal the client has.
const AGENT_LIVE_MS = 120000

// The activity feed is the liveness proof, so it must not look stalled while a
// busy agent works. Keep a real tape, not a ticker.
const TAPE = 600

// `?session=<uuid>` narrows the room to ONE run's route. Subagents of that run
// share the uuid and are kept.
const QUERY_SESSION =
  (typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('session')
    : null) || null

const Ctx = createContext(null)
export const useRoom = () => useContext(Ctx)

export function RoomProvider({ children }) {
  const storeRef = useRef(null)
  if (!storeRef.current) storeRef.current = new Store()
  const store = storeRef.current

  useStoreVersion(store) // re-render on any table/meta change
  const meta = store.meta

  const apiRef = useRef(null)
  const [subReady, setSubReady] = useState(false)
  const [myName, setMyName] = useState('')
  const joinedRef = useRef(false)
  const stage2Ref = useRef(null)
  const stage3Ref = useRef(null)
  // 'unknown' -> 'absent' (module has no coverage tables yet) | 'connecting' | 'live'
  const [covState, setCovState] = useState('unknown')
  const [covError, setCovError] = useState(null)

  // ── connect ───────────────────────────────────────────────────────────────
  const connectingRef = useRef(null)
  const connect = useCallback(async () => {
    if (apiRef.current && meta.status === 'connected') return apiRef.current
    // React StrictMode mounts effects twice in dev; without this guard that is
    // two websockets, two participants and a double-speed walk driver.
    if (connectingRef.current) return connectingRef.current
    try {
      connectingRef.current = connectLive(store)
      const api = await connectingRef.current
      apiRef.current = api
      // Stage 1: the small tables, so the landing page can show the room.
      api.subscribe(['SELECT * FROM repo', 'SELECT * FROM participant'], () => setSubReady(true))
      return api
    } catch {
      return null
    } finally {
      connectingRef.current = null
    }
  }, [store, meta.status])

  // Explicit review-only fallback. Never entered automatically.
  const useMock = useCallback(() => {
    apiRef.current?.disconnect?.()
    apiRef.current = null
    joinedRef.current = false
    stage2Ref.current = null
    stage3Ref.current = null
    setSubReady(false)
    setCovState('connecting')
    const api = connectMock(store)
    apiRef.current = api
    api.subscribe([], () => setSubReady(true))
  }, [store])

  // Connect eagerly on mount so "Watch a live room" is instant when clicked.
  useEffect(() => {
    connect()
    return () => apiRef.current?.disconnect?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── the room's repo ───────────────────────────────────────────────────────
  const v = store.version
  const repos = useMemo(() => store.rows('repo'), [v, subReady]) // eslint-disable-line
  const repo = useMemo(() => {
    if (!repos.length) return null
    return (
      repos.find((r) => r.slug === ROOM_SLUG) ||
      repos.find((r) => key(r.id) === ROOM_SLUG) ||
      repos.find((r) => String(r.slug || '').startsWith(ROOM_SLUG)) ||
      repos.find((r) => r.status === 'ready') ||
      repos[0]
    )
  }, [repos])

  // Stage 2: the per-repo tables, once we know which repo. `edge` is never
  // subscribed — the walk is computed server-side.
  useEffect(() => {
    if (!repo || !apiRef.current) return
    const rid = key(repo.id)
    if (stage2Ref.current === rid) return
    stage2Ref.current = rid
    apiRef.current.subscribe([
      `SELECT * FROM node WHERE repo_id = ${rid}`,
      `SELECT * FROM edge WHERE repo_id = ${rid}`,
      `SELECT * FROM walk WHERE repo_id = ${rid}`,
      'SELECT * FROM frontier',
      'SELECT * FROM verdict',
    ])
  }, [repo])

  // Stage 3: the v2 coverage tables, in their OWN subscription. If the module
  // has not published them yet the handles are missing and we simply do not
  // ask — and if the server rejects the query anyway, the failure is contained
  // here instead of tearing down the walk's subscription.
  useEffect(() => {
    const api = apiRef.current
    if (!repo || !api) return
    const rid = key(repo.id)
    if (stage3Ref.current === rid) return
    if (!api.has?.('node_cov')) { setCovState('absent'); return }
    stage3Ref.current = rid
    setCovState('connecting')
    // `new_land` landed after the coverage tables did, so it is asked for only
    // when the deployed module actually has it — a query for a table that is
    // not there would take the whole coverage subscription down with it.
    const queries = [
      `SELECT * FROM node_cov WHERE repo_id = ${rid}`,
      `SELECT * FROM exploration_request WHERE repo_id = ${rid}`,
      `SELECT * FROM agent_session WHERE repo_id = ${rid}`,
      `SELECT * FROM touch WHERE repo_id = ${rid}`,
    ]
    if (api.has?.('new_land')) queries.push(`SELECT * FROM new_land WHERE repo_id = ${rid}`)
    api.subscribe(
      queries,
      () => setCovState('live'),
      (msg) => { stage3Ref.current = null; setCovState('absent'); setCovError(msg) }
    )
  }, [repo, subReady])

  const join = useCallback((name) => {
    setMyName(name)
    if (!apiRef.current || !repo) return
    joinedRef.current = true
    apiRef.current.joinRoom(name, asBig(repo.id))
  }, [repo])

  // If they hit the button before the repo row landed, join as soon as it does.
  useEffect(() => {
    if (myName && repo && apiRef.current && !joinedRef.current) join(myName)
  }, [myName, repo, join])

  // ── live selectors, all read out of the subscription mirror ───────────────
  const participants = useMemo(() => {
    const rid = repo ? key(repo.id) : null
    return store.rows('participant')
      .filter((p) => !rid || key(p.repoId) === rid)
      .sort((a, b) => (b.online === a.online ? String(a.name).localeCompare(String(b.name)) : b.online ? 1 : -1))
  }, [v, repo]) // eslint-disable-line

  // Nodes come in two kinds: the SURVEY (seeded or indexed, the ground the map
  // is cut from) and NEW LAND (minted by report_touch for a path the survey
  // does not hold). They are split here, once, because the survey's geometry
  // must be a pure function of the survey — a new parcel arriving must not be
  // able to change a single angle of it.
  const nodeSplit = useMemo(() => {
    const all = store.rows('node')
    const base = []
    for (const n of all) if (n.kind !== NEW_LAND_KIND) base.push(n)
    return { all, base }
  }, [v]) // eslint-disable-line
  const nodes = nodeSplit.all

  // ── coverage: the map ─────────────────────────────────────────────────────
  // The territory is derived from `node` alone, so the geography is fixed the
  // moment the graph loads. Coverage then only ever changes colour — nothing
  // reflows under the audience while the agent works.
  const territory = useMemo(() => buildTerritory(nodeSplit.base), [nodeSplit.base.length]) // eslint-disable-line

  const covRows = useMemo(() => store.rows('node_cov'), [v]) // eslint-disable-line

  // Every agent that has ever reported into this room, in the order the server
  // first saw it. Sorting by the autoInc row id — not by name, not by arrival
  // over the wire — is what makes the colour assignment identical in every tab.
  const sessionRows = useMemo(() => {
    const rid = repo ? key(repo.id) : null
    return store.rows('agent_session')
      .filter((a) => !rid || key(a.repoId) === rid)
      .sort((a, b) => cmpBig(a.id, b.id))
  }, [v, repo]) // eslint-disable-line

  // An `agent_session` row stays `online` until something flips it, and a
  // crashed or finished run never does. `tick` re-evaluates recency on a slow
  // interval so a room does not go on claiming a dozen agents are working.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10000)
    return () => clearInterval(t)
  }, [])

  /**
   * THE COLOUR GATE.
   *
   * Every hue in this product means "an agent is connected right now". These
   * are the only rows allowed to mint one. Everything downstream — the legend,
   * the route, the blocks, the activity feed — reads its colour through here,
   * so there is exactly one place a dead session could leak a colour from, and
   * it is closed.
   */
  const liveSessionRows = useMemo(() => {
    const now = Date.now()
    return sessionRows.filter((a) => !!a.online && now - tsMs(a.lastAt) < AGENT_LIVE_MS)
  }, [sessionRows, tick])

  const liveKeys = useMemo(
    () => new Set(liveSessionRows.map((a) => String(a.session || ''))),
    [liveSessionRows]
  )

  /** actor id -> colour slot. Slot 0 is the main agent and is never in here. */
  const actorSlots = useMemo(() => assignSlots(liveSessionRows), [liveSessionRows])

  /**
   * Composite session key -> colour slot, or NEUTRAL_SLOT.
   *
   * `node_cov.last_session` is a HISTORICAL row: it names whoever touched a
   * node last, hours ago or right now, indifferently. Painting straight from it
   * is what put full subagent colour on a repo with nothing connected. A key
   * that is not in `liveKeys` gets neutral ink, and the file still reads as
   * explored — because it is — just not as somebody's live position.
   */
  const slotOfSession = useCallback((composite) => {
    const k = String(composite || '')
    if (!k || !liveKeys.has(k)) return NEUTRAL_SLOT
    const { actor } = splitSession(k)
    if (!actor) return 0
    return actorSlots.get(actor) ?? OTHER_SLOT
  }, [actorSlots, liveKeys])

  /**
   * Per-file coverage rolled up from node_cov. `lit` is how many of a file's
   * nodes have been touched; `at` is the newest touch in it, which is what the
   * map uses to bloom a region the instant it lights; `slot` is WHICH AGENT
   * touched it last, which is what the map paints it in.
   */
  const coverage = useMemo(() => {
    const files = territory.files
    const lit = new Int32Array(files.length)
    const at = new Float64Array(files.length)
    const tool = new Array(files.length).fill('')
    const slot = new Int8Array(files.length).fill(NEUTRAL_SLOT)
    const slotByNode = new Map()
    const exploredIds = new Set()
    let exploredNodes = 0
    for (const c of covRows) {
      if (!c.explored) continue
      exploredNodes += 1
      const nid = key(c.nodeId)
      exploredIds.add(nid)
      const sl = slotOfSession(c.lastSession)
      slotByNode.set(nid, sl)
      const fi = territory.byNode.get(nid)
      if (fi === undefined) continue
      lit[fi] += 1
      const ms = tsMs(c.lastAt)
      if (ms > at[fi]) { at[fi] = ms; tool[fi] = c.lastTool || ''; slot[fi] = sl }
    }
    let exploredFiles = 0
    for (let i = 0; i < lit.length; i += 1) if (lit[i] > 0) exploredFiles += 1
    return {
      lit, at, tool, slot, slotByNode, exploredNodes, exploredFiles, exploredIds,
      totalNodes: territory.total,
      totalFiles: files.length,
      unresolved: covRows.length - exploredNodes,
    }
  }, [covRows, territory, slotOfSession])

  // The edge rows, with an identity that changes ONLY when the graph does.
  const edgeN = store.count('edge')
  const edges = useMemo(() => store.rows('edge'), [edgeN]) // eslint-disable-line

  /**
   * THE CITY. Cut once from the file list and never again.
   *
   * Memoised on the territory — that is, on the GRAPH — and on nothing else.
   * Not on coverage, not on touches, not on who is connected. A block's screen
   * position is therefore invariant under everything an agent can do, which is
   * the property the whole effect rests on: the ground does not move while the
   * audience is watching it light up.
   */
  const atlas = useMemo(() => buildAtlas(territory.files), [territory])

  // ── the route ─────────────────────────────────────────────────────────────
  // Not a set of lit files: the ORDER an agent walked them in, recovered from
  // the monotonic `touch.id` the server hands out.
  const touchRows = useMemo(() => store.rows('touch'), [v]) // eslint-disable-line
  const routes = useMemo(() => routesFor(touchRows, {
    repoId: repo ? key(repo.id) : null,
    session: QUERY_SESSION,
    slotOf: slotOfSession,
    colourOf: slotColor,
  }), [touchRows, repo, slotOfSession])

  /** Every step of every route in server order — the tape, and the scrub ruler. */
  const timeline = useMemo(() => timelineOf(routes), [routes])

  /**
   * Per-directory lit / dark counts — what the left index is an index OF.
   * Reads coverage, so it recomputes on a touch; touches no geometry.
   */
  const districtStats = useMemo(() => {
    const out = atlas.districts.map((d) => ({
      name: d.name, code: d.code, total: d.count, lit: 0, symbols: d.symbols,
      slot: NEUTRAL_SLOT, at: 0,
    }))
    atlas.districts.forEach((d, di) => {
      const o = out[di]
      for (const fi of d.files) {
        if (coverage.lit[fi] > 0) {
          o.lit += 1
          if (coverage.at[fi] > o.at) { o.at = coverage.at[fi]; o.slot = coverage.slot[fi] }
        }
      }
    })
    return out
  }, [atlas, coverage])

  // Newest first, ordered by the server's own autoInc rather than by a clock
  // nobody controls, so two tabs agree on the order down to the row.
  const touches = useMemo(() => [...timeline].reverse().slice(0, TAPE), [timeline])

  // ── the return path ───────────────────────────────────────────────────────
  // One request per file region: the newest row wins, so a region that was
  // asked for, claimed and finished reads as `done` rather than flickering.
  const requestRows = useMemo(() => store.rows('exploration_request'), [v]) // eslint-disable-line
  const requestsByFile = useMemo(() => {
    const m = new Map()
    for (const r of [...requestRows].sort((a, b) => cmpBig(a.id, b.id))) {
      const fi = territory.byNode.get(key(r.nodeId))
      if (fi === undefined) continue
      m.set(fi, r)
    }
    return m
  }, [requestRows, territory])

  const requests = useMemo(
    () => [...requestRows].sort((a, b) => cmpBig(b.id, a.id)),
    [requestRows]
  )

  // The rail shows a TREE, not a list: a main agent, and under it the subagents
  // that inherited its session. Both facts are read straight off the composite
  // key the module writes, so no extra table and no extra round trip.
  const agents = useMemo(() => {
    const now = Date.now()
    const rows = sessionRows.map((a) => {
      const { session, actor } = splitSession(a.session)
      const live = !!a.online && now - tsMs(a.lastAt) < AGENT_LIVE_MS
      const slot = live ? (actor ? (actorSlots.get(actor) ?? OTHER_SLOT) : 0) : NEUTRAL_SLOT
      return {
        ...a,
        live,
        actorId: actor,
        parentSession: session,
        slot,
        color: slotColor(slot),
        ms: tsMs(a.lastAt),
      }
    })
    // Group by the session every subagent shares with its parent, newest first,
    // and keep the parent at the head of its own group.
    const groups = new Map()
    for (const r of rows) {
      let g = groups.get(r.parentSession)
      if (!g) { g = { key: r.parentSession, ms: 0, live: false, rows: [] }; groups.set(r.parentSession, g) }
      g.rows.push(r)
      if (r.ms > g.ms) g.ms = r.ms
      if (r.live) g.live = true
    }
    const out = []
    for (const g of [...groups.values()].sort((a, b) => (b.live === a.live ? b.ms - a.ms : b.live ? 1 : -1))) {
      g.rows.sort((a, b) => (!a.actorId ? -1 : !b.actorId ? 1 : b.ms - a.ms))
      for (const r of g.rows) out.push(r)
    }
    return out
  }, [sessionRows, actorSlots, tick]) // eslint-disable-line

  /**
   * One entry per DISTINCT LIVE actor — what the legend reads.
   *
   * There used to be a `live.length ? live : agents.slice(0, 8)` fallback here
   * so the legend was "never empty while there is lit ground to explain". That
   * was the bug: it explained lit ground with agents who left hours ago, in
   * their colours. A legend with nothing in it is the correct drawing of a room
   * with nobody in it.
   */
  const actors = useMemo(() => {
    const seen = new Map()
    for (const a of agents) {
      if (!a.live) continue
      const e = seen.get(a.actorId)
      if (e) { e.touches += Number(a.touches || 0); continue }
      seen.set(a.actorId, {
        actorId: a.actorId, slot: a.slot, color: a.color,
        touches: Number(a.touches || 0), live: true, name: a.agentName,
      })
    }
    return [...seen.values()].sort((x, y) => (!x.actorId ? -1 : !y.actorId ? 1 : x.slot - y.slot))
  }, [agents])

  const requestExploration = useCallback((nodeId, note) => {
    if (!apiRef.current || !repo) return Promise.resolve()
    return Promise.resolve(apiRef.current.requestExploration?.(asBig(repo.id), asBig(nodeId), String(note || '')))
      .catch((e) => { setCovError(String(e?.message || e)); })
  }, [repo])

  // The walk runs along PREDECESSORS (edge.dst == current, collect edge.src),
  // so a symbol's caller count is exactly how much walk it will produce. A leaf
  // with no callers exhausts at hop 0 and makes for a dead demo; surfacing this
  // is what stops a judge clicking a dud.
  const callers = useMemo(() => {
    const m = new Map()
    for (const e of store.rows('edge')) {
      const k = key(e.dst)
      m.set(k, (m.get(k) || 0) + 1)
    }
    return m
  }, [v]) // eslint-disable-line

  const callerCount = useCallback((id) => callers.get(key(id)) || 0, [callers])

  // Predecessor map, same direction the server walks.
  const preds = useMemo(() => {
    const m = new Map()
    for (const e of store.rows('edge')) {
      const d = key(e.dst)
      let a = m.get(d)
      if (!a) { a = []; m.set(d, a) }
      a.push(key(e.src))
    }
    return m
  }, [v]) // eslint-disable-line

  // The one-click demo path. "Deepest" means most HOPS, not most nodes: the
  // highest-in-degree symbol in django is a test helper with 1000 direct
  // callers, which paints one enormous hop and then stops. Simulating the same
  // bounded backwards BFS locally lets us pick an origin that actually walks.
  const bestOrigin = useMemo(() => {
    if (!nodes.length || !preds.size) return null
    const cands = nodes
      .filter((n) => {
        const c = callers.get(key(n.id)) || 0
        return c >= 1 && c <= 40
      })
      .slice(0, 600)
    let best = null, bestScore = -1
    for (const n of cands) {
      let frontierSet = [key(n.id)]
      const seen = new Set(frontierSet)
      let hops = 0, total = 1
      for (let h = 0; h < WALK_K && frontierSet.length; h++) {
        const next = []
        for (const cur of frontierSet) {
          for (const src of preds.get(cur) || []) {
            if (seen.has(src)) continue
            seen.add(src)
            next.push(src)
          }
        }
        if (!next.length) break
        hops = h + 1
        total += next.length
        frontierSet = next
        if (total > 4000) break
      }
      // Reward depth hard, penalise a wall of nodes gently.
      const score = hops * 1000 - Math.min(total, 3000) / 10
      if (score > bestScore) { bestScore = score; best = n }
    }
    return best || nodes[0]
  }, [nodes, preds, callers])

  // The walk everyone is watching: newest walk row for this repo. Picked from
  // the SUBSCRIPTION, so a tab that clicked nothing lands on the same one.
  const walk = useMemo(() => {
    const rid = repo ? key(repo.id) : null
    const ws = store.rows('walk').filter((w) => !rid || key(w.repoId) === rid)
    if (!ws.length) return null
    return ws.sort((a, b) => cmpBig(a.id, b.id)).at(-1)
  }, [v, repo]) // eslint-disable-line

  const frontier = useMemo(() => {
    if (!walk) return []
    const wid = key(walk.id)
    return store.rows('frontier')
      .filter((f) => key(f.walkId) === wid)
      .sort((a, b) => (Number(a.hop) - Number(b.hop)) || cmpBig(a.id, b.id))
  }, [v, walk?.id]) // eslint-disable-line

  const verdict = useMemo(() => {
    if (!walk) return null
    const wid = key(walk.id)
    return store.rows('verdict').find((x) => key(x.walkId) === wid) || null
  }, [v, walk?.id]) // eslint-disable-line

  const nodeById = useCallback((id) => store.get('node', id), [v, store]) // eslint-disable-line

  // ── actions ───────────────────────────────────────────────────────────────
  const startWalk = useCallback((origin) => {
    if (!apiRef.current || !repo) return
    apiRef.current.setFocus?.(asBig(origin))
    apiRef.current.startWalk(asBig(repo.id), asBig(origin), WALK_K)
  }, [repo])

  // ── the driver ────────────────────────────────────────────────────────────
  // `walk.hop` is the last PAINTED hop and does not advance on the final step
  // (the step that finds nothing flips `done` instead). So the driver is a
  // plain interval that keeps calling step_walk until `done` — the reducer is a
  // safe no-op on a finished walk.
  //
  // Only the tab that started the walk drives. Every other tab just watches the
  // subscription. If the starter goes away mid-walk, the lowest-identity online
  // participant takes the wheel after a stall so the demo never freezes.
  const amDriver = !!(walk && meta.identity && idHex(walk.startedBy) === meta.identity)
  // A step that lands after the walk finished can flip `done` back to false on
  // the server, so a walk is terminal once EITHER `done` is set or its verdict
  // row exists. Without this the driver would step forever.
  const walkDone = !!walk && (!!walk.done || !!verdict)
  const progress = useRef({ walkId: null, hop: -1, changedAt: 0 })
  const [stalled, setStalled] = useState(false)

  useEffect(() => {
    const p = progress.current
    if (!walk) return
    const wid = key(walk.id)
    const hop = Number(walk.hop)
    if (p.walkId !== wid || p.hop !== hop) {
      p.walkId = wid; p.hop = hop; p.changedAt = Date.now()
      if (stalled) setStalled(false)
    }
  }, [v, walk, stalled]) // eslint-disable-line

  useEffect(() => {
    if (!walk || walkDone) return
    const t = setInterval(() => {
      setStalled(Date.now() - progress.current.changedAt > STALL_TAKEOVER_MS)
    }, 600)
    return () => clearInterval(t)
  }, [walk?.id, walkDone]) // eslint-disable-line

  const onlineHexes = useMemo(
    () => participants.filter((p) => p.online).map((p) => idHex(p.identity)).sort(),
    [participants]
  )
  const iAmLeader = onlineHexes.length > 0 && onlineHexes[0] === meta.identity
  const shouldDrive = !!walk && !walkDone && (amDriver || (stalled && iAmLeader))

  useEffect(() => {
    if (!shouldDrive || !apiRef.current || !walk) return
    const id = asBig(walk.id)
    const tick = () => apiRef.current?.stepWalk(id)
    const t = setInterval(tick, STEP_MS)
    const first = setTimeout(tick, 80)
    return () => { clearInterval(t); clearTimeout(first) }
  }, [shouldDrive, walk?.id]) // eslint-disable-line

  const value = {
    store, meta, subReady, repo, repos, participants, nodes, edges,
    walk, frontier, verdict, nodeById, myName,
    callerCount, bestOrigin, walkDone,
    join, startWalk, useMock, retry: connect,
    isMock: meta.mode === 'mock',
    amDriver,
    // v2 — the coverage loop
    territory, coverage, requests, requestsByFile, agents, actors, touches,
    // the atlas
    atlas, routes, timeline, districtStats, liveKeys,
    sessionFilter: QUERY_SESSION,
    requestExploration, covState, covError,
    canRequest: !!apiRef.current?.hasReducer?.('request_exploration'),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
