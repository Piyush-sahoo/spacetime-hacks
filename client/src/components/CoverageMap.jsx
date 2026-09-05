import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Compass, Loader2, Play } from 'lucide-react'
import { useRoom } from '../lib/room.jsx'
import { layoutTerritory } from '../lib/territory'

/**
 * THE MAP.
 *
 * Territory = the repo, drawn as a squarified treemap of files grouped into
 * package districts, area = symbol count. Two things and only two things
 * change once it is drawn:
 *
 *   colour   — dark until the agent touches a file, ember once it has
 *   outline  — a region a human has asked the agent to go and look at
 *
 * Both come straight out of the `node_cov` / `exploration_request`
 * subscriptions. There is no optimistic local state in this file, which is why
 * a second tab that clicked nothing lights up at the same instant.
 */

const BLOOM_MS = 1500

function useBox() {
  const ref = useRef(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      if (!w) return
      // Portrait on a phone, letterbox on a projector. The layout is recomputed
      // at the real pixel size rather than scaled, so cells stay square-ish.
      const h = w < 620 ? Math.min(w * 1.32, 560) : Math.max(300, Math.min(w * 0.55, 660))
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, box]
}

const STATUS_STYLE = {
  pending: { ring: 'var(--ask)', cls: 'cell-pending', label: 'REQUESTED' },
  claimed: { ring: 'var(--signal)', cls: 'cell-claimed', label: 'AGENT ON IT' },
  done: { ring: 'var(--done)', cls: 'cell-done', label: 'REPORTED BACK' },
}

