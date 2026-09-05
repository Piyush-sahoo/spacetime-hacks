import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Crosshair, GitBranch, Loader2, Minus, Play, Plus } from 'lucide-react'
import { useRoom } from '../lib/room.jsx'
import { key } from '../lib/util'
import { SLOT_RGB, MAIN_COLOR, actorShort, MAX_ACTOR_COLORS } from '../lib/actors'
import { buildEntries, buildLevel, pickScope, layoutLevel, cubicAt, short, CAP } from '../lib/dag'

/**
 * THE GRAPH — the repo as a layered node-link diagram.
 *
 * Circles are code, arrows are the edges between them, ranks flow left to
 * right the way `dot` draws a DAG. Colour is the only thing that ever moves:
 *
 *   hollow   — never touched
 *   ember    — the MAIN agent has been here
 *   lime / periwinkle / violet / magenta — a SUBAGENT has, one hue each
 *   cyan     — the backwards walk is on this hop
 *   amber    — a human asked the agent to go look
 *   dashed   — new ground: a file the graph never had
 *
 * Every colour comes from a subscription row. There is no optimistic local
 * state, which is why a second tab that clicked nothing paints the same graph.
 *
 * The geometry is computed from `node` + `edge` alone and memoised on them, so
 * a touch landing mid-demo cannot move a single circle. Canvas carries the
 * diagram; the DOM carries only furniture.
 */

const PULSE_MS = 55
const IGNITE_MS = 2000
const TAU = Math.PI * 2

const STATUS = {
  pending: { ring: '#ffd166', label: 'REQUESTED' },
  claimed: { ring: '#35d0ff', label: 'AGENT ON IT' },
  done: { ring: '#7ddb9a', label: 'REPORTED BACK' },
}

function useBox() {
  const ref = useRef(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      if (!w) return
      const h = w < 620
        ? Math.min(Math.max(w * 1.25, 420), 620)
        : Math.max(560, Math.min(w * 0.72, 860))
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, box]
}

const rgba = (r, g, b, a) => `rgba(${r},${g},${b},${a})`

function hopTint(h, maxH) {
  const t = maxH > 0 ? h / maxH : 0
  if (t < 0.25) return [53, 208, 255]
  if (t < 0.5) return [120, 220, 255]
  if (t < 0.75) return [186, 236, 255]
  return [250, 249, 246]
}

