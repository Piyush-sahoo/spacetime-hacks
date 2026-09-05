import { useEffect, useMemo, useRef } from 'react'
import { CornerUpLeft, Eye, MousePointerClick } from 'lucide-react'
import { useRoom } from '../lib/room.jsx'
import { key, splitQual, idHex } from '../lib/util'
import { WALK_K } from '../lib/config'

/**
 * THE MONEY SHOT.
 *
 * Every pixel below is a function of `walk` + `frontier` rows, which only ever
 * arrive over the subscription. There is no local animation state and no
 * optimistic write anywhere in this file — that is precisely why a second tab
 * that clicked nothing paints the identical walk at the identical moment.
 */
export default function WalkView() {
  const { walk, frontier, nodeById, participants, meta, amDriver } = useRoom()
  const laneRef = useRef(null)

  const hops = useMemo(() => {
    const by = new Map()
    for (const f of frontier) {
      const h = Number(f.hop)
      if (!by.has(h)) by.set(h, [])
      by.get(h).push(f)
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0])
  }, [frontier])

  // keep the newest hop in view as it paints
  useEffect(() => {
    const el = laneRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [hops.length, frontier.length])

  if (!walk) {
    return (
      <section className="panel p-6 sm:p-8 flex flex-col items-center justify-center text-center gap-3 min-h-[220px]">
        <MousePointerClick size={22} style={{ color: 'var(--accent)' }} />
        <p className="font-serif-display text-[24px] leading-tight">Pick a changed file.</p>
        <p className="text-[13.5px] max-w-sm" style={{ color: 'var(--ink-soft)' }}>
          A bounded <span className="mono">k={WALK_K}</span> backwards walk runs over the call graph —
          predecessors only, because production code has no edge to the test that guards it.
          It paints here, hop by hop, on every screen in this room.
        </p>
      </section>
    )
  }

  const k = Number(walk.k) || WALK_K
  const hop = Number(walk.hop)
  const starter = participants.find((p) => idHex(p.identity) === idHex(walk.startedBy))
  const origin = nodeById(walk.origin)
  const pctDone = Math.min(100, ((walk.done ? k : hop) / k) * 100)

  return (
    <section className="panel overflow-hidden flex flex-col min-h-0">
      <div className="p-3.5 sm:p-4 border-b" style={{ borderColor: 'var(--line)' }}>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
          <span className="micro-label flex items-center gap-1.5">
            <CornerUpLeft size={12} /> BACKWARDS WALK · PREDECESSORS
          </span>
          {walk.done ? (
            <span className="micro-label" style={{ color: 'var(--ink)' }}>
              EXHAUSTED · {walk.graphComplete ? 'GRAPH COMPLETE' : `HIT k=${k}`}
            </span>
          ) : amDriver ? (
            <span className="micro-label" style={{ color: 'var(--accent)' }}>STEPPING…</span>
          ) : (
            <span className="micro-label flex items-center gap-1.5" style={{ color: 'var(--accent)' }}>
              <Eye size={12} /> WATCHING {starter?.name || 'someone'}
            </span>
          )}
        </div>

        <p className="mono text-[13px] truncate">
          {origin ? splitQual(origin.qual, origin.name).symbol : `node ${key(walk.origin)}`}
        </p>
        <p className="mono text-[11px] truncate" style={{ color: 'var(--muted)' }}>
          {origin ? splitQual(origin.qual, origin.name).path : 'resolving origin…'}
        </p>

        <div className="mt-3 flex items-center gap-3">
          <div className="relative flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(22,20,19,0.10)' }}>
            <div
              className={`h-full rounded-full transition-all duration-300 ${!walk.done ? 'sweep relative' : ''}`}
              style={{ width: `${pctDone}%`, background: 'var(--accent)' }}
            />
          </div>
          <span className="mono text-[11.5px] whitespace-nowrap" style={{ color: 'var(--muted)' }}>
            hop {hop}/{k} · {Number(walk.selected)} reached
          </span>
        </div>
      </div>

      <div ref={laneRef} className="flex-1 overflow-y-auto thin-scroll p-3.5 sm:p-4 space-y-3 min-h-0" style={{ maxHeight: '44vh' }}>
        {hops.map(([h, rows]) => {
          const live = !walk.done && h === hop
          return (
            <div key={h} className="hop-cell" style={{ animationDelay: '0ms' }}>
              <div className="flex items-center gap-2 mb-1.5">
                <span
                  className={`mono text-[11px] px-2 py-0.5 rounded-full ${live ? 'hop-live' : ''}`}
                  style={{
                    background: live ? 'var(--accent)' : 'rgba(22,20,19,0.08)',
                    color: live ? 'var(--cream)' : 'var(--ink-soft)',
                  }}
                >
                  hop {h}
                </span>
                <span className="micro-label">{rows.length} NODE{rows.length === 1 ? '' : 'S'}</span>
                <span className="flex-1 h-px" style={{ background: 'var(--line)' }} />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {rows.map((f, i) => {
                  const n = nodeById(f.nodeId)
                  const label = n ? splitQual(n.qual, n.name).symbol : `#${key(f.nodeId)}`
                  return (
                    <span
                      key={key(f.id)}
                      className="hop-cell mono text-[11.5px] px-2 py-1 rounded-md max-w-full truncate"
                      title={n?.qual || ''}
                      style={{
                        animationDelay: `${Math.min(i, 12) * 22}ms`,
                        background: f.isTest ? 'rgba(192,38,24,0.10)' : 'rgba(250,249,246,0.75)',
                        border: `1px solid ${f.isTest ? 'rgba(192,38,24,0.45)' : 'var(--line)'}`,
                        color: f.isTest ? 'var(--danger)' : 'var(--ink)',
                      }}
                    >
                      {f.isTest && <span className="micro-label mr-1" style={{ color: 'var(--danger)' }}>TEST</span>}
                      {label}
                    </span>
                  )
                })}
                {rows.length === 0 && <span className="micro-label">FRONTIER EMPTY</span>}
              </div>
            </div>
          )
        })}
        {hops.length === 0 && <p className="micro-label">SEEDING HOP 0…</p>}
      </div>
    </section>
  )
}