export default function CoverageMap() {
  const {
    territory, coverage, requestsByFile, requestExploration, canRequest,
    covState, covError, startWalk, isMock,
  } = useRoom()

  const [ref, box] = useBox()
  const rects = useMemo(
    () => layoutTerritory(territory, box.w, box.h),
    [territory, box.w, box.h]
  )

  const [hover, setHover] = useState(null) // { fi, x, y }
  const [picked, setPicked] = useState(null) // fi
  const [flash, setFlash] = useState(null) // last requested path, for the footer

  // A region that has just lit gets a bloom. Derived from the arrival of the
  // rows themselves, so every tab blooms on the same subscription event.
  const prevLit = useRef(null)
  const [fresh, setFresh] = useState(() => new Set())
  useEffect(() => {
    const cur = coverage.lit
    const prev = prevLit.current
    prevLit.current = cur
    if (!prev || prev.length !== cur.length) return
    const added = []
    for (let i = 0; i < cur.length; i += 1) if (cur[i] > 0 && prev[i] === 0) added.push(i)
    if (!added.length) return
    setFresh((f) => { const n = new Set(f); for (const i of added) n.add(i); return n })
    const t = setTimeout(() => {
      setFresh((f) => { const n = new Set(f); for (const i of added) n.delete(i); return n })
    }, BLOOM_MS)
    return () => clearTimeout(t)
  }, [coverage])

  const onCell = useCallback((fi) => {
    const f = territory.files[fi]
    setPicked(fi)
    const dark = coverage.lit[fi] === 0
    if (!dark) return
    if (!canRequest) return
    const existing = requestsByFile.get(fi)
    if (existing && existing.status !== 'done') return
    requestExploration(f.pick, f.path)
    setFlash(f.path)
    setTimeout(() => setFlash((p) => (p === f.path ? null : p)), 3200)
  }, [territory, coverage, canRequest, requestsByFile, requestExploration])

  const detail = picked != null ? territory.files[picked] : null
  const hoverFile = hover ? territory.files[hover.fi] : null

  const litFrac = coverage.totalNodes ? coverage.exploredNodes / coverage.totalNodes : 0

  return (
    <section className="panel-dark overflow-hidden flex flex-col">
      {/* ── heading ─────────────────────────────────────────────────────── */}
      <div className="px-3.5 sm:px-5 pt-4 pb-3 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="micro-label flex items-center gap-1.5" style={{ color: 'rgba(250,249,246,0.5)' }}>
            <Compass size={12} /> AGENT COVERAGE
          </div>
          <h2 className="font-serif-display text-[24px] sm:text-[30px] leading-tight mt-1" style={{ color: 'var(--cream)' }}>
            {coverage.exploredFiles > 0
              ? <>Lit territory is what the agent has seen.</>
              : <>The whole map is dark.</>}
          </h2>
        </div>
        <Legend />
      </div>

      {/* ── the map ─────────────────────────────────────────────────────── */}
      <div className="px-2 sm:px-3 pb-2">
        <div
          ref={ref}
          className="relative w-full rounded-lg overflow-hidden select-none"
          style={{ height: box.h || 320, background: 'rgba(0,0,0,0.34)' }}
          onMouseLeave={() => setHover(null)}
        >
          {rects.map((d) => (
            <div key={d.name} className="absolute pointer-events-none" style={{ left: d.x, top: d.y, width: d.w, height: d.h }}>
              <div className="absolute inset-0 rounded-[3px]" style={{ border: '1px solid rgba(250,249,246,0.07)' }} />
              {d.labelH > 0 && (
                <div
                  className="absolute truncate"
                  style={{
                    left: 4, top: 0, width: d.w - 8, height: d.labelH,
                    fontFamily: "'Geist Mono', ui-monospace, monospace",
                    fontSize: 9, lineHeight: `${d.labelH}px`, letterSpacing: '0.1em',
                    textTransform: 'uppercase', color: 'rgba(250,249,246,0.34)',
                  }}
                >
                  {d.name}
                </div>
              )}
            </div>
          ))}

          {rects.map((d) =>
            d.cells.map((c) => {
              const fi = c.fi
              const f = territory.files[fi]
              const lit = coverage.lit[fi]
              const intensity = lit / f.count
              const req = requestsByFile.get(fi)
              const st = req ? STATUS_STYLE[req.status] : null
              const isFresh = fresh.has(fi)
              const sel = picked === fi
              const big = c.w > 5 && c.h > 5
              return (
                <button
                  key={f.mod}
                  type="button"
                  aria-label={`${f.path}, ${lit ? 'explored' : 'unexplored'}`}
                  title={`${f.path} · ${f.count} symbol${f.count === 1 ? '' : 's'} · ${lit ? `${lit} explored` : 'never looked at'}`}
                  onMouseEnter={big ? () => setHover({ fi, cx: c.x + c.w / 2, cy: c.y }) : undefined}
                  onClick={() => onCell(fi)}
                  className={`absolute rounded-[2px] transition-[background-color,box-shadow] duration-500 ${isFresh ? 'cell-bloom' : ''} ${st ? st.cls : ''}`}
                  style={{
                    left: c.x, top: c.y, width: Math.max(1, c.w - 1), height: Math.max(1, c.h - 1),
                    background: lit
                      ? `rgba(255,116,36,${0.34 + 0.58 * intensity})`
                      : 'rgba(250,249,246,0.055)',
                    boxShadow: lit ? `0 0 ${5 + 11 * intensity}px rgba(255,116,36,${0.18 + 0.3 * intensity})` : 'none',
                    outline: sel ? '1.5px solid var(--cream)' : st ? `1.5px solid ${st.ring}` : 'none',
                    outlineOffset: sel || st ? '-1px' : 0,
                    zIndex: sel || st ? 3 : 1,
                    cursor: lit ? 'default' : 'pointer',
                  }}
                />
              )
            })
          )}

          {hoverFile && (
            <div
              className="absolute pointer-events-none px-2 py-1 rounded-md hidden sm:block"
              style={{
                left: Math.min(Math.max(4, hover.cx - 90), Math.max(4, box.w - 200)),
                top: Math.max(2, hover.cy - 34),
                background: 'rgba(10,9,8,0.94)',
                border: '1px solid rgba(250,249,246,0.16)',
                zIndex: 8, maxWidth: 220,
              }}
            >
              <div className="mono text-[11px] truncate" style={{ color: 'var(--cream)' }}>{hoverFile.path}</div>
              <div className="mono text-[10px]" style={{ color: coverage.lit[hover.fi] ? 'var(--ember)' : 'rgba(250,249,246,0.45)' }}>
                {hoverFile.count} sym · {coverage.lit[hover.fi] ? `${coverage.lit[hover.fi]} explored` : 'dark — click to ask'}
              </div>
            </div>
          )}

          {covState !== 'live' && !isMock && (
            <div className="absolute inset-0 flex items-end justify-center p-3 pointer-events-none">
              <span
                className="micro-label px-3 py-1.5 rounded-full flex items-center gap-2"
                style={{ background: 'rgba(10,9,8,0.86)', color: 'rgba(250,249,246,0.66)', border: '1px solid rgba(250,249,246,0.14)' }}
              >
                <Loader2 size={11} className="spin-slow" />
                {covState === 'connecting' ? 'SUBSCRIBING TO THE COVERAGE FEED…' : 'COVERAGE FEED NOT PUBLISHED YET — MAP IS HONEST, NOT STALE'}
              </span>
            </div>
          )}
          {territory.files.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="micro-label" style={{ color: 'rgba(250,249,246,0.5)' }}>LOADING THE GRAPH…</span>
            </div>
          )}
        </div>
      </div>

      {/* ── footer: what you are pointing at ────────────────────────────── */}
      <div
        className="px-3.5 sm:px-5 py-3 flex items-center justify-between gap-3 flex-wrap"
        style={{ borderTop: '1px solid rgba(250,249,246,0.10)' }}
      >
        {flash ? (
          <span className="mono text-[12px] truncate" style={{ color: 'var(--ask)' }}>
            asked the agent to explore <strong>{flash}</strong> — every screen in this room sees it
          </span>
        ) : detail ? (
          <span className="min-w-0">
            <span className="block mono text-[12.5px] truncate" style={{ color: 'var(--cream)' }}>{detail.path}</span>
            <span className="block mono text-[11px]" style={{ color: 'rgba(250,249,246,0.5)' }}>
              {detail.count} symbol{detail.count === 1 ? '' : 's'} · {detail.tests} test{detail.tests === 1 ? '' : 's'} ·{' '}
              {coverage.lit[picked] ? `${coverage.lit[picked]} explored` : 'never looked at'}
              {requestsByFile.get(picked) ? ` · ${STATUS_STYLE[requestsByFile.get(picked).status]?.label || ''}` : ''}
            </span>
          </span>
        ) : (
          <span className="micro-label" style={{ color: 'rgba(250,249,246,0.5)' }}>
            {canRequest
              ? 'CLICK ANY DARK REGION TO ASK THE AGENT TO GO LOOK'
              : 'EACH CELL IS A FILE · AREA IS SYMBOL COUNT'}
          </span>
        )}

        <span className="flex items-center gap-3 shrink-0">
          <span className="mono text-[11.5px] whitespace-nowrap" style={{ color: 'rgba(250,249,246,0.55)' }}>
            {coverage.exploredFiles}/{coverage.totalFiles} files · {(litFrac * 100).toFixed(1)}% of symbols
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

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
      <Swatch color="rgba(250,249,246,0.09)" label="DARK" />
      <Swatch color="rgba(255,116,36,0.9)" label="EXPLORED" />
      <Swatch border="var(--ask)" dashed label="REQUESTED" />
      <Swatch border="var(--signal)" label="CLAIMED" />
      <Swatch border="var(--done)" label="DONE" />
    </div>
  )
}
