import { useRoom } from '../lib/room.jsx'
import { key, tsMs } from '../lib/util'

/**
 * The agent's attention, as a tape.
 *
 * Each row is a `touch` that arrived over the subscription — one tool call,
 * one path. A second tab that never ran an agent still sees the same tape.
 */
function ago(ms) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 8) return 'now'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

export default function TouchTicker() {
  const { touches, covState } = useRoom()
  if (covState !== 'live' && touches.length === 0) return null
  if (touches.length === 0) return null

  return (
    <section className="panel overflow-hidden">
      <div className="px-4 sm:px-5 py-2.5 flex items-center gap-3">
        <span className="micro-label shrink-0">LIVE TOUCHES</span>
        <div className="flex-1 overflow-x-auto no-scrollbar">
          <ul className="flex items-center gap-2 min-w-min">
            {touches.map((t) => (
              <li
                key={key(t.id)}
                className="shrink-0 flex items-center gap-2 rounded-full px-2.5 py-1 req-row"
                style={{ background: 'rgba(255,87,26,0.08)', border: '1px solid rgba(255,87,26,0.16)' }}
              >
                <span className="micro-label" style={{ color: 'var(--accent)', letterSpacing: '0.08em' }}>
                  {String(t.tool || 'TOUCH').slice(0, 8)}
                </span>
                <span className="mono text-[11.5px] max-w-[220px] truncate">{t.path || `node ${key(t.nodeId)}`}</span>
                <span className="mono text-[10.5px]" style={{ color: 'var(--muted)' }}>{ago(tsMs(t.at))}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
