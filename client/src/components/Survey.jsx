import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Compass, Crosshair, Loader2, Minus, Play, Plus } from 'lucide-react'
import { useRoom } from '../lib/room.jsx'
import { key } from '../lib/util'

/**
 * THE SURVEY — a navigable survey plate of the repo.
 *
 * The visible tree is the package hierarchy: a radial tidy tree, districts
 * fanning into angular sectors, files on the ring, symbols past them. The root
 * system underneath is the call graph — bundled filaments that cut clean across
 * the folders, because a call does not care where a file lives.
 *
 * Colour is the only thing that ever moves:
 *   dark     — never touched
 *   ember    — the agent has been here
 *   cyan     — the backwards walk is painting this hop
 *   amber    — a human asked the agent to go look
 *
 * Every colour comes from a subscription row. There is no optimistic local
 * state, which is why a second tab that clicked nothing paints the same map.
 *
 * The canvas carries the entire map body. The DOM carries only furniture —
 * controls, tooltip, legend — and hit-testing goes through the spatial grid in
 * geo.js, never through the DOM. At 2,272 symbols and 3,335 filaments there is
 * no version of one-element-per-node that survives a pan.
 */

const IGNITE_MS = 2200
// Cadence for a repaint whose ONLY reason is an open request's pulse.
const PULSE_MS = 55
const TAU = Math.PI * 2

const STATUS = {
  pending: { ring: '#ffd166', label: 'REQUESTED' },
  claimed: { ring: '#35d0ff', label: 'AGENT ON IT' },
  done: { ring: '#7ddb9a', label: 'REPORTED BACK' },
}

/**
 * Level of detail, keyed on the map's on-screen radius in CSS pixels. This is
 * what makes it read as a map rather than a diagram: from altitude you get
 * named territory, and detail arrives as you descend into it.
 */
function lodFor(pxR) {
  // The coastline — the ring of symbols — is drawn at every altitude. It is the
  // outline of the country, and it is the surface coverage spreads across, so
  // dropping it to save frames would cost the one thing the map is for.
  if (pxR < 320) {
    return { tier: 'districts', wedges: 2, branch: 3, symbols: true, hairs: false, fileDots: false, filCap: 1100, dLabel: 1, minorLabels: true, fileLabels: false }
  }
  if (pxR < 660) {
    return { tier: 'clusters', wedges: 2, branch: 5, symbols: true, hairs: false, fileDots: true, filCap: 2400, dLabel: 2, minorLabels: false, fileLabels: false }
  }
  if (pxR < 1600) {
    return { tier: 'files', wedges: 2, branch: 99, symbols: true, hairs: false, fileDots: true, filCap: 7000, dLabel: 2, minorLabels: false, fileLabels: true }
  }
  return { tier: 'symbols', wedges: 0, branch: 99, symbols: true, hairs: true, fileDots: true, filCap: 1e9, dLabel: 0, minorLabels: false, fileLabels: true }
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
      const h = w < 620 ? Math.min(Math.max(w * 1.12, 380), 560) : Math.max(460, Math.min(w * 0.72, 780))
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, box]
}

function hopTint(h, maxH) {
  const t = maxH > 0 ? h / maxH : 0
  if (t < 0.25) return [53, 208, 255]
  if (t < 0.5) return [120, 220, 255]
  if (t < 0.75) return [186, 236, 255]
  return [250, 249, 246]
}

const rgba = (r, g, b, a) => `rgba(${r},${g},${b},${a})`

/**
 * Stroke a flat [x,y,...] run as a smooth curve.
 *
 * The filaments and branches are stored as sampled points, and `lineTo`ing them
 * puts the sampling on screen as visible corners as soon as you zoom in past
 * it. Threading a quadratic through the midpoints costs the same number of
 * ops and the kinks are simply gone.
 */
function strokeRun(ctx, p, n) {
  ctx.beginPath()
  ctx.moveTo(p[0], p[1])
  if (n < 3) {
    for (let i = 1; i < n; i += 1) ctx.lineTo(p[i * 2], p[i * 2 + 1])
  } else {
    for (let i = 1; i < n - 1; i += 1) {
      const x = p[i * 2], y = p[i * 2 + 1]
      ctx.quadraticCurveTo(x, y, (x + p[i * 2 + 2]) / 2, (y + p[i * 2 + 3]) / 2)
    }
    ctx.lineTo(p[(n - 1) * 2], p[(n - 1) * 2 + 1])
  }
  ctx.stroke()
}

// One noise tile, built once and reused as a pattern. Grain is what stops a
// flat dark fill from reading as a debug view.
let grainTile = null
function grain(ctx) {
  if (!grainTile) {
    const c = document.createElement('canvas')
    c.width = 128
    c.height = 128
    const g = c.getContext('2d')
    const img = g.createImageData(128, 128)
    // Deterministic LCG, so the grain is identical in every tab.
    let seed = 0x2f6e2b1
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const v = seed >>> 24
      img.data[i] = 255
      img.data[i + 1] = 246
      img.data[i + 2] = 232
      img.data[i + 3] = v > 198 ? (v - 198) * 2 : 0
    }
    g.putImageData(img, 0, 0)
    grainTile = c
  }
  return ctx.createPattern(grainTile, 'repeat')
}

