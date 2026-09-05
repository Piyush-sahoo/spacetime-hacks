import { useEffect, useMemo, useRef, useState } from 'react'
import { useRoom } from '../lib/room.jsx'
import { key, num, idHex, tsMs } from '../lib/util'
import { actorLabel, slotColor, stateColour, stateOf, STATE_LABEL } from '../lib/actors'
import { blastOf, MAX_LISTED } from '../lib/blast'
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
    dirMeta, districtStats, adjacency,
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
            dirMeta={dirMeta} districtStats={districtStats} adjacency={adjacency}
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
  dirMeta, districtStats, adjacency,
}) {
  const [sent, setSent] = useState(null)

  if (!selected) {
    return (
      <>
        <h3 className="sec" style={{ marginTop: 0 }}>Nothing selected</h3>
        <p style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          Click a block on the plate for what that file does, or the dashed
          boundary around it for what the whole directory is for. A <b>dashed</b>
          block is one no agent has ever opened — click it to ask for it, and the
          request appears in every other tab immediately.
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

  // ── A DIRECTORY ──────────────────────────────────────────────────────────
  // The plate, not a block on it. "I click the blocks, I know how the block
  // works — but client/src/lib, how does that work?" is this branch.
  if (selected.kind === 'district') {
    const di = atlas.byDistrict.get(selected.name)
    if (di == null) return <p className="sub">That directory is no longer on the map.</p>
    const d = atlas.districts[di]
    const st = districtStats?.[di]
    const row = dirMeta?.get(d.name)
    // Ordered by what enrich_repo thought you would read first, so the list
    // opens on the file that actually explains the directory.
    const files = d.files
      .map((fi) => ({ fi, f: atlas.files[fi] }))
      .sort((a, b) => (Number(b.f.importance || 0) - Number(a.f.importance || 0))
        || (String(a.f.label) < String(b.f.label) ? -1 : 1))
    const withText = files.filter((x) => x.f.summary).length

    return (
      <>
        <p className="eyebrow">Directory · {d.code}</p>
        <h1 className="t">{d.name}</h1>
        <p className="sub">
          {d.count} file{d.count === 1 ? '' : 's'} · {st ? st.lit : 0} read
          {d.symbols ? ` · ${num(d.symbols)} symbols` : ''}
        </p>

        {/*
          THE SENTENCE. Written by `summarize_dirs` from the file sentences
          already in the database — no file is read twice to produce it. A
          directory nothing has summarised gets NO sentence here, and says so,
          rather than one made up on the spot.
        */}
        {row ? (
          <p style={{ fontSize: 13.5, lineHeight: 1.5, margin: '0 0 10px' }}>{row.summary}</p>
        ) : (
          <p style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 10px', color: 'var(--ink-2)' }}>
            This directory has not been summarised yet. What is in it is below —
            every sentence there was written about that file itself.
          </p>
        )}

        <h3 className="sec">
          What is in it{withText ? ` · ${withText} of ${files.length} explained` : ''}
        </h3>
        <ul className="q">
          {files.map(({ fi, f }) => {
            const b = atlas.blocks[atlas.byFile.get(fi)]
            const lit = coverage.lit[fi] > 0
            return (
              <li
                key={fi}
                style={{ cursor: b ? 'pointer' : 'default' }}
                onClick={() => { if (b) onSelect({ kind: 'block', id: b.id }) }}
                title={f.path}
              >
                <span style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <i
                    style={{
                      display: 'inline-block', width: 8, height: 8, flex: '0 0 auto',
                      border: `1px ${lit ? 'solid' : 'dashed'} var(--ink)`,
                      background: lit ? 'var(--ink-2)' : 'transparent',
                    }}
                  />
                  {f.label}
                </span>
                {f.summary ? (
                  <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--ink-2)', margin: '2px 0 0 14px' }}>
                    {f.summary}
                  </div>
                ) : (
                  <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--ink-2)', margin: '2px 0 0 14px', opacity: 0.7 }}>
                    Not read yet — no sentence for this file.
                  </div>
                )}
              </li>
            )
          })}
        </ul>

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
  const changed = !!(coverage.edited && coverage.edited[b.fi])
  const state = lit ? stateOf(coverage.at[b.fi], coverage.isNew[b.fi], stateNow, changed) : 'dark'
  const colour = lit ? stateColour(coverage.at[b.fi], coverage.isNew[b.fi], stateNow, changed) : null
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
        {changed && ' An agent has written to it — that is a fact about the file, so it stays orange however long ago it was.'}
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

      <Blast fi={b.fi} adjacency={adjacency} atlas={atlas} coverage={coverage} onSelect={onSelect} />

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

/* ── BLAST RADIUS ─────────────────────────────────────────────────────────── */

/**
 * WHAT ELSE THIS CHANGE TOUCHES.
 *
 * Read straight off the `IMPORTS` edges `enrich_repo` extracted from the real
 * import statements — the same rows the plate draws its connector lines from,
 * so the list and the drawing can never disagree.
 *
 * Every entry carries the file's OWN sentence, because "six files import this"
 * is a number and "six files, and here is what each of them is for" is an
 * answer. The list is capped and says how much it capped.
 */
function Blast({ fi, adjacency, atlas, coverage, onSelect }) {
  const r = useMemo(() => blastOf(adjacency, fi), [adjacency, fi])

  if (!r.total) {
    return (
      <>
        <h3 className="sec">Blast radius</h3>
        <p style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)' }}>
          No import edge either way. Nothing on this map reaches this file
          through an import statement, and it reaches nothing.
        </p>
      </>
    )
  }

  return (
    <>
      <h3 className="sec">Blast radius</h3>
      {r.kind === 'structural' ? (
        <>
          <p style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)', margin: '0 0 6px' }}>
            <b>Structural only</b> — this file has no import edges at all, so what
            is listed is the directory it sits in, not anything that depends on
            it. The plate draws these dotted, without arrows, for the same reason.
          </p>
          <Rel label="SAME DIRECTORY" mark="·" cls="near" list={r.near} atlas={atlas} coverage={coverage} onSelect={onSelect} />
        </>
      ) : (
        <>
          <Rel label="IMPORTS" mark="→" cls="out" list={r.out} atlas={atlas} coverage={coverage} onSelect={onSelect} />
          <Rel label="IMPORTED BY" mark="←" cls="in" list={r.in} atlas={atlas} coverage={coverage} onSelect={onSelect} />
        </>
      )}
    </>
  )
}

function Rel({ label, mark, cls, list, atlas, coverage, onSelect }) {
  const head = list.slice(0, MAX_LISTED)
  const rest = list.length - head.length
  return (
    <div style={{ margin: '0 0 8px' }}>
      <p className="eyebrow" style={{ margin: '0 0 4px' }}>
        {label} {mark} {list.length}
      </p>
      {!list.length ? (
        <p style={{ fontSize: 11.5, color: 'var(--ink-2)', margin: 0, opacity: 0.75 }}>None.</p>
      ) : (
        <ul className={`q blast ${cls}`}>
          {head.map((x) => {
            const f = atlas.files[x]
            if (!f) return null
            const bl = atlas.blocks[atlas.byFile.get(x)]
            const lit = coverage.lit[x] > 0
            return (
              <li
                key={x}
                style={{ cursor: bl ? 'pointer' : 'default' }}
                onClick={() => { if (bl) onSelect({ kind: 'block', id: bl.id }) }}
                title={f.path}
              >
                <span style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <i
                    style={{
                      display: 'inline-block', width: 8, height: 8, flex: '0 0 auto',
                      border: `1px ${lit ? 'solid' : 'dashed'} var(--ink)`,
                      background: lit ? 'var(--ink-2)' : 'transparent',
                    }}
                  />
                  {f.label}
                </span>
                <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--ink-2)', margin: '2px 0 0 14px' }}>
                  {f.summary || 'Not read yet — no sentence for this file.'}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {rest > 0 && (
        <p style={{ fontSize: 11.5, color: 'var(--ink-2)', margin: '3px 0 0' }}>+{rest} more</p>
      )}
    </div>
  )
}

/**
 * A FINDING, READ IN FIVE SECONDS.
 *
 * The agent is asked (see plugin/skills/map-room/SKILL.md) for 3-5 short lines,
 * one fact each. Those newlines are the structure and nothing between the CLI
 * and the reducer collapses them, so the only job here is to split on them and
 * show the first three, with the rest one click away.
 *
 * The hard rule is the second branch. Rows written before that instruction are
 * a single 150-word paragraph, and a paragraph has no points in it. Splitting
 * one on sentence ends would invent a structure the agent never wrote, so it is
 * clamped to three lines instead and opens in full on click. Nothing lost,
 * nothing fabricated.
 */
const HEAD = 3

function points(text) {
  const raw = String(text || '').trim()
  if (!raw) return []
  let parts
  if (raw.includes('\n')) parts = raw.split(/\n+/)
  // A bullet character is unambiguous even on one line. `- ` and `* ` are NOT:
  // prose is full of dashes, and splitting on them would shred a paragraph.
  else if (raw.includes('• ')) parts = raw.split(/\s*•\s+/)
  else return []
  return parts
    .map((p) => p.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
}

function Finding({ text }) {
  const pts = useMemo(() => points(text), [text])
  const [open, setOpen] = useState(false)

  if (pts.length < 2) {
    return (
      <p
        className={open ? 'para open' : 'para'}
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Collapse' : 'Read in full'}
      >
        {String(text).trim()}
      </p>
    )
  }

  const head = pts.slice(0, HEAD)
  const rest = pts.slice(HEAD)
  return (
    <>
      <ul className="find">
        {head.map((p, i) => <li key={i}>{p}</li>)}
      </ul>
      {rest.length > 0 && (
        <details className="more">
          <summary>{rest.length} more</summary>
          <ul className="find">
            {rest.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </details>
      )}
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
                <div>
                  <span className="eyebrow">{String(r.status).toUpperCase()}</span>
                  {r.claimedBy && idHex(r.claimedBy) ? (
                    <span style={{ fontSize: 11 }}> · {idHex(r.claimedBy).slice(0, 8)}</span>
                  ) : null}
                  <span style={{ fontSize: 11, color: 'var(--ink-2)' }}> · {ago(tsMs(r.at))}</span>
                </div>
                {r.result ? <Finding text={r.result} /> : null}
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
