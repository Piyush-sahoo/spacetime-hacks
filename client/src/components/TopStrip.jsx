import { useRoom } from '../lib/room.jsx'

/**
 * The strip you read from the back of the room.
 *
 * Every number here comes off the subscription and therefore ticks by itself:
 * a tool call landing moves EXPLORED, a subagent spawning moves AGENTS, a click
 * on a dark block moves ASKED — in this tab and in every other one, with
 * nothing polling and nobody refreshing.
 */
export default function TopStrip({
  playing, onPlay, onStep, onRefit, onBack, onNext, canBack, canNext, cursor, steps, onLeave,
}) {
  const { repo, coverage, agents, requests, meta, sessionFilter, timeline } = useRoom()

  const live = agents.filter((a) => a.live)
  const subs = live.filter((a) => a.actorId).length
  const mains = live.length - subs
  const open = requests.filter((r) => r.status === 'pending').length
  const claimed = requests.filter((r) => r.status === 'claimed').length
  const done = requests.filter((r) => r.status === 'done').length

  const sess = sessionFilter
    ? String(sessionFilter).slice(0, 8)
    : (timeline.length ? String(timeline[timeline.length - 1].sessionKey).split('/')[0].slice(0, 8) : '—')

  const stat = (k, v, grow, opt) => (
    <div className={`stat${grow ? ' grow' : ''}${opt ? ` ${opt}` : ''}`} key={k} title={typeof k === 'string' ? k : undefined}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  )

  const conn = meta.status === 'connected' ? 'LIVE' : String(meta.status || '').toUpperCase()

  return (
    <div id="top">
      <div id="stats">
        {stat('Repo', repo?.slug || '—')}
        {stat('Session', sessionFilter ? sess : `${sess} · all`, false, 'opt2')}
        {stat('Explored', <span>{coverage.exploredFiles}<span className="dim"> / {coverage.totalFiles}</span></span>)}
        {stat('Agents', live.length ? `${mains} + ${subs} sub` : 'none connected')}
        {stat('Step', cursor == null ? `${steps} live` : `${cursor} / ${steps}`, false, 'opt')}
        {/* Three numbers, not three sentences: the strip has to survive next to
            the controls at 1440 without the last stat clipping mid-word. */}
        {stat('Asked / live / done', (
          <span>{open}<span className="dim"> / </span>{claimed}<span className="dim"> / </span>{done}</span>
        ), true)}
        {stat('Feed', <span className={meta.status === 'connected' ? 'blip' : ''}>{conn}</span>)}
      </div>
      <div id="controls">
        <button className="ctl" onClick={onBack} disabled={!canBack} title="Back one tool call">◂ Back</button>
        <button className="ctl primary" onClick={onNext} disabled={!canNext} title="Forward one tool call">Next ▸</button>
        <button className="ctl" onClick={onPlay}>{playing ? '‖ Pause' : '▸ Play'}</button>
        <button className="ctl" onClick={onStep}>Trace one step</button>
        <button className="ctl" onClick={onRefit}>Refit</button>
        {onLeave && <button className="ctl" onClick={onLeave} title="Back to the projects">&#9668; Out</button>}
      </div>
    </div>
  )
}
