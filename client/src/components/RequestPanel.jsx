import { HelpCircle, Loader2, CheckCircle2, Hand } from 'lucide-react'
import { useRoom } from '../lib/room.jsx'
import { key, idHex, tsMs } from '../lib/util'
import { prettyPath, moduleOf } from '../lib/territory'

/**
 * The return path, as a queue.
 *
 * pending -> claimed -> done are three visually distinct states and every one
 * of them arrives over the `exploration_request` subscription. Nothing in here
 * is written locally, so the tab that asked and the tab that only watched flip
 * through the states together.
 */

const STATE = {
  pending: {
    icon: HelpCircle,
    label: 'ASKED',
    colour: 'var(--ask-ink)',
    bg: 'rgba(214,158,46,0.12)',
    ring: 'rgba(214,158,46,0.55)',
    blurb: 'waiting for an agent to pick it up',
  },
  claimed: {
    icon: Loader2,
    label: 'EXPLORING',
    colour: 'var(--signal-ink)',
    bg: 'rgba(14,116,144,0.12)',
    ring: 'rgba(14,116,144,0.5)',
    blurb: 'a subagent is in there now',
  },
  done: {
    icon: CheckCircle2,
    label: 'REPORTED',
    colour: 'var(--good)',
    bg: 'rgba(47,107,70,0.12)',
    ring: 'rgba(47,107,70,0.45)',
    blurb: 'the region came back lit',
  },
}

function ago(ms) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export default function RequestPanel() {
  const { requests, participants, meta, canRequest, covState } = useRoom()

  const counts = requests.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a }, {})

  return (
    <section className="panel flex flex-col overflow-hidden">
      <div className="p-3.5 sm:p-4 pb-3 border-b" style={{ borderColor: 'var(--line)' }}>
        <div className="flex items-center justify-between gap-2">
          <span className="micro-label flex items-center gap-1.5"><Hand size={12} /> HUMAN REQUESTS</span>
          <span className="mono text-[11px]" style={{ color: 'var(--muted)' }}>
            {counts.pending || 0} asked · {counts.claimed || 0} live · {counts.done || 0} done
          </span>
        </div>
        <p className="text-[12.5px] mt-1.5" style={{ color: 'var(--ink-soft)' }}>
          A dark region someone pointed at. The agent reads this queue on its next turn.
        </p>
      </div>

      <ul className="overflow-y-auto thin-scroll" style={{ maxHeight: '38vh' }}>
        {requests.length === 0 && (
          <li className="px-4 py-5 text-[13px]" style={{ color: 'var(--muted)' }}>
            {covState === 'live'
              ? canRequest
                ? 'Nothing asked for yet. Click a dark region on the map.'
                : 'request_exploration is not published yet.'
              : 'waiting for the coverage feed…'}
          </li>
        )}
        {requests.map((r) => {
          const s = STATE[r.status] || STATE.pending
          const Icon = s.icon
          const who = participants.find((p) => idHex(p.identity) === idHex(r.askedBy))
          const mine = idHex(r.askedBy) === meta.identity
          const path = r.path || prettyPath(moduleOf(''))
          return (
            <li
              key={key(r.id)}
              className="px-3.5 sm:px-4 py-3 flex items-start gap-3 req-row"
              style={{ borderBottom: '1px solid var(--line)', background: s.bg }}
            >
              <span
                className="shrink-0 mt-0.5 w-6 h-6 rounded-full flex items-center justify-center"
                style={{ border: `1.5px solid ${s.ring}`, color: s.colour }}
              >
                <Icon size={12} className={r.status === 'claimed' ? 'spin-slow' : ''} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 flex-wrap">
                  <span className="micro-label" style={{ color: s.colour, letterSpacing: '0.1em' }}>{s.label}</span>
                  <span className="mono text-[10.5px]" style={{ color: 'var(--muted)' }}>{ago(tsMs(r.at))}</span>
                </span>
                <span className="block mono text-[12.5px] truncate mt-0.5">{path || r.note || `node ${key(r.nodeId)}`}</span>
                <span className="block text-[11.5px] mt-0.5" style={{ color: 'var(--ink-soft)' }}>
                  {r.status === 'done' && r.result
                    ? r.result
                    : r.status === 'claimed' && r.claimedBy
                      ? `claimed by ${r.claimedBy}`
                      : s.blurb}
                </span>
                <span className="block micro-label mt-1">
                  ASKED BY {mine ? 'YOU' : (who?.name || 'someone in the room').toUpperCase()}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