export default function Survey() {
  const {
    geography, territory, coverage, requestsByFile, requestExploration, canRequest,
    covState, covError, startWalk, isMock, walk, frontier, walkDone, nodeById,
  } = useRoom()

  const [wrapRef, box] = useBox()
  const canvasRef = useRef(null)
  const cam = useRef({ x: 0, y: 0, k: 1, fitted: false })
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
  const [tier, setTier] = useState('districts')

  // ── the wake ──────────────────────────────────────────────────────────────
  // A map that nobody is touching and that nothing is animating must cost the
  // machine NOTHING. The draw loop is therefore not a loop: `frame` re-arms
  // itself only while a tween, an ignition or an open request is still moving,
  // and otherwise lets the chain end. Anything that changes what the plate
  // should look like — a subscription row, a pan, a zoom, a hover — calls
  // `wake()`, which marks the plate dirty and restarts the chain if it stopped.
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

  const hopByNode = useMemo(() => {
    const m = new Map()
    for (const f of frontier) m.set(key(f.nodeId), Number(f.hop))
    return m
  }, [frontier])

  const maxHop = walk ? Number(walk.hop) : 0

  // ── ignition ──────────────────────────────────────────────────────────────
  // A file that has just lit records the moment it did, and the painter reads
  // that as a decaying envelope: the region flares and then settles on its own.
  // No timers — a timer-driven version strands regions mid-pulse as soon as the
  // next burst of touches lands a beat later, which during a live agent run is
  // every single time.
  const prevLit = useRef(null)
  useEffect(() => {
    const cur = coverage.lit
    const prev = prevLit.current
    prevLit.current = cur
    if (!prev || prev.length !== cur.length) return
    const now = performance.now()
    for (let i = 0; i < cur.length; i += 1) {
      if (cur[i] > 0 && prev[i] === 0) { ignite.current.set(i, now); wake() }
    }
  }, [coverage])

  // The plate is a disc, and a map you can drag off the edge of into pure black
  // stops feeling like a place. Clamp the camera to the survey — and tighten
  // that clamp as you pull back, so once the whole plate fits it is pinned
  // centred instead of sliding into a corner.
  const clamp = useCallback((x, y, k) => {
    const geo = geography
    if (!geo || !box.w) return [x, y]
    const half = Math.min(box.w, box.h) / (2 * k)
    const lim = Math.max(0, geo.RMAX * 1.02 - half)
    const d = Math.hypot(x, y)
    if (d <= lim) return [x, y]
    return d > 0 ? [(x / d) * lim, (y / d) * lim] : [0, 0]
  }, [geography, box])

  const goTo = useCallback((x, y, k, animate = true) => {
    const c = cam.current
    const [cx, cy] = clamp(x, y, k)
    if (!animate || reduceMotion.current) {
      c.x = cx; c.y = cy; c.k = k
      tween.current = null
    } else {
      tween.current = { x0: c.x, y0: c.y, k0: c.k, x1: cx, y1: cy, k1: k, t0: performance.now(), dur: 560 }
    }
    wake()
  }, [clamp, wake])

  const fit = useCallback((W, H, geo, animate) => {
    if (!geo || !W || !H) return
    goTo(0, 0, Math.min(W, H) / (2 * geo.RMAX * 1.10), animate)
    cam.current.fitted = true
  }, [goTo])

  const panBy = useCallback((dx, dy) => {
    const c = cam.current
    const [x, y] = clamp(c.x - dx / c.k, c.y - dy / c.k, c.k)
    c.x = x; c.y = y
    wake()
  }, [clamp, wake])

  useEffect(() => {
    if (geography && box.w && !cam.current.fitted) fit(box.w, box.h, geography, false)
  }, [geography, box, fit])

  useEffect(() => { wake() }, [box, coverage, requestsByFile, hopByNode, picked, wake])

  // A `done` ring is static. Only an open request actually animates, so only an
  // open request earns a repaint every frame.
  const openReqs = useMemo(() => {
    let n = 0
    for (const r of requestsByFile.values()) if (r.status !== 'done') n += 1
    return n
  }, [requestsByFile])

  const screenToWorld = useCallback((sx, sy) => {
    const c = cam.current
    return { x: c.x + (sx - box.w / 2) / c.k, y: c.y + (sy - box.h / 2) / c.k }
  }, [box])

  const zoomLimits = useCallback(() => {
    const geo = geography
    if (!geo || !box.w) return [0.001, 1000]
    const base = Math.min(box.w, box.h) / (2 * geo.RMAX)
    return [base / 1.5, base * 9]
  }, [geography, box])

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

  // ── hit test ──────────────────────────────────────────────────────────────
  // From altitude you are pointing at territory; up close you are pointing at a
  // file. Same gesture, different altitude — the contract a map makes with you.
  const hitAt = useCallback((sx, sy) => {
    const geo = geography
    if (!geo) return null
    const { x, y } = screenToWorld(sx, sy)
    const lod = lodFor(cam.current.k * geo.RMAX)

    if (lod.fileDots) {
      const r = Math.min(geo.RMAX * 0.05, 18 / cam.current.k)
      const leaf = geo.pick(x, y, r)
      if (leaf >= 0) return { kind: 'file', fi: geo.leafFile[leaf] }
      let best = -1
      let bestD = (r * 3.2) ** 2
      for (let fi = 0; fi < geo.nFiles; fi += 1) {
        const f = geo.files[fi]
        const d = (f.gx - x) ** 2 + (f.gy - y) ** 2
        if (d < bestD) { bestD = d; best = fi }
      }
      if (best >= 0) return { kind: 'file', fi: best }
    }

    const rr = Math.hypot(x, y)
    if (rr > geo.RMAX * 1.06) return null
    let a = Math.atan2(y, x)
    while (a < geo.ROT) a += TAU
    while (a >= geo.ROT + TAU) a -= TAU
    // Always resolve to the depth-2 district. `tests` is 78% of this repo, so
    // "descend into tests" is not a descent — `tests/auth_tests` is.
    let hit = null
    for (const d of geo.districts) {
      if (d.depth === 2 && a >= d.a0 && a <= d.a1) { hit = d; break }
    }
    if (!hit) {
      for (const d of geo.districts) {
        if (d.depth === 1 && a >= d.a0 && a <= d.a1) { hit = d; break }
      }
    }
    return hit ? { kind: 'district', d: hit } : null
  }, [geography, screenToWorld])

  const flyToDistrict = useCallback((d) => {
    const geo = geography
    if (!geo) return
    // The files of a district live in the band just inside the coastline, and
    // the empty middle of a radial tree is the one place worth never flying to.
    // Frame the sector's arc AT THE RIM and settle the camera on that band.
    const span = Math.max(0.04, d.a1 - d.a0)
    const arc = span * geo.RMAX
    const [minK, maxK] = zoomLimits()
    // Never let "descend" zoom out: a wide sector still moves you closer in.
    const want = Math.max(Math.min(box.w, box.h) / (arc * 1.35), cam.current.k * 1.9)
    const mid = (d.a0 + d.a1) / 2
    const rc = geo.RMAX * 0.90
    goTo(Math.cos(mid) * rc, Math.sin(mid) * rc, Math.min(maxK, Math.max(minK, want)))
  }, [geography, box, zoomLimits, goTo])

  const onFile = useCallback((fi) => {
    const f = territory.files[fi]
    if (!f) return
    setPicked(fi)
    const dark = coverage.lit[fi] === 0
    if (!dark || !canRequest) return
    const existing = requestsByFile.get(fi)
    if (existing && existing.status !== 'done') return
    requestExploration(f.pick, f.path)
    setFlash(f.path)
    setTimeout(() => setFlash((p) => (p === f.path ? null : p)), 3200)
  }, [territory, coverage, canRequest, requestsByFile, requestExploration])

  // ── pointer / wheel / pinch ───────────────────────────────────────────────
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return

    const onWheel = (e) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      // ctrlKey is how a trackpad pinch reaches the wheel event.
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
        const target = pinch.current.k * (dist / (pinch.current.dist || dist))
        zoomAt(cx, cy, target / cam.current.k)
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
      const hit = hitAt(sx, sy)
      const next = hit
        ? {
          kind: hit.kind,
          fi: hit.kind === 'file' ? hit.fi : null,
          name: hit.kind === 'district' ? hit.d.name : null,
          sx, sy,
        }
        : null
      const same = (hoverRef.current?.fi ?? null) === (next?.fi ?? null)
        && (hoverRef.current?.name ?? null) === (next?.name ?? null)
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
        const hit = hitAt(e.clientX - rect.left, e.clientY - rect.top)
        if (hit?.kind === 'file') onFile(hit.fi)
        else if (hit?.kind === 'district') flyToDistrict(hit.d)
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
      const nk = Math.min(maxK, c.k * 2.4)
      // Keep the point under the cursor under the cursor, then fly there.
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
  }, [hitAt, onFile, zoomAt, flyToDistrict, zoomLimits, goTo, panBy, box])

  // ── draw loop ─────────────────────────────────────────────────────────────
  // Not a loop. `frame` re-arms itself only while something is genuinely in
  // motion; the moment the plate settles the rAF chain ends and the tab goes
  // quiet. `wake()` starts it again. This matters because the map is the thing
  // left open on a projector for an hour while an agent works: a survey that
  // is doing nothing must show up as doing nothing.
  const stats = useRef({ frames: 0, ms: 0, max: 0, ticks: 0 })
  const animRef = useRef(false)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !box.w) return
    const ctx = canvas.getContext('2d', { alpha: false })
    let lastTier = null
    let lastPulse = 0
    // Assume an open request is visible until a paint says otherwise, so the
    // loop always gets at least one frame to find out.
    animRef.current = openReqs > 0

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
        // Zoom eases in log space or the middle of the flight reads wrong.
        c.k = Math.exp(Math.log(tw.k0) + (Math.log(tw.k1) - Math.log(tw.k0)) * e)
        if (t >= 1) tween.current = null
        dirty.current = true
      }

      let igniting = false
      if (ignite.current.size) {
        // An expiring ignition earns one last frame, so the flare is cleared
        // off the plate rather than frozen at its dimmest.
        for (const [fi, t0] of ignite.current) {
          if (now - t0 > IGNITE_MS) { ignite.current.delete(fi); dirty.current = true }
        }
        igniting = ignite.current.size > 0
      }
      // An open request pulses — but only while its ring is actually on the
      // plate. `animRef` carries that answer back from the last paint, so a
      // request left pending overnight stops costing anything the moment you
      // pull back above the altitude its ring is drawn at.
      const wantPulse = !reduceMotion.current && openReqs > 0
      let pulsing = wantPulse && animRef.current
      // And even when it IS on screen, a pulse does not need 120 repaints a
      // second: its slowest cycle is ~1.6s, so ~18Hz is indistinguishable and
      // costs a sixth as much.
      const pulseDue = pulsing && now - lastPulse >= PULSE_MS

      if (dirty.current || igniting || pulseDue) {
        dirty.current = false
        if (pulsing) lastPulse = now
        const t0 = performance.now()
        animRef.current = !!drawSurvey(ctx, {
          geo: geography, box, cam: c, coverage, requestsByFile, hopByNode, maxHop,
          walkActive: !!walk && !walkDone,
          ignite: ignite.current, hover: hoverRef.current, picked, now,
          reduce: reduceMotion.current,
        })
        pulsing = wantPulse && animRef.current
        const dt = performance.now() - t0
        stats.current.frames += 1
        stats.current.ms += dt
        if (dt > stats.current.max) stats.current.max = dt
        if (geography) {
          const t = lodFor(c.k * geography.RMAX).tier
          if (t !== lastTier) { lastTier = t; setTier(t) }
        }
      }
      // Re-arm ONLY while something is still moving. Otherwise the chain ends
      // here and the next wake() picks it back up.
      if (tween.current || igniting || pulsing) {
        rafRef.current = requestAnimationFrame(frame)
      }
    }

    paintRef.current = frame
    // Anything that re-ran this effect changed what the plate should show.
    dirty.current = true
    if (rafRef.current === 0) rafRef.current = requestAnimationFrame(frame)
    if (typeof window !== 'undefined') {
      window.__survey = {
        stats: stats.current, cam,
        idle: () => rafRef.current === 0,
        diag: () => ({
          parked: rafRef.current === 0, animated: animRef.current, openReqs,
          dirty: dirty.current, tween: !!tween.current, ignite: ignite.current.size,
          reduce: reduceMotion.current,
          tier: geography ? lodFor(cam.current.k * geography.RMAX).tier : null,
          fileDots: geography ? lodFor(cam.current.k * geography.RMAX).fileDots : null,
        }),
      }
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      paintRef.current = null
    }
  }, [geography, box, coverage, requestsByFile, openReqs, hopByNode, maxHop, walk, walkDone, picked])

  const detail = picked != null ? territory.files[picked] : null
  const hoverFile = hover?.kind === 'file' && hover.fi != null ? territory.files[hover.fi] : null
  const litFrac = coverage.totalNodes ? coverage.exploredNodes / coverage.totalNodes : 0
  const walkOrigin = walk ? nodeById(walk.origin) : null

  const TIER_COPY = {
    districts: 'DISTRICTS · CLICK A TERRITORY TO DESCEND',
    clusters: 'FILE CLUSTERS · KEEP ZOOMING FOR THE ROOTS',
    files: 'FILES · CLICK A DARK ONE TO ASK THE AGENT',
    symbols: 'SYMBOLS AND ROOT FILAMENTS',
  }

  return (
    <section className="panel-dark overflow-hidden flex flex-col">
      <div className="px-3.5 sm:px-5 pt-4 pb-3 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="micro-label flex items-center gap-1.5" style={{ color: 'rgba(250,249,246,0.5)' }}>
            <Compass size={12} /> THE SURVEY
          </div>
          <h2 className="font-serif-display text-[24px] sm:text-[30px] leading-tight mt-1" style={{ color: 'var(--cream)' }}>
            {walk && !walkDone
              ? <>The walk is painting outward.</>
              : coverage.exploredFiles > 0
                ? <>Lit ground is what the agent has seen.</>
                : <>The whole country is dark.</>}
          </h2>
          <p className="mono text-[11px] mt-1 truncate" style={{ color: 'rgba(250,249,246,0.42)' }}>
            {walk
              ? `${walkDone ? 'walk exhausted' : `hop ${Number(walk.hop)}/${Number(walk.k)}`}${walkOrigin ? ` · from ${walkOrigin.name}` : ''} · ${frontier.length} nodes reached`
              : 'branches are folders · filaments are calls that ignore them'}
          </p>
        </div>
        <Legend walking={!!walk} />
      </div>

      <div className="px-2 sm:px-3 pb-2">
        <div
          ref={wrapRef}
          className="relative w-full rounded-lg overflow-hidden select-none"
          style={{ height: box.h || 380, background: '#0a0908', cursor: 'crosshair', touchAction: 'none' }}
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
              <MapBtn label="Zoom in" onClick={() => zoomCentre(1.8)}><Plus size={13} /></MapBtn>
              <span style={{ height: 1, background: 'rgba(250,249,246,0.14)' }} />
              <MapBtn label="Zoom out" onClick={() => zoomCentre(1 / 1.8)}><Minus size={13} /></MapBtn>
            </div>
            <MapBtn label="Reset view" boxed onClick={() => { if (geography) fit(box.w, box.h, geography, true) }}>
              <Crosshair size={13} />
            </MapBtn>
          </div>

          <div className="absolute left-2.5 bottom-2.5 z-10 pointer-events-none">
            <span
              className="micro-label"
              style={{ color: 'rgba(250,249,246,0.34)', letterSpacing: '0.14em', fontSize: 9.5 }}
            >
              {TIER_COPY[tier]}
            </span>
          </div>

          {hoverFile && (
            <div
              className="absolute pointer-events-none px-2 py-1 rounded-md hidden sm:block"
              style={{
                left: Math.min(Math.max(8, hover.sx + 14), Math.max(8, box.w - 232)),
                top: Math.max(8, hover.sy - 38),
                background: 'rgba(10,9,8,0.94)',
                border: '1px solid rgba(250,249,246,0.16)',
                zIndex: 8, maxWidth: 240,
              }}
            >
              <div className="mono text-[11px] truncate" style={{ color: 'var(--cream)' }}>{hoverFile.path}</div>
              <div className="mono text-[10px]" style={{ color: coverage.lit[hover.fi] ? 'var(--ember)' : 'rgba(250,249,246,0.45)' }}>
                {hoverFile.count} sym · {coverage.lit[hover.fi] ? `${coverage.lit[hover.fi]} explored` : 'dark — click to ask'}
              </div>
            </div>
          )}
          {hover?.kind === 'district' && (
            <div
              className="absolute pointer-events-none px-2 py-1 rounded-md hidden sm:block"
              style={{
                left: Math.min(Math.max(8, hover.sx + 14), Math.max(8, box.w - 200)),
                top: Math.max(8, hover.sy - 34),
                background: 'rgba(10,9,8,0.94)',
                border: '1px solid rgba(250,249,246,0.16)',
                zIndex: 8,
              }}
            >
              <div className="mono text-[11px]" style={{ color: 'var(--cream)' }}>{hover.name}</div>
              <div className="mono text-[10px]" style={{ color: 'rgba(250,249,246,0.45)' }}>
                {tier === 'districts' || tier === 'clusters' ? 'click to descend' : 'territory'}
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
                {covState === 'connecting' ? 'SUBSCRIBING TO THE COVERAGE FEED…' : 'COVERAGE FEED NOT PUBLISHED YET — MAP IS HONEST, NOT STALE'}
              </span>
            </div>
          )}
          {(!geography || territory.files.length === 0) && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="micro-label" style={{ color: 'rgba(250,249,246,0.5)' }}>SURVEYING THE GRAPH…</span>
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
              {detail.count} symbol{detail.count === 1 ? '' : 's'} · {detail.tests} test{detail.tests === 1 ? '' : 's'} ·{' '}
              {coverage.lit[picked] ? `${coverage.lit[picked]} explored` : 'never looked at'}
              {requestsByFile.get(picked) ? ` · ${STATUS[requestsByFile.get(picked).status]?.label || ''}` : ''}
            </span>
          </span>
        ) : (
          <span className="micro-label min-w-0 truncate" style={{ color: 'rgba(250,249,246,0.5)' }}>
            {canRequest
              ? 'DRAG TO PAN · SCROLL OR PINCH TO ZOOM · CLICK A DARK REGION TO ASK'
              : 'BRANCHES ARE FOLDERS · FILAMENTS ARE CALLS THEY DO NOT KNOW ABOUT'}
          </span>
        )}

        <span className="flex items-center gap-3 shrink-0">
          <span className="mono text-[11.5px] whitespace-nowrap" style={{ color: 'rgba(250,249,246,0.55)' }}>
            {coverage.exploredFiles}/{coverage.totalFiles} files · {(litFrac * 100).toFixed(1)}%
          </span>
          {detail && coverage.lit[picked] > 0 && (
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
        className="w-2.5 h-2.5 rounded-[2px] shrink-0"
        style={{ background: color || 'transparent', border: border ? `1.5px ${dashed ? 'dashed' : 'solid'} ${border}` : 'none' }}
      />
      <span className="micro-label" style={{ color: 'rgba(250,249,246,0.55)', letterSpacing: '0.08em' }}>{label}</span>
    </span>
  )
}

