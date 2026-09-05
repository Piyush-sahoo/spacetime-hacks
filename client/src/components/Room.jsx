import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRoom } from '../lib/room.jsx'
import { actorLabel, STATE_LIVE, STATE_COLD, STATE_NEW } from '../lib/actors'
import Atlas from './Atlas.jsx'
import TopStrip from './TopStrip.jsx'
import LeftIndex from './LeftIndex.jsx'
import RightPanel from './RightPanel.jsx'
import HintBar from './HintBar.jsx'

/**
 * THE MAP ROOM — one repo, one plate, one route.
 *
 * A 3x3 shell and nothing else: the strip of live counters across the top, the
 * directory index down the left, the isometric plate in the middle, the reading
 * panel on the right, the key line along the bottom. Everything in all five
 * regions is painted from the same SpacetimeDB subscription, so a tool call made
 * by an agent on someone else's machine moves the counters, lights a block,
 * extends the route and prepends a row to ACTIVITY — in this tab and in every
 * other open tab — with nothing polling and nobody refreshing.
 *
 * `Graph.jsx` and `dag.js` are no longer imported. They stay on disk.
 */
export default function Room({ onLeave }) {
  const {
    atlas, timeline, coverage, territory, requestsByFile, requestExploration,
    canRequest, actors, meta, isMock, retry, toggleDistrict,
  } = useRoom()

  const atlasRef = useRef(null)
  const [scope, setScope] = useState(null)
  const [selected, setSelected] = useState(null)
  const [tab, setTab] = useState('activity')
  const [playing, setPlaying] = useState(true)
  // null means LIVE — the map shows everything that has arrived. A number means
  // the timeline is being scrubbed and blocks lit after that step go dark again.
  const [cursor, setCursor] = useState(null)

  // The same scene the canvas cuts, recomputed here for the keyboard. Pure
  // function of the atlas and the scope, so it can never disagree with what is
  // drawn — and it reads no coverage, so it cannot move anything.
  const sceneBlocks = useMemo(() => {
    if (scope && atlas.byDistrict.has(scope)) {
      const d = atlas.districts[atlas.byDistrict.get(scope)]
      return d.files.map((fi) => atlas.blocks[atlas.byFile.get(fi)])
    }
    return atlas.full ? atlas.blocks : atlas.dblocks
  }, [atlas, scope])

  // ── selection ─────────────────────────────────────────────────────────────
  const pickBlock = useCallback((id, opts) => {
    const ask = !!(opts && opts.ask)
    if (!id) { setSelected(null); return }
    const b = sceneBlocks.find((x) => x.id === id)
    setSelected({ kind: 'block', id })
    // A collapsed district is a door, not a file: clicking it opens the
    // directory rather than selecting or asking about anything inside.
    if (b && b.collapsed) { toggleDistrict(b.district); return }
    setTab('what')
    if (!b || b.fi === undefined) return
    // A dark block IS the ask. Clicking one puts the region on the queue, and
    // the request lands in every other tab off the subscription.
    if (!ask || !canRequest) return
    if (coverage.lit[b.fi] > 0) return
    const open = requestsByFile.get(b.fi)
    if (open && open.status !== 'done') return
    requestExploration(territory.files[b.fi].pick, territory.files[b.fi].path)
  }, [sceneBlocks, canRequest, coverage, requestsByFile, requestExploration, territory, toggleDistrict])

  // Blue only earns a line in the key when there is blue on the map. On a repo
  // with no new ground, printing it is one more thing to read for nothing.
  const hasNewGround = useMemo(() => coverage.isNew?.some((v) => v === 1), [coverage])

  const pickStep = useCallback((s) => {
    if (!s) return
    setSelected({ kind: 'step', id: s.id, step: s })
    atlasRef.current?.focusNode?.(s.nodeId)
  }, [])

  const drill = useCallback((name) => {
    setScope(name)
    setSelected(null)
  }, [])

  // Flying to a district is the index's whole job at 2,975 files.
  useEffect(() => {
    if (!scope) return
    atlasRef.current?.focusDistrict?.(scope)
  }, [scope])

  // ── the timeline ──────────────────────────────────────────────────────────
  const total = timeline.length
  const canBack = total > 0 && (cursor == null || cursor > 0)
  const canNext = cursor != null
  const back = useCallback(() => {
    setCursor((c) => Math.max(0, (c == null ? total : c) - 1))
  }, [total])
  const next = useCallback(() => {
    setCursor((c) => (c == null ? null : (c + 1 >= total ? null : c + 1)))
  }, [total])
  const scrub = useCallback((frac) => {
    const n = Math.round(frac * total)
    setCursor(n >= total ? null : Math.max(0, n))
  }, [total])

  // ── keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const idx = selected && selected.kind === 'block'
        ? sceneBlocks.findIndex((b) => b.id === selected.id)
        : -1
      if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); return }
      if (e.key === 'Enter') { e.preventDefault(); if (canNext) next(); else back(); return }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (!sceneBlocks.length) return
        const d = e.key === 'ArrowDown' ? 1 : -1
        const n = idx < 0 ? 0 : (idx + d + sceneBlocks.length) % sceneBlocks.length
        setSelected({ kind: 'block', id: sceneBlocks[n].id })
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        const b = idx >= 0 ? sceneBlocks[idx] : null
        if (b && b.district && b.district !== scope) drill(b.district)
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (scope) { setScope(null); setSelected(null) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sceneBlocks, selected, scope, drill, next, back, canNext])

  const disconnected = meta.status === 'error' || meta.status === 'offline'
  const pos = total ? ((cursor == null ? total : cursor) / total) * 100 : 0

  return (
    <div id="app">
      <TopStrip
        playing={playing}
        onPlay={() => setPlaying((p) => !p)}
        onStep={() => { if (canNext) next(); else back() }}
        onRefit={() => atlasRef.current?.fit?.(true)}
        onBack={back}
        onNext={next}
        canBack={canBack}
        canNext={canNext}
        cursor={cursor}
        steps={total}
        onLeave={onLeave}
      />

      <div id="main">
        <LeftIndex
          scope={scope}
          onScope={(n) => { if (n) drill(n); else { setScope(null); setSelected(null) } }}
          selected={selected}
          onSelect={(s) => { if (s) pickBlock(s.id); else setSelected(null) }}
        />

        <div id="canvasWrap">
          <Atlas
            handle={atlasRef}
            scope={scope}
            selected={selected}
            onSelect={(id) => pickBlock(id, { ask: true })}
            onDrill={drill}
            playing={playing}
            cursor={cursor}
            onStepPick={pickStep}
          />

          <div id="rail">
            <span className="title">
              {cursor == null ? <>LIVE · <b>{total}</b> CALLS</> : <>STEP <b>{cursor}</b> / {total}</>}
            </span>
            <div
              className="track"
              role="slider"
              aria-label="Session timeline"
              aria-valuenow={cursor == null ? total : cursor}
              aria-valuemin={0}
              aria-valuemax={total}
              tabIndex={0}
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                scrub((e.clientX - r.left) / Math.max(1, r.width))
              }}
            >
              <span className="fill" style={{ width: `${pos}%` }} />
              <span className="head" style={{ left: `${pos}%` }} />
            </div>
          </div>

          <div id="zoom">
            <button onClick={() => atlasRef.current?.zoom?.(1.25)} aria-label="Zoom in">+</button>
            <button onClick={() => atlasRef.current?.zoom?.(0.8)} aria-label="Zoom out">−</button>
            <button onClick={() => atlasRef.current?.fit?.(true)} aria-label="Fit">&#10530;</button>
          </div>

          {/*
            THE KEY IS THREE THINGS, NOT SIX.

            Fill is the agent's CONTEXT: green for a file it has read and is
            probably still holding, fading to red as that falls out of the
            window, nothing at all for a file it never opened. Six labelled
            states was more than anyone reads while also reading a map, so the
            fade no longer gets a line of its own (a gradient does not need
            naming) and "no agent connected" moved to the AGENTS stat, where
            somebody looking for it would actually look.

            Blue is the exception and earns its line only when there IS new
            ground; on a repo with none, printing it is noise.

            Outline is WHO, and only agents actually reporting are listed. A
            legend with nothing in it is the correct drawing of a room with
            nobody in it.
          */}
          <div id="legend">
            <span className="lg"><i style={{ background: STATE_LIVE }} />Read · in context</span>
            <span className="lg"><i style={{ background: STATE_COLD }} />Read · out of context</span>
            <span className="lg dead">Dashed · never opened</span>
            {hasNewGround && <span className="lg"><i style={{ background: STATE_NEW }} />New ground</span>}
            {actors.length > 0 && <span className="lg who">Live right now</span>}
            {actors.map((a) => (
              <span className="lg" key={a.actorId || 'main'}>
                <i className="edge" style={{ borderColor: a.color, color: a.color }} />
                {a.actorId ? actorLabel(a.actorId) : (a.name || 'main agent')}
              </span>
            ))}
            {isMock && <span className="lg dead">Mock fixture</span>}
            {disconnected && (
              <button className="lg" onClick={retry} style={{ cursor: 'pointer' }}>
                {meta.status === 'offline' ? 'Connection dropped' : 'Not connected'} · retry
              </button>
            )}
          </div>
        </div>

        <RightPanel
          tab={tab}
          onTab={setTab}
          selected={selected}
          onSelect={setSelected}
          onPickStep={pickStep}
          cursor={cursor}
        />
      </div>

      <HintBar scope={scope} />
    </div>
  )
}
