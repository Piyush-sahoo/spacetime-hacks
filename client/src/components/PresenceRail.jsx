import { useRoom } from '../lib/room.jsx'
import { idHex, key, splitQual } from '../lib/util'

/**
 * Every `participant` row, live. Driven purely by the participant subscription
 * (identity_connected / identity_disconnected flip `online` server-side), so a
 * second tab shows up here without anyone refreshing anything.
 */
export default function PresenceRail() {
  const { participants, meta, nodeById } = useRoom()
  const online = participants.filter((p) => p.online)

  return (
    <section className="panel p-3.5 sm:p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="micro-label">IN THE ROOM</span>
        <span className="mono text-[12px]" style={{ color: 'var(--accent)' }}>{online.length} online</span>
      </div>

      {participants.length === 0 && (
        <p className="text-[13px]" style={{ color: 'var(--muted)' }}>waiting for the first participant row…</p>
      )}

      <ul className="flex lg:flex-col gap-2 overflow-x-auto lg:overflow-visible no-scrollbar -mx-1 px-1">
        {participants.map((p) => {
          const hex = idHex(p.identity)
          const me = hex === meta.identity
          const focus = p.focusNode && key(p.focusNode) !== '0' ? nodeById(p.focusNode) : null
          return (
            <li
              key={hex}
              className="flex items-center gap-2.5 shrink-0 lg:shrink rounded-lg px-2.5 py-2 min-w-0"
              style={{ background: me ? 'rgba(255,87,26,0.08)' : 'transparent' }}
            >
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${p.online ? 'status-dot' : ''}`}
                style={{ background: p.online ? 'var(--accent)' : 'rgba(22,20,19,0.22)' }}
              />
              <span className="min-w-0">
                <span className="block text-[13.5px] leading-tight truncate max-w-[180px]" style={{ fontWeight: me ? 600 : 400 }}>
                  {p.name || 'guest'}{me && <span className="micro-label ml-1.5">YOU</span>}
                </span>
                {focus && (
                  <span className="block mono text-[11px] truncate max-w-[180px]" style={{ color: 'var(--muted)' }}>
                    ↳ {splitQual(focus.qual, focus.name).symbol}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
