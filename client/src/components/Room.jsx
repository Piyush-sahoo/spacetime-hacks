import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Copy, ExternalLink, AlertTriangle, Compass, GitBranch } from 'lucide-react'
import { useRoom } from '../lib/room.jsx'
import ConnBadge from './ConnBadge.jsx'
import PresenceRail from './PresenceRail.jsx'
import NodeList from './NodeList.jsx'
import WalkView from './WalkView.jsx'
import Verdict from './Verdict.jsx'
import PriorNote from './PriorNote.jsx'
import CoverageStrip from './CoverageStrip.jsx'
import RequestPanel from './RequestPanel.jsx'
import Graph from './Graph.jsx'
import TouchTicker from './TouchTicker.jsx'
import { key } from '../lib/util'

/**
 * Two views over one room.
 *
 * THE GRAPH is the map and the default: the repo drawn as a layered node-link
 * diagram — circles for code, arrows for the edges between them, ranks running
 * left to right — painted live from the subscription. IMPACT is the hop-by-hop
 * walk, one click away. Same repo, same participants.
 */
export default function Room({ onLeave }) {
  const { repo, meta, walk, walkDone, isMock, retry, participants, coverage, requests } = useRoom()
  const [view, setView] = useState('coverage')
  const walkRef = useRef(null)
  const seen = useRef(null)

  // A walk that starts while we are already in the room stays on the survey
  // so every tab watches the same paint. A walk that was already running
  // when we joined must not hijack the map.
  useEffect(() => {
    if (!walk) return
    const id = key(walk.id)
    if (seen.current === id) return
    const first = seen.current === null
    seen.current = id
    if (first) return
    setView('coverage')
  }, [walk?.id]) // eslint-disable-line

  const disconnected = meta.status === 'error' || meta.status === 'offline'
  const openAsks = requests.filter((r) => r.status !== 'done').length

  return (
    <div className={`min-h-[100dvh] flex flex-col ${isMock ? 'mock-stripe' : ''}`}>
      {isMock && (
        <div className="px-4 py-2 flex items-center justify-center gap-2 text-center" style={{ background: 'var(--danger)', color: 'var(--cream)' }}>
          <AlertTriangle size={14} className="shrink-0" />
          <span className="micro-label" style={{ color: 'var(--cream)' }}>
            MOCK DATA — LOCAL FIXTURE FOR UI REVIEW. NOTHING HERE IS A REAL GRAPH OR A REAL MEASUREMENT.
          </span>
        </div>
      )}

      <header className="px-4 sm:px-6 py-3.5 flex items-center justify-between gap-3 rule" style={{ borderTop: 'none', borderBottom: '1px solid var(--line)' }}>
        <div className="flex items-center gap-3 min-w-0">
          <button className="pill-ghost !px-3 !py-1.5" onClick={onLeave} aria-label="Back">
            <ArrowLeft size={14} />
          </button>
          <div className="min-w-0">
            <div className="font-serif-display text-[17px] leading-tight truncate">
              {repo?.label || repo?.slug || 'The Map Room'}
            </div>
            <div className="micro-label truncate">
              {repo
                ? `${Number(repo.nodeCount || 0).toLocaleString()} NODES · ${Number(repo.edgeCount || 0).toLocaleString()} EDGES · ${String(repo.status || '').toUpperCase()}`
                : 'LOADING ROOM…'}
            </div>
          </div>
          <RepoPicker />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            className="pill-ghost hidden sm:inline-flex"
            onClick={() => window.open(window.location.href, '_blank', 'noopener')}
            title="The whole point: the second tab watches the same map"
          >
            <ExternalLink size={13} /> Second tab
          </button>
          <button
            className="pill-ghost sm:hidden"
            onClick={() => navigator.clipboard?.writeText(window.location.href)}
            aria-label="Copy link"
          >
            <Copy size={13} />
          </button>
          <ConnBadge />
        </div>
      </header>

      {disconnected && !isMock && (
        <div className="px-4 sm:px-6 py-2.5 flex items-center gap-3 flex-wrap" style={{ background: 'rgba(192,38,24,0.10)' }}>
          <span className="micro-label" style={{ color: 'var(--danger)' }}>
            {meta.status === 'offline' ? 'CONNECTION DROPPED' : 'NOT CONNECTED'} — {meta.error || 'no module'}
          </span>
          <button className="pill-ghost !py-1" onClick={retry}>Retry</button>
        </div>
      )}

      <main className="flex-1 px-4 sm:px-6 py-4 sm:py-5">
        <div className="max-w-[1500px] mx-auto grid gap-4 lg:gap-5 lg:grid-cols-[236px_minmax(0,1fr)] items-start [&>*]:min-w-0">
          <div className="lg:sticky lg:top-4 space-y-4 min-w-0">
            <PresenceRail />
            <div className="hidden lg:block"><PriorNote /></div>
          </div>

          <div className="space-y-4 min-w-0">
            <CoverageStrip />
            <TouchTicker />

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-1.5 p-1 rounded-full w-fit" style={{ border: '1px solid var(--line)', background: 'rgba(250,249,246,0.5)' }}>
                <Tab active={view === 'coverage'} onClick={() => setView('coverage')} icon={Compass}>
                  The graph
                  {openAsks > 0 && <Badge n={openAsks} />}
                </Tab>
                <Tab active={view === 'impact'} onClick={() => setView('impact')} icon={GitBranch}>
                  Impact walk
                </Tab>
              </div>
              <span className="micro-label hidden sm:inline">
                LAYERED NODE-LINK · RANKS LEFT TO RIGHT · ARROWS ARE REAL EDGES
              </span>
            </div>

            {view === 'coverage' ? (
              <div className="space-y-4">
                <Graph />
                <div className="grid gap-4 lg:gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,340px)] items-start [&>*]:min-w-0">
                  <p className="micro-label px-1">
                    {coverage.exploredFiles === 0
                      ? 'NOTHING TOUCHED YET — EVERY FILE IN THIS REPO IS A BLIND SPOT'
                      : `${coverage.totalFiles - coverage.exploredFiles} FILES THE AGENT HAS NEVER OPENED`}
                  </p>
                  <RequestPanel />
                </div>
                {walkDone && <Verdict />}
              </div>
            ) : (
              <div className="grid gap-4 lg:gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] items-start [&>*]:min-w-0">
                <NodeList />
                <div ref={walkRef} className="space-y-4 scroll-mt-4">
                  <WalkView />
                  <Verdict />
                </div>
              </div>
            )}

            <div className="lg:hidden"><PriorNote /></div>
          </div>
        </div>
      </main>

      <footer className="rule px-4 sm:px-6 py-4 flex items-center justify-between gap-3 flex-wrap">
        <span className="micro-label">
          {participants.filter((p) => p.online).length} ONLINE · EVERY TAB PAINTS FROM THE SUBSCRIPTION
        </span>
        <span className="micro-label">k=6 · THRESHOLD 0.95</span>
      </footer>
    </div>
  )
}

