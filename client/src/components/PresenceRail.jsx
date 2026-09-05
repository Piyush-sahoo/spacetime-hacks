import { Bot, Radio } from 'lucide-react'
import { useRoom } from '../lib/room.jsx'
import { idHex, key, splitQual, num, tsMs } from '../lib/util'
import { actorLabel, MAIN_COLOR } from '../lib/actors'

/**
 * Who is in the room — humans from `participant`, agents from `agent_session`.
 *
 * Both are pure subscription reads, so a second tab and a freshly started
 * agent both appear here without anyone refreshing anything. Agents are drawn
 * as squares against the humans' dots: an agent is a different kind of
 * participant and should never be mistaken for a colleague.
 */
// Agent sessions accumulate for the life of the module — every heartbeat from
// every run leaves a row. The rail is about who is working NOW, so it shows the
// live ones and counts the rest rather than growing without bound on stage.
// Main agent plus up to four coloured subagents is the whole colour key; past
// that the rail counts the tail rather than growing a wall of near-identical
// rows nobody can read from the back of the room.
const AGENT_CAP = 5
// Same for humans: a demo room collects guests all afternoon and the rail is
// not a guest book.
const HUMAN_CAP = 8

export default function PresenceRail() {
  const { participants, agents, meta, nodeById, covState } = useRoom()
  const online = participants.filter((p) => p.online)
  const liveAgents = agents.filter((a) => a.live)
  // NO FALLBACK. There used to be a `liveAgents.length ? liveAgents : agents`
  // here so the rail was never empty; what it actually did was resurrect
  // sessions that ended hours ago and paint them in live colours. An empty rail
  // is the correct drawing of a room with nobody working in it.
  const shownAgents = liveAgents.slice(0, AGENT_CAP)
  const otherAgents = liveAgents.length - shownAgents.length
  const liveSubs = liveAgents.filter((a) => a.actorId).length
  const shownHumans = participants.slice(0, HUMAN_CAP)
  const otherHumans = participants.length - shownHumans.length

  return (
    <section className="panel p-3.5 sm:p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="micro-label">IN THE ROOM</span>
        <span className="mono text-[11.5px] whitespace-nowrap" style={{ color: 'var(--accent)' }}>
          {online.length}&nbsp;human{online.length === 1 ? '' : 's'}
          {liveAgents.length ? ` · ${liveAgents.length}\u00a0agent${liveAgents.length === 1 ? '' : 's'}` : ''}
          {liveSubs ? ` (${liveSubs}\u00a0sub)` : ''}
        </span>
      </div>

      {/* ── agents ─────────────────────────────────────────────────────── */}
      {liveAgents.length > 0 ? (
        <ul className="flex lg:flex-col gap-2 mb-3 overflow-x-auto lg:overflow-visible no-scrollbar -mx-1 px-1">
          {shownAgents.map((a) => {
            const sub = !!a.actorId
            const colour = a.color || MAIN_COLOR
            return (
              <li
                key={key(a.id)}
                className="flex items-center gap-2.5 shrink-0 lg:shrink rounded-lg px-2.5 py-2 min-w-0"
                style={{
                  // A subagent is indented under the session it inherited, so
                  // the rail reads as the tree the run actually was.
                  marginLeft: sub ? 14 : 0,
                  background: a.live ? `${colour}1a` : 'transparent',
                  border: `1px solid ${a.live ? `${colour}55` : 'var(--line)'}`,
                }}
              >
                <span
                  className="w-6 h-6 rounded-[5px] shrink-0 flex items-center justify-center"
                  style={{ background: a.live ? colour : 'rgba(22,20,19,0.15)', color: '#0a0908' }}
                >
                  <Bot size={13} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] leading-tight truncate max-w-[170px]" style={{ fontWeight: 600 }}>
                    {sub ? actorLabel(a.actorId) : (a.agentName || 'agent')}
                    <span className="micro-label ml-1.5" style={{ color: colour }}>
                      {sub ? 'SUBAGENT' : 'AGENT'}
                    </span>
                  </span>
                  <span className="block mono text-[11px] truncate max-w-[170px]" style={{ color: 'var(--muted)' }}>
                    {a.live ? `${num(a.touches)} touches` : `idle · ${num(a.touches)} touches`}
                    {a.parentSession ? ` · ${String(a.parentSession).slice(0, 6)}` : ''}
                  </span>
                </span>
              </li>
            )
          })}
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
            {covState === 'live' ? (agents.length ? 'NO AGENT CONNECTED NOW' : 'NO AGENT REPORTING YET') : 'AGENT FEED OFFLINE'}
          </span>
        </div>
      )}

      {otherAgents > 0 && (
        <p className="micro-label -mt-1 mb-3">+{otherAgents} MORE AGENT SESSION{otherAgents === 1 ? '' : 'S'}</p>
      )}

      {participants.length === 0 && (
        <p className="text-[13px]" style={{ color: 'var(--muted)' }}>waiting for the first participant row…</p>
      )}

      {/* ── humans ─────────────────────────────────────────────────────── */}
      <ul className="flex lg:flex-col gap-2 overflow-x-auto lg:overflow-visible no-scrollbar -mx-1 px-1">
        {shownHumans.map((p) => {
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

      {otherHumans > 0 && (
        <p className="micro-label mt-2">+{otherHumans} MORE</p>
      )}

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
