import {
  createContext, useContext, useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { Store, useStoreVersion } from './store'
import { connectLive } from './live'
import { connectMock } from './mock'
import { ROOM_SLUG, WALK_K, STEP_MS, STALL_TAKEOVER_MS } from './config'
import { key, idHex, cmpBig, asBig, tsMs } from './util'
import { buildTerritory } from './territory'

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
    setCovState('absent')
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
    api.subscribe(
      [
        `SELECT * FROM node_cov WHERE repo_id = ${rid}`,
        `SELECT * FROM exploration_request WHERE repo_id = ${rid}`,
        `SELECT * FROM agent_session WHERE repo_id = ${rid}`,
        `SELECT * FROM touch WHERE repo_id = ${rid}`,
      ],
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

  const nodes = useMemo(() => store.rows('node'), [v]) // eslint-disable-line

  // ── coverage: the map ─────────────────────────────────────────────────────
  // The territory is derived from `node` alone, so the geography is fixed the
  // moment the graph loads. Coverage then only ever changes colour — nothing
  // reflows under the audience while the agent works.
  const territory = useMemo(() => buildTerritory(nodes), [nodes.length]) // eslint-disable-line

  const covRows = useMemo(() => store.rows('node_cov'), [v]) // eslint-disable-line

  /**
   * Per-file coverage rolled up from node_cov. `lit` is how many of a file's
   * nodes have been touched; `at` is the newest touch in it, which is what the
   * map uses to bloom a region the instant it lights.
   */
  const coverage = useMemo(() => {
    const files = territory.files
    const lit = new Int32Array(files.length)
    const at = new Float64Array(files.length)
    const tool = new Array(files.length).fill('')
    let exploredNodes = 0
    for (const c of covRows) {
      if (!c.explored) continue
      exploredNodes += 1
      const fi = territory.byNode.get(key(c.nodeId))
      if (fi === undefined) continue
      lit[fi] += 1
      const ms = tsMs(c.lastAt)
      if (ms > at[fi]) { at[fi] = ms; tool[fi] = c.lastTool || '' }
    }
    let exploredFiles = 0
    for (let i = 0; i < lit.length; i += 1) if (lit[i] > 0) exploredFiles += 1
    return {
      lit, at, tool, exploredNodes, exploredFiles,
      totalNodes: territory.total,
      totalFiles: files.length,
      unresolved: covRows.length - exploredNodes,
    }
  }, [covRows, territory])

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

  const agents = useMemo(() => {
    const rid = repo ? key(repo.id) : null
    return store.rows('agent_session')
      .filter((a) => !rid || key(a.repoId) === rid)
      .sort((a, b) => (b.online === a.online ? tsMs(b.lastAt) - tsMs(a.lastAt) : b.online ? 1 : -1))
  }, [v, repo]) // eslint-disable-line

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
    store, meta, subReady, repo, repos, participants, nodes,
    walk, frontier, verdict, nodeById, myName,
    callerCount, bestOrigin, walkDone,
    join, startWalk, useMock, retry: connect,
    isMock: meta.mode === 'mock',
    amDriver,
    // v2 — the coverage loop
    territory, coverage, requests, requestsByFile, agents,
    requestExploration, covState, covError,
    canRequest: !!apiRef.current?.hasReducer?.('request_exploration'),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