export default function Graph() {
  const {
    nodes, edges, coverage, requests, requestExploration, canRequest,
    covState, covError, startWalk, isMock, walk, frontier, walkDone, nodeById, actors,
  } = useRoom()

  const [wrapRef, box] = useBox()
  const canvasRef = useRef(null)
  const cam = useRef({ x: 0, y: 0, k: 1, fitted: '' })
  const tween = useRef(null)
  const dirty = useRef(true)
  const pointers = useRef(new Map())
  const pinch = useRef(null)
  const dragging = useRef(false)
  const lastPan = useRef({ x: 0, y: 0 })
  const hoverRef = useRef(null)
  const ignite = useRef(new Map())
  const reduceMotion = useRef(false)
  const [hover, setHover] = useState(null)
  const [picked, setPicked] = useState(null)
  const [flash, setFlash] = useState(null)
  const [prefix, setPrefix] = useState([])

  // ── the wake ──────────────────────────────────────────────────────────────
  // A diagram nobody is touching and nothing is animating must cost the machine
  // NOTHING. The draw loop is not a loop: `frame` re-arms itself only while a
  // tween, an ignition or an open request is still moving, and otherwise lets
  // the chain end. Anything that changes what should be on screen — a
  // subscription row, a pan, a zoom, a hover — calls `wake()`.
  const rafRef = useRef(0)
  const paintRef = useRef(null)
  const wake = useCallback(() => {
    dirty.current = true
    if (rafRef.current === 0 && paintRef.current) {
      rafRef.current = requestAnimationFrame(paintRef.current)
    }
  }, [])

  useEffect(() => {
    reduceMotion.current = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  }, [])

  // ── the model: node + edge only ───────────────────────────────────────────
  const nodeN = nodes.length
  const edgeN = edges.length
  const entries = useMemo(() => buildEntries(nodes), [nodeN]) // eslint-disable-line
  const prefixKey = prefix.join('.')
  const scope = useMemo(() => pickScope(entries, prefix), [entries, prefixKey]) // eslint-disable-line
  const level = useMemo(
    () => buildLevel(entries, edges, scope),
    [entries, edgeN, scope] // eslint-disable-line
  )
  // THE ONE INVARIANT: geometry is memoised on the graph, never on coverage.
  const geo = useMemo(() => layoutLevel(level), [level])

  // ── live state, per item ──────────────────────────────────────────────────
  const hopByNode = useMemo(() => {
    const m = new Map()
    for (const f of frontier) m.set(key(f.nodeId), Number(f.hop))
    return m
  }, [frontier])
  const maxHop = walk ? Number(walk.hop) : 0

  const paint = useMemo(() => {
    const n = level.items.length
    const lit = new Int32Array(n)
    const slot = new Int8Array(n)
    const hop = new Int32Array(n).fill(-1)
    const req = new Array(n).fill(null)
    const votes = new Int32Array(SLOT_RGB.length)
    for (let i = 0; i < n; i += 1) {
      const it = level.items[i]
      votes.fill(0)
      let best = 0
      for (const id of it.ids) {
        if (coverage.exploredIds.has(id)) {
          lit[i] += 1
          votes[coverage.slotByNode.get(id) ?? 0] += 1
        }
        const h = hopByNode.get(id)
        if (h !== undefined && (hop[i] < 0 || h < hop[i])) hop[i] = h
      }
      for (let s = 1; s < SLOT_RGB.length; s += 1) if (votes[s] > votes[best]) best = s
      slot[i] = best
    }
    for (const r of requests) {
      const it = level.itemOfNode.get(key(r.nodeId))
      if (it) req[it.i] = r
    }
    let litItems = 0
    for (let i = 0; i < n; i += 1) if (lit[i] > 0) litItems += 1
    return { lit, slot, hop, req, litItems }
  }, [level, coverage, hopByNode, requests])

  // ── ignition ──────────────────────────────────────────────────────────────
  // An item that has just lit records the moment it did; the painter reads that
  // as a decaying envelope so the circle flares and settles on its own.
  const prevLit = useRef(null)
  useEffect(() => {
    const cur = paint.lit
    const prev = prevLit.current
    prevLit.current = cur
    if (!prev || prev.length !== cur.length) return
    const now = performance.now()
    for (let i = 0; i < cur.length; i += 1) {
      if (cur[i] > 0 && prev[i] === 0) { ignite.current.set(i, now); wake() }
    }
  }, [paint, wake])

  // ── camera ────────────────────────────────────────────────────────────────
  const fitK = useCallback(() => {
    if (!box.w || !geo.w) return 1
    return Math.min(box.w / geo.w, box.h / geo.h) * 0.95
  }, [box, geo])

  const zoomLimits = useCallback(() => {
    const f = fitK()
    return [f / 3.2, Math.max(f * 8, 3.2)]
  }, [fitK])

  const clamp = useCallback((x, y, k) => {
    if (!box.w) return [x, y]
    const halfW = box.w / (2 * k)
    const halfH = box.h / (2 * k)
    const mx = Math.max(geo.w / 2, halfW)
    const my = Math.max(geo.h / 2, halfH)
    return [
      Math.min(Math.max(x, geo.cx - mx), geo.cx + mx),
      Math.min(Math.max(y, geo.cy - my), geo.cy + my),
    ]
  }, [box, geo])

  const goTo = useCallback((x, y, k, animate = true) => {
    const c = cam.current
    const [cx, cy] = clamp(x, y, k)
    if (!animate || reduceMotion.current) {
      c.x = cx; c.y = cy; c.k = k
      tween.current = null
    } else {
      tween.current = { x0: c.x, y0: c.y, k0: c.k, x1: cx, y1: cy, k1: k, t0: performance.now(), dur: 520 }
    }
    wake()
  }, [clamp, wake])

  const fit = useCallback((animate) => { goTo(geo.cx, geo.cy, fitK(), animate) }, [geo, fitK, goTo])

  // Fit once per (scope, box) — never on a coverage tick.
  const fitTag = `${prefixKey}|${box.w}x${box.h}|${geo.w.toFixed(0)}`
  useEffect(() => {
    if (!box.w || !geo.nodes.length) return
    if (cam.current.fitted === fitTag) return
    cam.current.fitted = fitTag
    fit(false)
  }, [fitTag, box, geo, fit])

  useEffect(() => { wake() }, [box, paint, picked, wake])

  const openReqs = useMemo(() => requests.filter((r) => r.status !== 'done').length, [requests])
  const walkLive = !!walk && !walkDone

  const screenToWorld = useCallback((sx, sy) => {
    const c = cam.current
    return { x: c.x + (sx - box.w / 2) / c.k, y: c.y + (sy - box.h / 2) / c.k }
  }, [box])

  const zoomAt = useCallback((sx, sy, factor) => {
    const c = cam.current
    const [minK, maxK] = zoomLimits()
    const nk = Math.min(maxK, Math.max(minK, c.k * factor))
    if (nk === c.k) return
    const wx = c.x + (sx - box.w / 2) / c.k
    const wy = c.y + (sy - box.h / 2) / c.k
    c.k = nk
    const [nx, ny] = clamp(wx - (sx - box.w / 2) / nk, wy - (sy - box.h / 2) / nk, nk)
    c.x = nx; c.y = ny
    tween.current = null
    wake()
  }, [box, zoomLimits, clamp, wake])

  const zoomCentre = useCallback((factor) => {
    const c = cam.current
    const [minK, maxK] = zoomLimits()
    goTo(c.x, c.y, Math.min(maxK, Math.max(minK, c.k * factor)))
  }, [zoomLimits, goTo])

  const panBy = useCallback((dx, dy) => {
    const c = cam.current
    const [x, y] = clamp(c.x - dx / c.k, c.y - dy / c.k, c.k)
    c.x = x; c.y = y
    wake()
  }, [clamp, wake])

  // ── hit test ──────────────────────────────────────────────────────────────
  const hitAt = useCallback((sx, sy) => {
    const { x, y } = screenToWorld(sx, sy)
    const r = Math.max(geo.R + 3, 15 / cam.current.k)
    let best = -1
    let bestD = r * r
    for (const nd of geo.nodes) {
      if (!nd) continue
      const d = (nd.x - x) ** 2 + (nd.y - y) ** 2
      if (d < bestD) { bestD = d; best = nd.i }
    }
    return best
  }, [geo, screenToWorld])

  const onPick = useCallback((i) => {
    const it = level.items[i]
    if (!it) return
    setPicked(i)
    const isLeaf = it.count <= 1
    if (!isLeaf) {
      // A directory (or a file holding several symbols) descends.
      setPrefix(level.full ? prefix : it.key.split('.'))
      setPicked(null)
      return
    }
    if (paint.lit[i] > 0 || !canRequest) return
    const existing = paint.req[i]
    if (existing && existing.status !== 'done') return
    requestExploration(it.pick, it.path)
    setFlash(it.path)
    setTimeout(() => setFlash((p) => (p === it.path ? null : p)), 3200)
  }, [level, paint, canRequest, requestExploration, prefix])

  // ── pointer / wheel / pinch ───────────────────────────────────────────────
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return

    const onWheel = (e) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.010 : 0.0022))
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.min(3, Math.max(0.33, f)))
    }
    const onDown = (e) => {
      el.setPointerCapture?.(e.pointerId)
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      tween.current = null
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()]
        pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: cam.current.k }
        dragging.current = false
      } else {
        dragging.current = false
        lastPan.current = { x: e.clientX, y: e.clientY }
      }
    }
    const onMove = (e) => {
      if (pointers.current.has(e.pointerId)) {
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      }
      if (pointers.current.size === 2 && pinch.current) {
        const [a, b] = [...pointers.current.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const rect = el.getBoundingClientRect()
        const cx = (a.x + b.x) / 2 - rect.left
        const cy = (a.y + b.y) / 2 - rect.top
        zoomAt(cx, cy, (pinch.current.k * (dist / (pinch.current.dist || dist))) / cam.current.k)
        return
      }
      if (pointers.current.size === 1 && (e.buttons === 1 || e.pointerType === 'touch')) {
        const dx = e.clientX - lastPan.current.x
        const dy = e.clientY - lastPan.current.y
        if (Math.hypot(dx, dy) > 3) dragging.current = true
        panBy(dx, dy)
        lastPan.current = { x: e.clientX, y: e.clientY }
        return
      }
      const rect = el.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const i = hitAt(sx, sy)
      const next = i >= 0 ? { i, sx, sy } : null
      const same = (hoverRef.current?.i ?? -1) === (next?.i ?? -1)
      hoverRef.current = next
      if (!same) wake()
      setHover(next)
    }
    const onUp = (e) => {
      const wasDrag = dragging.current
      pointers.current.delete(e.pointerId)
      if (pointers.current.size < 2) pinch.current = null
      if (e.button === 0 && !wasDrag && pointers.current.size === 0) {
        const rect = el.getBoundingClientRect()
        const i = hitAt(e.clientX - rect.left, e.clientY - rect.top)
        if (i >= 0) onPick(i)
      }
      dragging.current = false
    }
    const onLeave = () => { hoverRef.current = null; setHover(null); wake() }
    const onDbl = (e) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const c = cam.current
      const [minK, maxK] = zoomLimits()
      const nk = Math.min(maxK, c.k * 2.2)
      const wx = c.x + (sx - box.w / 2) / c.k
      const wy = c.y + (sy - box.h / 2) / c.k
      goTo(wx - (sx - box.w / 2) / nk, wy - (sy - box.h / 2) / nk, Math.max(minK, nk))
    }

    el.addEventListener('dblclick', onDbl)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('pointerleave', onLeave)
    return () => {
      el.removeEventListener('dblclick', onDbl)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('pointerleave', onLeave)
    }
  }, [hitAt, onPick, zoomAt, panBy, goTo, zoomLimits, box])

  // ── draw loop ─────────────────────────────────────────────────────────────
  const stats = useRef({ frames: 0, ms: 0, max: 0, ticks: 0 })
  const animRef = useRef(false)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !box.w) return
    const ctx = canvas.getContext('2d', { alpha: false })
    let lastPulse = 0
    animRef.current = openReqs > 0 || walkLive

    const frame = (now) => {
      rafRef.current = 0
      stats.current.ticks += 1
      const c = cam.current
      const tw = tween.current
      if (tw) {
        const t = Math.min(1, (now - tw.t0) / tw.dur)
        const e = 1 - (1 - t) ** 3
        c.x = tw.x0 + (tw.x1 - tw.x0) * e
        c.y = tw.y0 + (tw.y1 - tw.y0) * e
        c.k = Math.exp(Math.log(tw.k0) + (Math.log(tw.k1) - Math.log(tw.k0)) * e)
        if (t >= 1) tween.current = null
        dirty.current = true
      }

      let igniting = false
      if (ignite.current.size) {
        for (const [i, t0] of ignite.current) {
          if (now - t0 > IGNITE_MS) { ignite.current.delete(i); dirty.current = true }
        }
        igniting = ignite.current.size > 0
      }
      const wantPulse = !reduceMotion.current && (openReqs > 0 || walkLive)
      let pulsing = wantPulse && animRef.current
      const pulseDue = pulsing && now - lastPulse >= PULSE_MS

      if (dirty.current || igniting || pulseDue) {
        dirty.current = false
        if (pulsing) lastPulse = now
        const t0 = performance.now()
        animRef.current = !!drawGraph(ctx, {
          geo, level, paint, box, cam: c, maxHop, walkLive,
          ignite: ignite.current, hover: hoverRef.current, picked, now,
          reduce: reduceMotion.current,
        })
        pulsing = wantPulse && animRef.current
        const dt = performance.now() - t0
        stats.current.frames += 1
        stats.current.ms += dt
        if (dt > stats.current.max) stats.current.max = dt
      }
      if (tween.current || igniting || pulsing) {
        rafRef.current = requestAnimationFrame(frame)
      }
    }

    paintRef.current = frame
    dirty.current = true
    if (rafRef.current === 0) rafRef.current = requestAnimationFrame(frame)
    if (typeof window !== 'undefined') {
      window.__graph = {
        stats: stats.current, cam,
        idle: () => rafRef.current === 0,
        // Verification surface. `probe` answers "did the ground move" for a
        // named item, in world AND screen space.
        probe: (label) => {
          const i = level.items.findIndex((it) => it.label === label || it.key === label || it.path === label)
          if (i < 0) return null
          const nd = geo.nodes[i]
          const c = cam.current
          return {
            label: level.items[i].label, key: level.items[i].key, i,
            x: nd.x, y: nd.y, rank: nd.rank,
            sx: (nd.x - c.x) * c.k + box.w / 2,
            sy: (nd.y - c.y) * c.k + box.h / 2,
            lit: paint.lit[i], slot: paint.slot[i],
            n: level.items.length, edges: geo.edges.length, w: geo.w, h: geo.h,
          }
        },
        all: () => level.items.map((it, i) => ({
          key: it.key, label: it.label, kind: it.kind, count: it.count,
          x: geo.nodes[i]?.x, y: geo.nodes[i]?.y, rank: geo.nodes[i]?.rank, lit: paint.lit[i],
        })),
        who: () => (actors || []).map((a) => ({ actor: a.actorId, slot: a.slot, color: a.color, live: a.live })),
        diag: () => ({
          parked: rafRef.current === 0, animated: animRef.current, openReqs,
          items: level.items.length, links: geo.edges.length, ranks: geo.ranks,
          scope: level.full ? 'full' : `depth ${level.depth}`, prefix: level.prefix.join('/'),
          k: cam.current.k, fitK: fitK(), w: geo.w, h: geo.h, box,
          avgMs: stats.current.frames ? stats.current.ms / stats.current.frames : 0,
          maxMs: stats.current.max, frames: stats.current.frames,
        }),
      }
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      paintRef.current = null
    }
  }, [geo, level, paint, box, openReqs, walkLive, maxHop, picked, actors, fitK])

  // ── copy ──────────────────────────────────────────────────────────────────
  const detail = picked != null ? level.items[picked] : null
  const hoverItem = hover ? level.items[hover.i] : null
  const litFrac = coverage.totalNodes ? coverage.exploredNodes / coverage.totalNodes : 0
  const walkOrigin = walk ? nodeById(walk.origin) : null
  const crumbs = useMemo(() => {
    const out = [{ label: 'repo', to: [] }]
    for (let i = 0; i < prefix.length; i += 1) out.push({ label: prefix[i], to: prefix.slice(0, i + 1) })
    return out
  }, [prefix])

  const scopeCopy = level.full
    ? `${level.items.length} NODES · ${geo.edges.length} EDGES · WHOLE GRAPH`
    : `${level.items.length} GROUPS · ${geo.edges.length} EDGES · CLICK ONE TO DESCEND`

  return (
    <section className="panel-dark overflow-hidden flex flex-col min-w-0">
      <div className="px-3.5 sm:px-5 pt-4 pb-3 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="micro-label flex items-center gap-1.5" style={{ color: 'rgba(250,249,246,0.5)' }}>
            <GitBranch size={12} /> THE GRAPH
          </div>
          <h2 className="font-serif-display text-[24px] sm:text-[30px] leading-tight mt-1" style={{ color: 'var(--cream)' }}>
            {walkLive
              ? <>The walk is travelling the arrows.</>
              : paint.litItems > 0
                ? <>Filled circles are what the agent has seen.</>
                : <>Every circle is dark.</>}
          </h2>
          <p className="mono text-[11px] mt-1 truncate" style={{ color: 'rgba(250,249,246,0.42)' }}>
            {walk
              ? `${walkDone ? 'walk exhausted' : `hop ${Number(walk.hop)}/${Number(walk.k)}`}${walkOrigin ? ` · from ${walkOrigin.name}` : ''} · ${frontier.length} nodes reached`
              : 'ranks run left to right · an arrow is an edge in the real graph'}
          </p>
        </div>
        <Legend walking={walkLive} actors={actors} />
      </div>

      {prefix.length > 0 && (
        <div className="px-3.5 sm:px-5 pb-2 flex items-center gap-1 flex-wrap">
          {crumbs.map((c, i) => (
            <span key={c.to.join('.') || 'root'} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={11} style={{ color: 'rgba(250,249,246,0.3)' }} />}
              <button
                className="mono text-[11px] px-1.5 py-0.5 rounded"
                style={{
                  color: i === crumbs.length - 1 ? 'var(--cream)' : 'rgba(250,249,246,0.5)',
                  background: i === crumbs.length - 1 ? 'rgba(250,249,246,0.10)' : 'transparent',
                }}
                onClick={() => { setPrefix(c.to); setPicked(null) }}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="px-2 sm:px-3 pb-2">
        <div
          ref={wrapRef}
          className="relative w-full rounded-lg overflow-hidden select-none"
          style={{ height: box.h || 420, background: '#0a0908', cursor: 'crosshair', touchAction: 'none' }}
        >
          <canvas
            ref={canvasRef}
            width={Math.max(1, Math.floor(box.w * (window.devicePixelRatio || 1)))}
            height={Math.max(1, Math.floor(box.h * (window.devicePixelRatio || 1)))}
            className="absolute inset-0 w-full h-full"
          />

          <div className="absolute top-2.5 right-2.5 z-10 flex flex-col gap-1.5">
            <div
              className="flex flex-col rounded-md overflow-hidden"
              style={{ border: '1px solid rgba(250,249,246,0.18)', background: 'rgba(10,9,8,0.78)' }}
            >
              <MapBtn label="Zoom in" onClick={() => zoomCentre(1.7)}><Plus size={13} /></MapBtn>
              <span style={{ height: 1, background: 'rgba(250,249,246,0.14)' }} />
              <MapBtn label="Zoom out" onClick={() => zoomCentre(1 / 1.7)}><Minus size={13} /></MapBtn>
            </div>
            <MapBtn label="Fit to view" boxed onClick={() => fit(true)}><Crosshair size={13} /></MapBtn>
          </div>

          <div className="absolute left-2.5 bottom-2.5 z-10 pointer-events-none">
            <span className="micro-label" style={{ color: 'rgba(250,249,246,0.32)', letterSpacing: '0.14em', fontSize: 9.5 }}>
              {scopeCopy}
            </span>
          </div>

          {hoverItem && (
            <div
              className="absolute pointer-events-none px-2 py-1 rounded-md hidden sm:block"
              style={{
                left: Math.min(Math.max(8, hover.sx + 14), Math.max(8, box.w - 260)),
                top: Math.max(8, hover.sy - 40),
                background: 'rgba(10,9,8,0.94)',
                border: `1px ${hoverItem.isNew ? 'dashed' : 'solid'} rgba(250,249,246,0.18)`,
                zIndex: 8, maxWidth: 268,
              }}
            >
              <div className="mono text-[11px] truncate" style={{ color: 'var(--cream)' }}>{hoverItem.path}</div>
              <div className="mono text-[10px]" style={{ color: paint.lit[hover.i] ? 'var(--ember)' : 'rgba(250,249,246,0.45)' }}>
                {hoverItem.count > 1
                  ? `${paint.lit[hover.i]}/${hoverItem.count} explored · click to descend`
                  : paint.lit[hover.i] ? 'explored' : 'dark — click to ask'}
              </div>
            </div>
          )}

          {covState !== 'live' && !isMock && (
            <div className="absolute inset-x-0 bottom-0 flex items-end justify-center p-3 pointer-events-none">
              <span
                className="micro-label px-3 py-1.5 rounded-full flex items-center gap-2 text-center"
                style={{ background: 'rgba(10,9,8,0.86)', color: 'rgba(250,249,246,0.66)', border: '1px solid rgba(250,249,246,0.14)' }}
              >
                <Loader2 size={11} className="spin-slow" />
                {covState === 'connecting' ? 'SUBSCRIBING TO THE COVERAGE FEED…' : 'COVERAGE FEED NOT PUBLISHED YET — GRAPH IS HONEST, NOT STALE'}
              </span>
            </div>
          )}
          {!level.items.length && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="micro-label" style={{ color: 'rgba(250,249,246,0.5)' }}>LAYING OUT THE GRAPH…</span>
            </div>
          )}
          {covError && (
            <div className="absolute bottom-2 left-2 right-2 micro-label truncate" style={{ color: 'rgba(255,106,90,0.8)' }}>
              {covError}
            </div>
          )}
        </div>
      </div>

      <div
        className="px-3.5 sm:px-5 py-3 flex items-center justify-between gap-3 flex-wrap"
        style={{ borderTop: '1px solid rgba(250,249,246,0.10)' }}
      >
        {flash ? (
          <span className="mono text-[12px] truncate min-w-0" style={{ color: 'var(--ask)' }}>
            asked the agent to explore <strong>{flash}</strong> — every screen in this room sees it
          </span>
        ) : detail ? (
          <span className="min-w-0">
            <span className="block mono text-[12.5px] truncate" style={{ color: 'var(--cream)' }}>{detail.path}</span>
            <span className="block mono text-[11px]" style={{ color: 'rgba(250,249,246,0.5)' }}>
              {detail.count} node{detail.count === 1 ? '' : 's'}
              {detail.tests ? ` · ${detail.tests} test${detail.tests === 1 ? '' : 's'}` : ''}
              {' · '}
              {paint.lit[picked] ? `${paint.lit[picked]} explored` : 'never looked at'}
              {paint.req[picked] ? ` · ${STATUS[paint.req[picked].status]?.label || ''}` : ''}
            </span>
          </span>
        ) : (
          <span className="micro-label min-w-0 truncate" style={{ color: 'rgba(250,249,246,0.5)' }}>
            {canRequest
              ? 'DRAG TO PAN · SCROLL OR PINCH TO ZOOM · CLICK A DARK CIRCLE TO ASK'
              : 'CIRCLES ARE NODES · ARROWS ARE EDGES · RANKS RUN LEFT TO RIGHT'}
          </span>
        )}

        <span className="flex items-center gap-3 shrink-0">
          <span className="mono text-[11.5px] whitespace-nowrap" style={{ color: 'rgba(250,249,246,0.55)' }}>
            {coverage.exploredNodes}/{coverage.totalNodes} nodes · {(litFrac * 100).toFixed(1)}%
          </span>
          {detail && paint.lit[picked] > 0 && (
            <button
              className="pill-ghost !py-1 !px-3"
              style={{ borderColor: 'rgba(250,249,246,0.22)', color: 'var(--cream)' }}
              onClick={() => startWalk(detail.pick)}
            >
              <Play size={11} /> Impact walk
            </button>
          )}
        </span>
      </div>
    </section>
  )
}

function MapBtn({ children, onClick, label, boxed }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="w-8 h-8 flex items-center justify-center"
      style={{
        color: 'rgba(250,249,246,0.82)',
        background: boxed ? 'rgba(10,9,8,0.78)' : 'transparent',
        border: boxed ? '1px solid rgba(250,249,246,0.18)' : 'none',
        borderRadius: boxed ? 6 : 0,
      }}
    >
      {children}
    </button>
  )
}

function Swatch({ color, border, dashed, label }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="w-2.5 h-2.5 rounded-full shrink-0"
        style={{ background: color || 'transparent', border: border ? `1.5px ${dashed ? 'dashed' : 'solid'} ${border}` : 'none' }}
      />
      <span className="micro-label" style={{ color: 'rgba(250,249,246,0.55)', letterSpacing: '0.08em' }}>{label}</span>
    </span>
  )
}