function Legend({ walking }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
      <Swatch color="rgba(250,249,246,0.16)" label="DARK" />
      <Swatch color="rgba(255,116,36,0.95)" label="EXPLORED" />
      {walking && <Swatch color="#35d0ff" label="WALK" />}
      <Swatch border="var(--ask)" dashed label="ASKED" />
      <Swatch border="var(--done)" label="REPORTED" />
    </div>
  )
}

// ── painter ────────────────────────────────────────────────────────────────

function drawSurvey(ctx, s) {
  const {
    geo, box, cam: c, coverage, requestsByFile, hopByNode, maxHop,
    walkActive, ignite, hover, picked, now, reduce,
  } = s
  const dpr = window.devicePixelRatio || 1
  const W = box.w
  const H = box.h
  // Whether this paint put anything MOVING on the plate. An open request only
  // animates when its ring is actually on screen at this altitude — from
  // district height the rings are not drawn at all, so a request that has been
  // pending since yesterday must not hold the frame loop open.
  let animated = false
  if (!W || !H) return animated

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#0a0908'
  ctx.fillRect(0, 0, W, H)
  if (!geo) return animated

  const k = c.k
  const pxR = k * geo.RMAX
  const lod = lodFor(pxR)
  const toS = (wx, wy) => [(wx - c.x) * k + W / 2, (wy - c.y) * k + H / 2]

  // Warm ground under the taproot, so the plate has a light source.
  const [ox, oy] = toS(0, 0)
  const gg = ctx.createRadialGradient(ox, oy, 0, ox, oy, Math.max(pxR * 1.15, 60))
  gg.addColorStop(0, '#1c1713')
  gg.addColorStop(0.45, '#131110')
  gg.addColorStop(1, '#0a0908')
  ctx.fillStyle = gg
  ctx.fillRect(0, 0, W, H)

  ctx.setTransform(k * dpr, 0, 0, k * dpr, (W / 2 - c.x * k) * dpr, (H / 2 - c.y * k) * dpr)

  const px = (n) => n / k
  const pad = (Math.max(W, H) / k) * 0.62
  const vx0 = c.x - pad, vy0 = c.y - pad, vx1 = c.x + pad, vy1 = c.y + pad
  const inView = (x, y, m = 0) => x > vx0 - m && x < vx1 + m && y > vy0 - m && y < vy1 + m

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // ── graticule: the plate the territory is surveyed onto ──────────────────
  ctx.strokeStyle = 'rgba(212,211,203,0.05)'
  ctx.lineWidth = px(1)
  for (let i = 1; i <= 8; i += 1) {
    ctx.beginPath()
    ctx.arc(0, 0, (geo.RMAX * i) / 8, 0, TAU)
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(212,211,203,0.034)'
  const spokes = pxR > 420 ? 36 : 12
  for (let i = 0; i < spokes; i += 1) {
    const a = geo.ROT + (i / spokes) * TAU
    ctx.beginPath()
    ctx.moveTo(Math.cos(a) * geo.R0 * 0.6, Math.sin(a) * geo.R0 * 0.6)
    ctx.lineTo(Math.cos(a) * geo.RMAX * 1.03, Math.sin(a) * geo.RMAX * 1.03)
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(212,211,203,0.10)'
  ctx.lineWidth = px(1.2)
  ctx.beginPath(); ctx.arc(0, 0, geo.RFILE, 0, TAU); ctx.stroke()
  ctx.strokeStyle = 'rgba(212,211,203,0.05)'
  ctx.lineWidth = px(1)
  ctx.beginPath(); ctx.arc(0, 0, geo.RMAX * 1.03, 0, TAU); ctx.stroke()

  // ── district wedges: the choropleth you read from across the room ────────
  const nD = geo.districts.length
  const distLit = new Float32Array(nD)
  const distTot = new Float32Array(nD)
  for (let i = 0; i < geo.nLeaf; i += 1) {
    const di = geo.leafDistrict[i]
    if (di < 0) continue
    distTot[di] += 1
    if (coverage.lit[geo.leafFile[i]] > 0) distLit[di] += 1
  }
  if (lod.wedges) {
    for (let i = 0; i < nD; i += 1) {
      const d = geo.districts[i]
      if (d.depth !== lod.wedges) continue
      const frac = distTot[i] ? distLit[i] / distTot[i] : 0
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.arc(0, 0, geo.RMAX * 1.03, d.a0, d.a1, false)
      ctx.closePath()
      ctx.fillStyle = frac > 0 ? rgba(255, 116, 36, 0.028 + 0.14 * frac) : 'rgba(212,211,203,0.022)'
      ctx.fill()
      // hairline sector boundary — the ordnance-survey tell
      ctx.strokeStyle = 'rgba(212,211,203,0.075)'
      ctx.lineWidth = px(0.8)
      ctx.beginPath()
      ctx.moveTo(Math.cos(d.a0) * geo.R0 * 0.7, Math.sin(d.a0) * geo.R0 * 0.7)
      ctx.lineTo(Math.cos(d.a0) * geo.RMAX * 1.03, Math.sin(d.a0) * geo.RMAX * 1.03)
      ctx.stroke()
    }
  }

  // ── the root system, under everything it runs beneath ────────────────────
  const fil = geo.filaments
  const cap = Math.min(fil.n, lod.filCap)
  const SM = fil.samples
  for (let o = 0; o < cap; o += 1) {
    const i = fil.order[o]
    const p = fil.pts[i]
    if (!p) continue
    const ax = p[0], ay = p[1]
    const bx = p[(SM - 1) * 2], by = p[(SM - 1) * 2 + 1]
    const m = geo.RMAX * 0.12
    if (!inView(ax, ay, m) && !inView(bx, by, m) && !inView((ax + bx) / 2, (ay + by) / 2, m)) continue

    const fiS = fil.srcFile[i]
    const fiD = fil.dstFile[i]
    const hopS = hopByNode.get(String(geo.leafNode[fil.src[i]]))
    const hopD = hopByNode.get(String(geo.leafNode[fil.dst[i]]))
    const litS = coverage.lit[fiS] > 0
    const litD = coverage.lit[fiD] > 0

    // Ignition: a fresh touch bleeds outward along the roots it travelled.
    let burn = 0
    const t0 = Math.max(ignite.get(fiS) ?? -1e9, ignite.get(fiD) ?? -1e9)
    if (!reduce && now - t0 < IGNITE_MS) burn = 1 - (now - t0) / IGNITE_MS

    let stroke
    let width = px(0.65)
    if (hopS !== undefined || hopD !== undefined) {
      const [r, g0, b] = hopTint(hopS !== undefined ? hopS : hopD, maxHop || 1)
      stroke = rgba(r, g0, b, walkActive ? 0.6 : 0.3)
      width = px(1.2)
    } else if (litS && litD) {
      stroke = 'rgba(255,116,36,0.30)'
      width = px(1.0)
    } else if (litS || litD) {
      stroke = 'rgba(255,116,36,0.125)'
      width = px(0.8)
    } else {
      stroke = 'rgba(226,222,212,0.042)'
    }
    if (burn > 0) {
      const e = burn * burn
      stroke = rgba(255, 168, 96, 0.28 + 0.62 * e)
      width = px(0.9 + 2.4 * e)
    }

    ctx.strokeStyle = stroke
    ctx.lineWidth = width
    strokeRun(ctx, p, SM)
  }

  // ── the tree ─────────────────────────────────────────────────────────────
  for (let d = 1; d < geo.skeleton.length; d += 1) {
    if (d > lod.branch) break
    ctx.strokeStyle = d <= 1 ? 'rgba(233,228,216,0.24)'
      : d === 2 ? 'rgba(233,228,216,0.155)'
        : d === 3 ? 'rgba(233,228,216,0.10)'
          : 'rgba(233,228,216,0.062)'
    ctx.lineWidth = px(d <= 1 ? 2.0 : d === 2 ? 1.3 : d === 3 ? 0.85 : 0.55)
    for (const run of geo.skeleton[d]) {
      const n2 = run.length
      const m = geo.RMAX * 0.12
      if (!inView(run[0], run[1], m) && !inView(run[n2 - 2], run[n2 - 1], m)) continue
      strokeRun(ctx, run, n2 / 2)
    }
  }

  // taproot collar
  ctx.strokeStyle = 'rgba(255,116,36,0.20)'
  ctx.lineWidth = px(1.1)
  ctx.beginPath(); ctx.arc(0, 0, geo.R0 * 0.62, 0, TAU); ctx.stroke()

  if (lod.hairs) {
    ctx.strokeStyle = 'rgba(233,228,216,0.055)'
    ctx.lineWidth = px(0.45)
    const hairs = geo.hairs
    for (let i = 0; i < geo.nLeaf; i += 1) {
      const x2 = hairs[i * 4 + 2], y2 = hairs[i * 4 + 3]
      if (!inView(x2, y2, 40)) continue
      ctx.beginPath()
      ctx.moveTo(hairs[i * 4], hairs[i * 4 + 1])
      ctx.lineTo(x2, y2)
      ctx.stroke()
    }
  }

  // ── symbols on the coastline ─────────────────────────────────────────────
  if (lod.symbols) {
    for (let i = 0; i < geo.nLeaf; i += 1) {
      const x = geo.lx[i], y = geo.ly[i]
      if (!inView(x, y, 30)) continue
      const fi = geo.leafFile[i]
      const nid = String(geo.leafNode[i])
      const hop = hopByNode.get(nid)
      const explored = coverage.exploredIds?.has(nid) || coverage.lit[fi] > 0
      const t0 = ignite.get(fi)
      const burn = !reduce && t0 !== undefined && now - t0 < IGNITE_MS ? 1 - (now - t0) / IGNITE_MS : 0

      let r = px(explored ? 2.1 : 1.25)
      let fill
      if (hop !== undefined) {
        const [cr, cg, cb] = hopTint(hop, maxHop || 1)
        fill = rgba(cr, cg, cb, walkActive ? 0.95 : 0.7)
        r = px(2.6)
      } else if (explored) {
        fill = 'rgba(255,124,44,0.95)'
      } else {
        fill = 'rgba(226,222,212,0.17)'
      }
      if (burn > 0) {
        const e = burn * burn
        ctx.beginPath()
        ctx.arc(x, y, px(3 + 16 * e), 0, TAU)
        ctx.fillStyle = rgba(255, 150, 70, 0.16 * e)
        ctx.fill()
        r = px(2.1 + 2.6 * e)
      }
      ctx.beginPath()
      ctx.arc(x, y, r, 0, TAU)
      ctx.fillStyle = fill
      ctx.fill()
    }
  }

  // ── file anchors, request states, selection ──────────────────────────────
  const hoverFi = hover?.kind === 'file' ? hover.fi : null
  if (lod.fileDots) {
    for (let fi = 0; fi < geo.nFiles; fi += 1) {
      const f = geo.files[fi]
      if (!inView(f.gx, f.gy, 60)) continue
      const lit = coverage.lit[fi]
      const req = requestsByFile.get(fi)
      const st = req ? STATUS[req.status] : null
      const isPick = picked === fi
      const isHover = hoverFi === fi
      const intensity = f.count ? lit / f.count : 0
      const t0 = ignite.get(fi)
      const burn = !reduce && t0 !== undefined && now - t0 < IGNITE_MS ? 1 - (now - t0) / IGNITE_MS : 0

      if (lit > 0) {
        ctx.beginPath()
        ctx.arc(f.gx, f.gy, px(6 + 5 * intensity + 14 * burn * burn), 0, TAU)
        ctx.fillStyle = rgba(255, 116, 36, 0.05 + 0.09 * intensity + 0.22 * burn)
        ctx.fill()
      }
      ctx.beginPath()
      ctx.arc(f.gx, f.gy, px(lit ? 2.9 + 1.7 * intensity : 2.0), 0, TAU)
      ctx.fillStyle = lit ? rgba(255, 124, 44, 0.6 + 0.4 * intensity) : 'rgba(226,222,212,0.12)'
      ctx.fill()

      if (st) {
        const rr = px(9)
        if (req.status === 'pending') {
          if (!reduce) animated = true
          const pulse = reduce ? 0.7 : 0.55 + 0.45 * Math.sin(now / 340)
          ctx.setLineDash([px(4), px(3.5)])
          ctx.strokeStyle = rgba(255, 209, 102, 0.35 + 0.6 * pulse)
          ctx.lineWidth = px(1.6)
          ctx.beginPath(); ctx.arc(f.gx, f.gy, rr, 0, TAU); ctx.stroke()
          ctx.setLineDash([])
        } else if (req.status === 'claimed') {
          // a spinner: an arc chasing its own tail
          if (!reduce) animated = true
          const a0 = reduce ? 0 : (now / 260) % TAU
          ctx.strokeStyle = 'rgba(53,208,255,0.28)'
          ctx.lineWidth = px(1.4)
          ctx.beginPath(); ctx.arc(f.gx, f.gy, rr, 0, TAU); ctx.stroke()
          ctx.strokeStyle = '#35d0ff'
          ctx.lineWidth = px(2)
          ctx.beginPath(); ctx.arc(f.gx, f.gy, rr, a0, a0 + 1.5); ctx.stroke()
        } else {
          ctx.strokeStyle = 'rgba(125,219,154,0.85)'
          ctx.lineWidth = px(1.5)
          ctx.beginPath(); ctx.arc(f.gx, f.gy, rr, 0, TAU); ctx.stroke()
        }
      }
      if (isPick || isHover) {
        ctx.strokeStyle = isPick ? '#faf9f6' : 'rgba(250,249,246,0.6)'
        ctx.lineWidth = px(1.4)
        ctx.beginPath(); ctx.arc(f.gx, f.gy, px(isPick ? 12 : 9), 0, TAU); ctx.stroke()
      }
    }
  }

  // ── labels, in SCREEN space so they stay crisp at every altitude ─────────
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // A radial layout puts a lot of names very close together near the rim, and
  // overlapping type is the single fastest way to make a map look unfinished.
  // Claim a coarse screen cell per label and let the first one there keep it —
  // districts run before files, so the bigger name always wins the ground.
  const taken = new Set()
  const claim = (sx, sy, halfW) => {
    const gy = Math.round(sy / 15)
    const g0 = Math.floor((sx - halfW) / 46)
    const g1 = Math.floor((sx + halfW) / 46)
    for (let g = g0; g <= g1; g += 1) if (taken.has(g * 4096 + gy)) return false
    for (let g = g0; g <= g1; g += 1) taken.add(g * 4096 + gy)
    return true
  }

  if (lod.dLabel) {
    // Two top-level packages is not a map. Continents get the big type; the
    // districts inside them get small type, thinned by how much room they own,
    // so the plate is labelled at every altitude without ever being crowded.
    const passes = lod.minorLabels ? [1, 2] : [lod.dLabel]
    for (const want of passes) {
      const major = want === 1
      ctx.font = `500 ${major ? 13.5 : 9.5}px "Geist Mono", ui-monospace, monospace`
      const floor = major ? 6 : lod.minorLabels ? 60 : 14
      for (let i = 0; i < nD; i += 1) {
        const d = geo.districts[i]
        if (d.depth !== want || d.leaves < floor) continue
        const lr = geo.R0 + (geo.RFILE - geo.R0) * (major ? 0.26 : 0.68)
        const [sx, sy] = toS(Math.cos(d.ang) * lr, Math.sin(d.ang) * lr)
        if (sx < -40 || sx > W + 40 || sy < -12 || sy > H + 12) continue
        const frac = distTot[i] ? distLit[i] / distTot[i] : 0
        const text = major ? String(d.name).toUpperCase() : String(d.name).split('/').pop()
        if (!claim(sx, sy, ctx.measureText(text).width / 2 + 4)) continue
        ctx.lineWidth = major ? 3.5 : 2.8
        ctx.strokeStyle = 'rgba(10,9,8,0.92)'
        ctx.strokeText(text, sx, sy)
        ctx.fillStyle = frac > 0.02
          ? rgba(255, 176, 116, (major ? 0.46 : 0.34) + 0.46 * Math.min(1, frac * 2))
          : major ? 'rgba(226,222,212,0.46)' : 'rgba(226,222,212,0.30)'
        ctx.fillText(text, sx, sy)
      }
    }
  }

  if (lod.fileLabels) {
    ctx.font = '10px "Geist Mono", ui-monospace, monospace'
    let drawn = 0
    for (let fi = 0; fi < geo.nFiles && drawn < 260; fi += 1) {
      const f = geo.files[fi]
      if (f.count < 2 && pxR < 2200) continue
      const out = 1 + 15 / (f.gr || geo.RFILE)
      const [sx, sy] = toS(f.gx * out, f.gy * out)
      if (sx < 4 || sx > W - 4 || sy < 8 || sy > H - 8) continue
      if (!claim(sx, sy, ctx.measureText(f.label).width / 2 + 4)) continue
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(10,9,8,0.9)'
      ctx.strokeText(f.label, sx, sy)
      ctx.fillStyle = coverage.lit[fi] ? 'rgba(255,186,132,0.88)' : 'rgba(226,222,212,0.46)'
      ctx.fillText(f.label, sx, sy)
      drawn += 1
    }
  }

  // ── atmosphere: vignette, then grain, over everything ────────────────────
  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.18, W / 2, H / 2, Math.max(W, H) * 0.78)
  vg.addColorStop(0, 'rgba(0,0,0,0)')
  vg.addColorStop(0.62, 'rgba(8,6,5,0.20)')
  vg.addColorStop(1, 'rgba(6,4,4,0.66)')
  ctx.fillStyle = vg
  ctx.fillRect(0, 0, W, H)

  const gp = grain(ctx)
  if (gp) {
    ctx.globalAlpha = 0.055
    ctx.fillStyle = gp
    ctx.fillRect(0, 0, W, H)
    ctx.globalAlpha = 1
  }

  // ── compass rose ─────────────────────────────────────────────────────────
  ctx.font = '500 9.5px "Geist Mono", ui-monospace, monospace'
  ctx.fillStyle = 'rgba(226,222,212,0.32)'
  ctx.fillText('N', W / 2, 13)
  ctx.fillStyle = 'rgba(226,222,212,0.16)'
  ctx.fillRect(W / 2, 20, 1, 9)

  return animated
}
