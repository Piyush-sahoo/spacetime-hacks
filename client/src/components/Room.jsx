import { useEffect, useRef } from 'react'
import { ArrowLeft, Copy, ExternalLink, AlertTriangle } from 'lucide-react'
import { useRoom } from '../lib/room.jsx'
import ConnBadge from './ConnBadge.jsx'
import PresenceRail from './PresenceRail.jsx'
import NodeList from './NodeList.jsx'
import WalkView from './WalkView.jsx'
import Verdict from './Verdict.jsx'
import PriorNote from './PriorNote.jsx'
import { key } from '../lib/util'

export default function Room({ onLeave }) {
  const { repo, meta, walk, isMock, retry, participants } = useRoom()
  const walkRef = useRef(null)
  const seen = useRef(null)

  // On a NEW walk — whoever started it — bring the paint into view. On a phone
  // the list is above the canvas, so without this the money shot is offscreen.
  useEffect(() => {
    if (!walk) return
    const id = key(walk.id)
    if (seen.current === id) return
    seen.current = id
    if (window.matchMedia('(max-width: 1023px)').matches) {
      walkRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [walk?.id]) // eslint-disable-line

  const disconnected = meta.status === 'error' || meta.status === 'offline'

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
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            className="pill-ghost hidden sm:inline-flex"
            onClick={() => window.open(window.location.href, '_blank', 'noopener')}
            title="The whole point: the second tab watches the same walk"
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
        <div className="max-w-[1500px] mx-auto grid gap-4 lg:gap-5 lg:grid-cols-[230px_minmax(0,340px)_minmax(0,1fr)] items-start">
          <div className="lg:sticky lg:top-4 space-y-4">
            <PresenceRail />
            <div className="hidden lg:block"><PriorNote /></div>
          </div>

          <NodeList />

          <div ref={walkRef} className="space-y-4 scroll-mt-4">
            <WalkView />
            <Verdict />
            <div className="lg:hidden"><PriorNote /></div>
          </div>
        </div>
      </main>

      <footer className="rule px-4 sm:px-6 py-4 flex items-center justify-between gap-3 flex-wrap">
        <span className="micro-label">
          {participants.filter((p) => p.online).length} ONLINE · WALK IS SERVER-DRIVEN · EVERY TAB PAINTS FROM THE SUBSCRIPTION
        </span>
        <span className="micro-label">k=6 · THRESHOLD 0.95</span>
      </footer>
    </div>
  )
}