function Legend({ walking, actors }) {
  const subs = (actors || []).filter((a) => a.actorId)
  const shown = subs.slice(0, MAX_ACTOR_COLORS)
  const rest = subs.length - shown.length
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
      <Swatch border="rgba(250,249,246,0.34)" label="DARK" />
      <Swatch color={MAIN_COLOR} label={subs.length ? 'MAIN AGENT' : 'EXPLORED'} />
      {shown.map((a) => <Swatch key={a.actorId} color={a.color} label={actorShort(a.actorId).toUpperCase()} />)}
      {rest > 0 && <Swatch color="#94a3b8" label={`+${rest} MORE`} />}
      {walking && <Swatch color="#35d0ff" label="WALK" />}
      <Swatch border="var(--ask)" dashed label="ASKED" />
      <Swatch border="var(--done)" label="REPORTED" />
    </div>
  )
}

// ── painter ────────────────────────────────────────────────────────────────

const ARROW = 7.5

function drawGraph(ctx, s) {
  const { geo, level, paint, box, cam: c, maxHop, walkLive, ignite, hover, picked, now, reduce } = s
  const dpr = window.devicePixelRatio || 1
  const W = box.w
  const H = box.h
  let animated = false
  if (!W || !H) return animated

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#0a0908'
  ctx.fillRect(0, 0, W, H)
  if (!geo.nodes.length) return animated

  // A single warm wash so the plate has a light source rather than reading as
  // a black debug canvas.
  const gg = ctx.createLinearGradient(0, 0, W, H)
  gg.addColorStop(0, '#14110f')
  gg.addColorStop(0.55, '#0e0c0b')
  gg.addColorStop(1, '#0a0908')
  ctx.fillStyle = gg
  ctx.fillRect(0, 0, W, H)

  const k = c.k
  ctx.setTransform(k * dpr, 0, 0, k * dpr, (W / 2 - c.x * k) * dpr, (H / 2 - c.y * k) * dpr)
  const px = (v) => v / k
  const pad = 40 / k
  const vx0 = c.x - W / (2 * k) - pad, vx1 = c.x + W / (2 * k) + pad
  const vy0 = c.y - H / (2 * k) - pad, vy1 = c.y + H / (2 * k) + pad

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const R = geo.R
  const items = level.items
  const nodes = geo.nodes
  const showLabels = k * geo.labelPx >= 5.6
  const showSub = k * geo.labelPx >= 9
  const showEdgeLabels = (level.multiKind || !level.full) && geo.edges.length <= 240 && k >= 0.85

  // Which circles the pointer is on, and which arrows touch it.
  const hi = hover ? hover.i : -1
  const hiSet = new Set()
  if (hi >= 0) {
    hiSet.add(hi)
    for (const e of geo.edges) {
      if (e.s === hi) hiSet.add(e.t)
      else if (e.t === hi) hiSet.add(e.s)
    }
  }

  const litRGB = (i) => SLOT_RGB[paint.slot[i]] || SLOT_RGB[0]

  // ── arrows, under the circles ─────────────────────────────────────────────
  const dashPhase = walkLive && !reduce ? (now / 26) % 20 : 0
  for (const e of geo.edges) {
    const exMin = Math.min(e.ax, e.bx, e.c1x, e.c2x)
    const exMax = Math.max(e.ax, e.bx, e.c1x, e.c2x)
    const eyMin = Math.min(e.ay, e.by, e.c1y, e.c2y)
    const eyMax = Math.max(e.ay, e.by, e.c1y, e.c2y)
    if (exMax < vx0 || exMin > vx1 || eyMax < vy0 || eyMin > vy1) continue

    const hs = paint.hop[e.s]
    const ht = paint.hop[e.t]
    const onWalk = hs >= 0 && ht >= 0 && Math.abs(hs - ht) === 1
    const touched = hiSet.size > 0 && (e.s === hi || e.t === hi)
    const lit = paint.lit[e.s] > 0 && paint.lit[e.t] > 0

    let stroke
    let width = px(1.05)
    let dash = null
    if (onWalk) {
      const [r, g, b] = hopTint(Math.max(hs, ht), maxHop)
      stroke = rgba(r, g, b, 0.85)
      width = px(1.9)
      if (walkLive && !reduce) { dash = [px(7), px(6)]; animated = true }
    } else if (touched) {
      stroke = 'rgba(255,140,70,0.85)'
      width = px(1.8)
    } else if (hi >= 0) {
      stroke = 'rgba(250,249,246,0.06)'
    } else if (lit) {
      stroke = 'rgba(250,249,246,0.26)'
      width = px(1.25)
    } else {
      stroke = 'rgba(250,249,246,0.13)'
    }

    // Trim the curve to the circle rims so the arrowhead lands on the edge of
    // the target rather than under it.
    const t0 = Math.min(0.42, (R + 1.5) / Math.max(1, Math.hypot(e.bx - e.ax, e.by - e.ay)))
    const t1 = 1 - Math.min(0.42, (R + ARROW + 1.5) / Math.max(1, Math.hypot(e.bx - e.ax, e.by - e.ay)))
    const [sx, sy] = cubicAt(e, t0)
    const [ex, ey, dxE, dyE] = cubicAt(e, t1)

    ctx.strokeStyle = stroke
    ctx.lineWidth = width
    if (dash) { ctx.setLineDash(dash); ctx.lineDashOffset = -dashPhase } else ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.bezierCurveTo(e.c1x, e.c1y, e.c2x, e.c2y, ex, ey)
    ctx.stroke()
    ctx.setLineDash([])

    // arrowhead — crisp, not chunky
    const ang = Math.atan2(dyE, dxE)
    const ah = ARROW
    ctx.fillStyle = stroke
    ctx.beginPath()
    ctx.moveTo(ex + Math.cos(ang) * ah, ey + Math.sin(ang) * ah)
    ctx.lineTo(ex + Math.cos(ang + 2.55) * ah * 0.72, ey + Math.sin(ang + 2.55) * ah * 0.72)
    ctx.lineTo(ex + Math.cos(ang - 2.55) * ah * 0.72, ey + Math.sin(ang - 2.55) * ah * 0.72)
    ctx.closePath()
    ctx.fill()
    if (e.bidi) {
      const [bx, by, dxS, dyS] = cubicAt(e, t0 + 0.001)
      const a2 = Math.atan2(-dyS, -dxS)
      ctx.beginPath()
      ctx.moveTo(bx + Math.cos(a2) * ah, by + Math.sin(a2) * ah)
      ctx.lineTo(bx + Math.cos(a2 + 2.55) * ah * 0.72, by + Math.sin(a2 + 2.55) * ah * 0.72)
      ctx.lineTo(bx + Math.cos(a2 - 2.55) * ah * 0.72, by + Math.sin(a2 - 2.55) * ah * 0.72)
      ctx.closePath()
      ctx.fill()
    }

    if (showEdgeLabels && (e.w > 1 || (level.multiKind && touched))) {
      const [mx, my] = cubicAt(e, 0.5)
      const txt = e.w > 1 ? `×${e.w}` : e.kind.toLowerCase()
      ctx.font = `${geo.labelPx * 0.8}px "Geist Mono", ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const tw = ctx.measureText(txt).width
      ctx.fillStyle = 'rgba(10,9,8,0.92)'
      ctx.fillRect(mx - tw / 2 - 3, my - 6, tw + 6, 12)
      ctx.fillStyle = touched ? 'rgba(255,170,110,0.95)' : 'rgba(250,249,246,0.42)'
      ctx.fillText(txt, mx, my)
    }
  }

  // ── circles ───────────────────────────────────────────────────────────────
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const labelFont = `${geo.labelPx}px "Geist Mono", ui-monospace, monospace`
  const subFont = `${geo.labelPx * 0.78}px "Geist Mono", ui-monospace, monospace`

  for (let i = 0; i < nodes.length; i += 1) {
    const nd = nodes[i]
    if (!nd) continue
    if (nd.x < vx0 - 60 || nd.x > vx1 + 60 || nd.y < vy0 - 40 || nd.y > vy1 + 40) continue
    const it = items[i]
    const lit = paint.lit[i] > 0
    const frac = it.count ? paint.lit[i] / it.count : 0
    const hop = paint.hop[i]
    const req = paint.req[i]
    const isHi = i === hi
    const near = hiSet.has(i)
    const dim = hi >= 0 && !near

    // ignition flare
    let flare = 0
    const t0 = ignite.get(i)
    if (t0 !== undefined) {
      const t = Math.min(1, (now - t0) / IGNITE_MS)
      flare = (1 - t) ** 2
      animated = true
    }

    let rgb = litRGB(i)
    if (hop >= 0) rgb = hopTint(hop, maxHop)
    const [r, g, b] = rgb
    const rad = R * (isHi ? 1.22 : 1)

    // glow under an explored circle
    if (lit || hop >= 0) {
      const glow = ctx.createRadialGradient(nd.x, nd.y, 0, nd.x, nd.y, rad * (3.2 + flare * 2.6))
      glow.addColorStop(0, rgba(r, g, b, 0.34 + flare * 0.4))
      glow.addColorStop(1, rgba(r, g, b, 0))
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(nd.x, nd.y, rad * (3.2 + flare * 2.6), 0, TAU)
      ctx.fill()
    }

    ctx.beginPath()
    ctx.arc(nd.x, nd.y, rad, 0, TAU)
    if (lit || hop >= 0) {
      // Partial coverage of a group reads as a dimmer fill, so a directory that
      // is a quarter explored does not claim to be finished.
      const a = hop >= 0 ? 0.95 : 0.36 + 0.6 * frac
      ctx.fillStyle = rgba(r, g, b, dim ? a * 0.32 : a)
      ctx.fill()
      ctx.lineWidth = px(1.4)
      ctx.strokeStyle = rgba(Math.min(255, r + 50), Math.min(255, g + 45), Math.min(255, b + 40), dim ? 0.3 : 0.95)
      ctx.stroke()
    } else {
      ctx.fillStyle = dim ? 'rgba(250,249,246,0.02)' : 'rgba(250,249,246,0.055)'
      ctx.fill()
      ctx.lineWidth = px(1.25)
      if (it.isNew) ctx.setLineDash([px(2.6), px(2.6)])
      ctx.strokeStyle = dim
        ? 'rgba(250,249,246,0.10)'
        : it.isNew ? 'rgba(250,249,246,0.62)' : 'rgba(250,249,246,0.30)'
      ctx.stroke()
      ctx.setLineDash([])
    }

    // a group carries a faint second ring — it is a folder, not a leaf
    if (it.count > 1) {
      ctx.beginPath()
      ctx.arc(nd.x, nd.y, rad + 3, 0, TAU)
      ctx.lineWidth = px(0.9)
      ctx.strokeStyle = lit ? rgba(r, g, b, dim ? 0.14 : 0.42) : 'rgba(250,249,246,0.14)'
      ctx.stroke()
    }

    // request state
    if (req) {
      const st = STATUS[req.status] || STATUS.pending
      const open = req.status !== 'done'
      let alpha = 1
      if (open && !reduce) {
        alpha = 0.55 + 0.45 * Math.sin(now / 260 + i)
        animated = true
      }
      ctx.beginPath()
      ctx.arc(nd.x, nd.y, rad + 6, 0, TAU)
      ctx.lineWidth = px(1.8)
      ctx.strokeStyle = st.ring
      ctx.globalAlpha = alpha
      if (req.status === 'pending') ctx.setLineDash([px(3), px(3)])
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }

    if (picked === i) {
      ctx.beginPath()
      ctx.arc(nd.x, nd.y, rad + 9, 0, TAU)
      ctx.lineWidth = px(1)
      ctx.strokeStyle = 'rgba(250,249,246,0.55)'
      ctx.stroke()
    }

    if (!showLabels) continue
    const label = short(it.label)
    ctx.font = labelFont
    const ly = nd.y + rad + geo.labelGap
    if (isHi) {
      const tw = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(10,9,8,0.9)'
      ctx.fillRect(nd.x - tw / 2 - 4, ly - 2, tw + 8, geo.labelPx + 5)
    }
    ctx.fillStyle = dim
      ? 'rgba(250,249,246,0.16)'
      : isHi ? '#ffffff'
        : lit || hop >= 0 ? 'rgba(250,249,246,0.90)' : 'rgba(250,249,246,0.46)'
    ctx.fillText(label, nd.x, ly)
    if (showSub && it.sub && !dim) {
      ctx.font = subFont
      ctx.fillStyle = 'rgba(250,249,246,0.30)'
      ctx.fillText(it.sub, nd.x, ly + geo.labelPx + 1)
    }
  }

  return animated
}
