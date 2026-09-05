import { Bot, Radio } from 'lucide-react'
import { useRoom } from '../lib/room.jsx'
import { idHex, key, splitQual, num, tsMs } from '../lib/util'

/**
 * Who is in the room — humans from `participant`, agents from `agent_session`.
 *
 * Both are pure subscription reads, so a second tab and a freshly started
 * agent both appear here without anyone refreshing anything. Agents are drawn
 * as squares against the humans' dots: an agent is a different kind of
 * participant and should never be mistaken for a colleague.
 */
export default function PresenceRail() {
  const { participants, agents, meta, nodeById, covState } = useRoom()
  const online = participants.filter((p) => p.online)
  const liveAgents = agents.filter((a) => a.online)

  return (
    <section className="panel p-3.5 sm:p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="micro-label">IN THE ROOM</span>
        <span className="mono text-[12px]" style={{ color: 'var(--accent)' }}>
          {online.length} human{online.length === 1 ? '' : 's'}
          {liveAgents.length ? ` · ${liveAgents.length} agent${liveAgents.length === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      {/* ── agents ─────────────────────────────────────────────────────── */}
      {agents.length > 0 ? (
        <ul className="flex lg:flex-col gap-2 mb-3 overflow-x-auto lg:overflow-visible no-scrollbar -mx-1 px-1">
          {agents.map((a) => (
            <li
              key={key(a.id)}
              className="flex items-center gap-2.5 shrink-0 lg:shrink rounded-lg px-2.5 py-2 min-w-0"
              style={{
                background: a.online ? 'rgba(14,116,144,0.10)' : 'transparent',
                border: `1px solid ${a.online ? 'rgba(14,116,144,0.32)' : 'var(--line)'}`,
              }}
            >
              <span
                className="w-6 h-6 rounded-[5px] shrink-0 flex items-center justify-center"
                style={{
                  background: a.online ? 'var(--signal-ink)' : 'rgba(22,20,19,0.15)',
                  color: 'var(--cream)',
                }}
              >
                <Bot size={13} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] leading-tight truncate max-w-[170px]" style={{ fontWeight: 600 }}>
                  {a.agentName || 'agent'}
                  <span className="micro-label ml-1.5" style={{ color: 'var(--signal-ink)' }}>AGENT</span>
                </span>
                <span className="block mono text-[11px] truncate max-w-[170px]" style={{ color: 'var(--muted)' }}>
                  {a.online ? `${num(a.touches)} touches` : 'idle'}
                  {a.session ? ` · ${String(a.session).slice(0, 6)}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div
          className="mb-3 rounded-lg px-2.5 py-2 flex items-center gap-2.5"
          style={{ border: '1px dashed var(--line)' }}
        >
          <span className="w-6 h-6 rounded-[5px] shrink-0 flex items-center justify-center" style={{ background: 'rgba(22,20,19,0.10)', color: 'var(--muted)' }}>
            <Bot size={13} />
          </span>
          <span className="micro-label">
            {covState === 'live' ? 'NO AGENT REPORTING YET' : 'AGENT FEED OFFLINE'}
          </span>
        </div>
      )}

      {participants.length === 0 && (
        <p className="text-[13px]" style={{ color: 'var(--muted)' }}>waiting for the first participant row…</p>
      )}

      {/* ── humans ─────────────────────────────────────────────────────── */}
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

      {liveAgents.length > 0 && (
        <p className="micro-label mt-3 flex items-center gap-1.5" style={{ color: 'var(--signal-ink)' }}>
          <Radio size={11} /> LAST TOUCH {agoShort(Math.max(...liveAgents.map((a) => tsMs(a.lastAt))))}
        </p>
      )}
    </section>
  )
}

function agoShort(ms) {
  if (!ms) return '—'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}S AGO`
  if (s < 3600) return `${Math.round(s / 60)}M AGO`
  return `${Math.round(s / 3600)}H AGO`
}
