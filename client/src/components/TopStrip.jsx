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
        {/*
          THREE STATS, NOT SEVEN. Where the other four went, since none of it
          is actually lost:

            SESSION  a hex fragment nobody can read, and it is already in the
                     URL. What it was really saying — am I scoped to one run —
                     is now a word beside the repo.
            STEP     the timeline rail underneath already reads LIVE · N CALLS.
            ASKED    three numbers for a queue that has its own tab, and the
                     tab carries the count.
            FEED     if the numbers are moving the feed is live; if the socket
                     drops, the legend says so and offers a retry.

          What is left is what reads from the back of a room: which repo, how
          much of it has been seen, whether anybody is working.
        */}
        {stat('Repo', (
          <span>
            {repo?.slug || '—'}
            <span className="dim"> · {sessionFilter ? 'this run' : 'all runs'}</span>
          </span>
        ))}
        {stat('Explored', <span>{coverage.exploredFiles}<span className="dim"> / {coverage.totalFiles}</span></span>)}
        {stat('Agents', live.length ? `${mains} + ${subs} sub` : 'none connected', true)}
      </div>
      <div id="controls">
        <button className="ctl" onClick={onBack} disabled={!canBack} title="Back one tool call">◂ Back</button>
        <button className="ctl primary" onClick={onNext} disabled={!canNext} title="Forward one tool call">Next ▸</button>
        {/*
          PAUSE, TRACE ONE STEP and REFIT are gone. All three drove the timeline,
          which has its own scrubber directly below the map — three buttons up
          here for a control that is already down there, competing with the two
          that actually move you through the run.
        */}
        {onLeave && <button className="ctl" onClick={onLeave} title="Back to the projects">&#9668; Out</button>}
      </div>
    </div>
  )
}
