import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Radio, GitBranch, Users } from 'lucide-react'
import { useRoom } from '../lib/room.jsx'
import { defaultName } from '../lib/util'
import ConnBadge from './ConnBadge.jsx'
import PriorNote from './PriorNote.jsx'

export default function Landing({ onEnter }) {
  const { join, meta, repo, participants, useMock, retry, isMock } = useRoom()
  const fallback = useMemo(() => defaultName(), [])
  const [name, setName] = useState('')
  const [tried, setTried] = useState(false)

  useEffect(() => { setTried(meta.status === 'error') }, [meta.status])

  const enter = () => {
    join((name.trim() || fallback).slice(0, 32))
    onEnter()
  }

  const online = participants.filter((p) => p.online).length

  return (
    <div className="min-h-[100dvh] flex flex-col">
      <header className="px-5 sm:px-8 pt-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="font-serif-display text-[19px] whitespace-nowrap">The Map Room</span>
          <span className="micro-label hidden sm:inline">SPACETIMEDB</span>
        </div>
        <ConnBadge />
      </header>

      <main className="flex-1 px-5 sm:px-8 py-10 sm:py-16">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-2 mb-6">
            <span className="status-dot w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
            <span className="micro-label" style={{ color: 'var(--ink)' }}>ONE ROOM · EVERY TAB SEES THE SAME WALK</span>
          </div>

          <h1 className="font-serif-display text-[38px] sm:text-[52px] lg:text-[62px] leading-[1.06]">
            Watch the map your<br className="hidden sm:block" /> agent is actually using.
          </h1>

          <p className="mt-6 text-[15.5px] sm:text-[17px] max-w-xl leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            For engineers running AI coding agents — paste your repo and watch, with your team,
            the map your agent is actually using, and the roads it can&rsquo;t see.
          </p>

          {/* ── entry ── */}
          <div className="mt-9 flex flex-col gap-3 max-w-xl">
            <input
              className="field w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') enter() }}
              placeholder={`${fallback}  (optional — we'll name you this)`}
              aria-label="Your display name (optional)"
              maxLength={32}
            />
            <div className="flex flex-col sm:flex-row gap-3">
              <button className="pill-dark flex-1" onClick={enter}>
                <Radio size={15} />
                Watch a live room
                {online > 0 && <span className="mono text-[12px] opacity-70">· {online} here</span>}
                <ArrowRight size={15} />
              </button>
              <button className="pill-dashed flex-1" disabled title="Ingest path is not live yet — we will not fake it.">
                <GitBranch size={15} />
                Paste your repo
                <span className="micro-label" style={{ color: 'var(--muted)' }}>COMING TONIGHT</span>
              </button>
            </div>

            <p className="text-[13.5px] mt-1 flex items-start gap-2" style={{ color: 'var(--ink-soft)' }}>
              <Users size={14} className="mt-[3px] shrink-0" style={{ color: 'var(--accent)' }} />
              <span>
                Click any file in the list — <strong style={{ fontWeight: 600 }}>the walk runs on everyone&rsquo;s screen.</strong>{' '}
                Open this page in a second tab to see it.
              </span>
            </p>
          </div>

          {/* ── connection state, honest ── */}
          <div className="mt-8 max-w-xl space-y-3">
            {repo && !isMock && (
              <div className="panel px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                <span className="mono text-[13px]">{repo.label || repo.slug}</span>
                <span className="micro-label">
                  {Number(repo.nodeCount || 0).toLocaleString()} NODES · {Number(repo.edgeCount || 0).toLocaleString()} EDGES · {String(repo.status || '').toUpperCase()}
                </span>
              </div>
            )}

            {tried && !isMock && (
              <div className="panel p-4" style={{ borderColor: 'rgba(192,38,24,0.35)' }}>
                <div className="micro-label mb-1.5" style={{ color: 'var(--danger)' }}>NOT CONNECTED</div>
                <p className="text-[13.5px]" style={{ color: 'var(--ink-soft)' }}>{meta.error || 'could not reach the module'}</p>
                <div className="flex gap-2 mt-3 flex-wrap">
                  <button className="pill-ghost" onClick={retry}>Retry</button>
                  <button className="pill-ghost" onClick={() => { useMock(); join(name.trim() || fallback); onEnter() }}>
                    Review the UI with mock data
                  </button>
                </div>
                <p className="micro-label mt-3" style={{ color: 'var(--danger)' }}>
                  MOCK IS A REVIEW AID. IT IS NOT THE PRODUCT AND IS LABELLED EVERYWHERE.
                </p>
              </div>
            )}

            <PriorNote />
          </div>
        </div>
      </main>

      <footer className="rule px-5 sm:px-8 py-5 flex items-center justify-between gap-3 flex-wrap">
        <span className="micro-label">BOUNDED BACKWARDS WALK · k=6 · THRESHOLD 0.95</span>
        <span className="micro-label">SUBSTRATE—FRICTION LINEAGE</span>
      </footer>
    </div>
  )
}
