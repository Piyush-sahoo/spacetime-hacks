import { useEffect, useMemo, useRef, useState } from 'react'
import { useRoom } from '../lib/room.jsx'
import { key, num, idHex, tsMs } from '../lib/util'
import { actorLabel, slotColor, stateColour, stateOf, STATE_LABEL } from '../lib/actors'
import NodeList from './NodeList.jsx'
import WalkView from './WalkView.jsx'
import Verdict from './Verdict.jsx'

/**
 * THE READING PANEL — and, in its first tab, THE PROOF.
 *
 * ACTIVITY is not a decoration. It is the one surface where "SpacetimeDB is
 * real-time" is either true or visibly false: every tool call any agent makes
 * anywhere lands here, in order, in every open tab, with nothing polling and
 * nobody refreshing. So it is the DEFAULT tab, it holds hundreds of rows rather
 * than a ticker's worth, it flashes on arrival, and its ages tick.
 *
 * The step number is the DEPTH of the call within its own route — the ordering
 * recovered from the server's monotonic `touch.id`, not from any clock.
 */

const FRESH_MS = 1400
// The tape, not a ticker. The old strip capped at 28 and scrolled sideways,
// which made a busy agent look idle. This scrolls, and holds a real run.
const SHOW = 300

function ago(ms) {
  if (!ms) return '—'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 2) return 'now'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