function Tab({ active, onClick, icon: Icon, children }) {
  return (
    <button
      onClick={onClick}
      className="rounded-full px-3.5 py-1.5 text-[13px] font-medium inline-flex items-center gap-1.5 transition-colors"
      style={{
        background: active ? 'var(--ink)' : 'transparent',
        color: active ? 'var(--cream)' : 'var(--ink-soft)',
      }}
    >
      <Icon size={13} />
      {children}
    </button>
  )
}

function Badge({ n }) {
  return (
    <span
      className="mono text-[10px] rounded-full px-1.5 leading-[15px] ml-0.5"
      style={{ background: 'var(--ask)', color: '#3a2a05' }}
    >
      {n}
    </span>
  )
}

/**
 * Which repo this room is a map of.
 *
 * A room IS a repo, and every tab in it must agree on which — so switching is a
 * navigation, not a piece of local state: it writes `?repo=` and reloads. That
 * also makes the choice shareable, which is how the second tab lands in the
 * same room as the first.
 */
function RepoPicker() {
  const { repos, repo } = useRoom()
  const ready = repos.filter((r) => Number(r.nodeCount || 0) > 0)
  if (ready.length < 2 || !repo) return null
  return (
    <label className="hidden md:flex items-center gap-1.5 shrink-0" title="Which repo this room maps">
      <span className="micro-label">REPO</span>
      <select
        className="mono text-[11.5px] rounded-md px-2 py-1 cursor-pointer"
        style={{ border: '1px solid var(--line)', background: 'rgba(250,249,246,0.6)', color: 'var(--ink)' }}
        value={String(repo.slug)}
        onChange={(e) => {
          const u = new URL(window.location.href)
          u.searchParams.set('repo', e.target.value)
          window.location.assign(u.toString())
        }}
      >
        {ready.map((r) => (
          <option key={String(r.id)} value={String(r.slug)}>
            {String(r.slug)} · {Number(r.nodeCount).toLocaleString()}
          </option>
        ))}
      </select>
    </label>
  )
}
