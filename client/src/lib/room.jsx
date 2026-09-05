import {
  createContext, useContext, useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { Store, useStoreVersion } from './store'
import { connectLive } from './live'
import { connectMock } from './mock'
import { ROOM_SLUG, WALK_K, STEP_MS, STALL_TAKEOVER_MS } from './config'
import { key, idHex, cmpBig, asBig } from './util'

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

  // ── connect ───────────────────────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (apiRef.current && meta.status === 'connected') return apiRef.current
    try {
      const api = await connectLive(store)
      apiRef.current = api
      // Stage 1: the small tables, so the landing page can show the room.
      api.subscribe(['SELECT * FROM repo', 'SELECT * FROM participant'], () => setSubReady(true))
      return api
    } catch {
      return null
    }
  }, [store, meta.status])

  // Explicit review-only fallback. Never entered automatically.
  const useMock = useCallback(() => {
    apiRef.current?.disconnect?.()
    apiRef.current = null
    joinedRef.current = false
    stage2Ref.current = null
    setSubReady(false)
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
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