export default function RightPanel({
  tab, onTab, selected, onSelect, onPickStep, cursor,
}) {
  const {
    touches, timeline, atlas, territory, coverage, requests, requestsByFile,
    requestExploration, canRequest, actors, covState, sessionFilter, walk,
  } = useRoom()

  // Ages must tick, or a live feed reads as a screenshot. One interval, one
  // component — the canvas never re-renders for it.
  const [, setBeat] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setBeat((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  // ARRIVAL. A row is `fresh` for its first 1.4s on screen — the flash is how
  // you see a call land from across a room. Rows already present at mount are
  // history and never flash.
  const seen = useRef(null)
  const rows = useMemo(() => touches.slice(0, SHOW), [touches])
  if (seen.current === null) {
    seen.current = new Map()
    for (const s of rows) seen.current.set(s.id, 0)
  }
  const now = Date.now()
  for (const s of rows) if (!seen.current.has(s.id)) seen.current.set(s.id, now)

  const openAsks = requests.filter((r) => r.status !== 'done').length

  return (
    <section id="panel" aria-label="Detail">
      <div id="tabs" role="tablist">
        <Tab id="activity" tab={tab} onTab={onTab}>
          Activity{timeline.length ? ` ${timeline.length}` : ''}
        </Tab>
        <Tab id="what" tab={tab} onTab={onTab}>What it does</Tab>
        <Tab id="asked" tab={tab} onTab={onTab}>Asked{openAsks ? ` ${openAsks}` : ''}</Tab>
        <Tab id="walk" tab={tab} onTab={onTab}>Impact walk</Tab>
      </div>

      <div id="body" className="thin-scroll">
        {tab === 'activity' && (
          <Activity
            rows={rows} seen={seen.current} selected={selected}
            onPickStep={onPickStep} cursor={cursor} covState={covState}
            sessionFilter={sessionFilter} actors={actors}
          />
        )}

        {tab === 'what' && (
          <What
            selected={selected} atlas={atlas} territory={territory} coverage={coverage}
            requestsByFile={requestsByFile} requestExploration={requestExploration}
            canRequest={canRequest} onSelect={onSelect}
          />
        )}

        {tab === 'asked' && <Asked requests={requests} territory={territory} />}

        {tab === 'walk' && (
          <div className="space-y-4">
            <p className="eyebrow">The measurement</p>
            <p style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              A bounded backwards walk from one symbol, k=6, run on the server and
              painted from the subscription. This is the part with a number on it.
            </p>
            <NodeList />
            <WalkView />
            {walk && <Verdict />}
          </div>
        )}
      </div>
    </section>
  )
}

function Tab({ id, tab, onTab, children }) {
  return (
    <button
      role="tab"
      aria-selected={tab === id}
      className={tab === id ? 'on' : ''}
      onClick={() => onTab(id)}
    >
      {children}
    </button>
  )
}

/* ── ACTIVITY ─────────────────────────────────────────────────────────────── */

function Activity({ rows, seen, selected, onPickStep, cursor, covState, sessionFilter, actors }) {
  const now = Date.now()
  const selId = selected && selected.kind === 'step' ? selected.id : null

  return (
    <>
      <h3 className="sec" style={{ marginTop: 0 }}>
        {sessionFilter ? 'This session · every tool call' : 'Every tool call, as it lands'}
      </h3>

      {!rows.length ? (
        <p className="sub" style={{ marginTop: 8 }}>
          {covState === 'live'
            ? 'Nothing yet. Start a Claude Code session in this repo and every Read, Edit and Grep it makes appears here within a second — in this tab and in every other one.'
            : 'Waiting for the coverage feed…'}
        </p>
      ) : (
        <ul className="feed">
          {rows.map((s) => {
            const at = seen.get(s.id) || 0
            const fresh = at && now - at < FRESH_MS
            const dim = cursor != null && s.k > cursor
            return (
              <li
                key={s.id}
                className={`${selId === s.id ? 'on' : ''}${fresh ? ' fresh' : ''}`}
                style={dim ? { opacity: 0.35 } : undefined}
                onClick={() => onPickStep(s)}
                title={`${s.tool} · step ${s.n}${s.actor ? ` · ${actorLabel(s.actor)}` : ''}`}
              >
                <span className="no">{s.n}</span>
                <span
                  className="sw"
                  style={{ background: s.colour || 'var(--paper-2)' }}
                  title={s.colour ? (s.actor ? actorLabel(s.actor) : 'main agent') : 'no live session'}
                />
                <span className="pt">{s.path || `node ${s.nodeId}`}</span>
                <span className="meta">
                  <span className="tl">{s.tool}</span>
                  <span className="ago">{ago(s.at)}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {actors.length > 0 && (
        <>
          <h3 className="sec">Live right now</h3>
          {actors.map((a) => (
            <span className="chip static" key={a.actorId || 'main'}>
              <i
                style={{
                  display: 'inline-block', width: 8, height: 8, marginRight: 5,
                  border: '1px solid var(--ink)', background: a.color || 'var(--paper-2)',
                }}
              />
              {a.actorId ? actorLabel(a.actorId) : (a.name || 'main agent')} · {num(a.touches)}
            </span>
          ))}
        </>
      )}
    </>
  )
}

/* ── WHAT IT DOES ─────────────────────────────────────────────────────────── */

function What({
  selected, atlas, territory, coverage, requestsByFile, requestExploration, canRequest, onSelect,
}) {
  const [sent, setSent] = useState(null)

  if (!selected) {
    return (
      <>
        <h3 className="sec" style={{ marginTop: 0 }}>Nothing selected</h3>
        <p style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          Click a block on the plate, or a row in the index. A <b>dashed</b> block is
          one no agent has ever opened — click it to ask for it, and the request
          appears in every other tab immediately.
        </p>
      </>
    )
  }

  if (selected.kind === 'step') {
    return (
      <>
        <p className="eyebrow">Tool call · step {selected.step?.n}</p>
        <h1 className="t">{selected.step?.tool}</h1>
        <p className="sub">{selected.step?.path}</p>
        <p style={{ fontSize: 12.5 }}>
          {selected.step?.actor
            ? `Made by subagent ${actorLabel(selected.step.actor)}.`
            : 'Made by the main agent.'}{' '}
          Row {selected.step?.id} on the server, which is what puts it at this
          point in the route rather than at any other.
        </p>
        <div className="actions">
          <button className="ctl" onClick={() => onSelect(null)}>Clear</button>
        </div>
      </>
    )
  }

  const bi = atlas.blocks.findIndex((b) => b.id === selected.id)
  const db = bi < 0 ? atlas.dblocks.find((b) => b.id === selected.id) : null
  const b = bi >= 0 ? atlas.blocks[bi] : db
  if (!b) return <p className="sub">That block is no longer on the plate.</p>

  // A district block stands for a whole directory; a file block for one file.
  if (db) {
    const d = atlas.districts[db.di]
    let lit = 0
    for (const fi of d.files) if (coverage.lit[fi] > 0) lit += 1
    return (
      <>
        <p className="eyebrow">Directory · {d.code}</p>
        <h1 className="t">{d.name}</h1>
        <p className="sub">{d.count} files · {num(d.symbols)} symbols · {lit} explored</p>
        <p style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          Too many files in this repo to stand one block each, so this district is
          drawn whole. Open it in the index to see inside; the coordinates do not
          change, so nothing teleports on the way in.
        </p>
      </>
    )
  }

  const f = atlas.files[b.fi]
  const lit = coverage.lit[b.fi]
  const dark = lit === 0
  const req = requestsByFile.get(b.fi)
  const open = req && req.status !== 'done'
  // WHEN it was last touched, and WHO touched it — two facts, two channels,
  // exactly as the plate draws them.
  const stateNow = Date.now()
  const state = lit ? stateOf(coverage.at[b.fi], coverage.isNew[b.fi], stateNow) : 'dark'
  const colour = lit ? stateColour(coverage.at[b.fi], coverage.isNew[b.fi], stateNow) : null
  const edge = lit ? slotColor(coverage.slot[b.fi]) : null
  const sym = Number(f.symbols || 0)

  return (
    <>
      <p className="eyebrow">{dark ? 'Never opened' : 'Explored'} · {b.code} {b.district}</p>
      <h1 className="t">{f.label}</h1>
      <p className="sub">{f.path}</p>

      {/*
        WHAT IT DOES leads with what the file DOES. Everything under it is
        provenance — how much of it has been opened and when — which is the
        answer to a different question and was previously the only answer on
        offer. The sentence comes from `enrich_repo`; a file that has not been
        enriched simply has no line here rather than a fabricated one.
      */}
      {f.summary && (
        <p style={{ fontSize: 13.5, lineHeight: 1.5, margin: '0 0 10px' }}>{f.summary}</p>
      )}

      <p style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)' }}>
        {/* `symbols` is the regex-measured count of functions and classes.
            `count` is how many graph nodes the file owns, which for an indexed
            repo is always 1 — saying "1 of 1 symbol" about a 118-function file
            was true of the graph and nonsense about the file. */}
        {sym > 0 && <>{sym} function{sym === 1 ? '' : 's'}{f.loc ? ` · ${f.loc} lines` : ''}. </>}
        {dark
          ? 'No agent has opened it. That is why it is drawn dashed.'
          : `Last opened with ${coverage.tool[b.fi] || 'a tool call'} ${ago(coverage.at[b.fi])} ago.`}
      </p>

      {!dark && (
        <p style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 7 }}>
          <span
            style={{
              display: 'inline-block', width: 11, height: 11, flex: '0 0 auto',
              background: colour || 'var(--paper-2)',
              border: `2px solid ${edge || 'var(--ink)'}`,
            }}
          />
          {STATE_LABEL[state].replace(/^./, (c) => c.toUpperCase())}
          {state === 'live' ? ' — the fill is green while somebody is standing here, and cools to red over five minutes.' : '.'}
        </p>
      )}

      <div className="actions">
        {dark && canRequest && !open && (
          <button
            className="ctl primary"
            onClick={() => {
              requestExploration(f.pick, f.path)
              setSent(f.path)
              setTimeout(() => setSent((p) => (p === f.path ? null : p)), 3200)
            }}
          >
            Ask for this region
          </button>
        )}
        {open && <span className="chip static">{String(req.status).toUpperCase()}</span>}
        {sent === f.path && <span className="chip static">SENT</span>}
        <button className="ctl" onClick={() => onSelect(null)}>Clear</button>
      </div>
    </>
  )
}

/* ── ASKED ────────────────────────────────────────────────────────────────── */

function Asked({ requests, territory }) {
  if (!requests.length) {
    return (
      <>
        <h3 className="sec" style={{ marginTop: 0 }}>Nothing asked yet</h3>
        <p style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          Click a dashed block to put a region on this queue. Anyone watching the
          map sees it appear; an agent claims it, explores it, and the region
          comes back lit.
        </p>
      </>
    )
  }
  return (
    <>
      <h3 className="sec" style={{ marginTop: 0 }}>The return path</h3>
      <ul className="q">
        {requests.map((r) => {
          const fi = territory.byNode.get(key(r.nodeId))
          const f = fi === undefined ? null : territory.files[fi]
          const cls = r.status === 'done' ? 'res' : r.status === 'claimed' ? 'to' : ''
          return (
            <li key={key(r.id)} className={cls}>
              <span style={{ fontSize: 12.5 }}>{f ? f.path : `node ${key(r.nodeId)}`}</span>
              {/*
                `r.note` was the path again, so every row printed its own title
                twice — and the stored copy was written by the old path guesser,
                so a .jsx file read back as .py forever. What is worth a line
                here is what the region DOES, which is the thing somebody is
                deciding whether to send an agent to.
              */}
              {f && f.summary ? (
                <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--ink-2)', margin: '2px 0 0' }}>
                  {f.summary}
                </div>
              ) : null}
              <div className="ans">
                <span className="eyebrow">{String(r.status).toUpperCase()}</span>
                {r.result ? <span style={{ fontSize: 11.5 }}> · {r.result}</span> : null}
                {r.claimedBy && idHex(r.claimedBy) ? (
                  <span style={{ fontSize: 11 }}> · {idHex(r.claimedBy).slice(0, 8)}</span>
                ) : null}
                <span style={{ fontSize: 11, color: 'var(--ink-2)' }}> · {ago(tsMs(r.at))}</span>
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
