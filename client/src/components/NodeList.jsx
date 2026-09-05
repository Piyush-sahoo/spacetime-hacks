import { useMemo, useState } from 'react'
import { Search, Play } from 'lucide-react'
import { useRoom } from '../lib/room.jsx'
import { key, splitQual } from '../lib/util'

const KIND_ORDER = { File: 0, Class: 1, Function: 2, Test: 3, ConfigKey: 4 }
const KIND_TINT = {
  Test: 'var(--danger)',
  File: 'var(--ink-soft)',
  Class: 'var(--ink-soft)',
  Function: 'var(--ink-soft)',
  ConfigKey: 'var(--muted)',
}
const LIMIT = 240

export default function NodeList({ onPick }) {
  const { nodes, walk, repo, startWalk, callerCount, walkDone } = useRoom()
  const [q, setQ] = useState('')

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const src = needle
      ? nodes.filter((n) => `${n.qual || ''} ${n.name || ''}`.toLowerCase().includes(needle))
      : nodes
    // Most callers first: those are the origins whose backwards walk actually
    // has somewhere to go. Alphabetical order would put dead leaves on top.
    return [...src]
      .sort((a, b) =>
        callerCount(b.id) - callerCount(a.id) ||
        (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
        String(a.qual).localeCompare(String(b.qual)))
      .slice(0, LIMIT)
  }, [nodes, q, callerCount])

  const busy = walk && !walkDone

  return (
    <section className="panel flex flex-col min-h-0 overflow-hidden">
      <div className="p-3.5 sm:p-4 pb-3 border-b" style={{ borderColor: 'var(--line)' }}>
        <div className="flex items-center justify-between mb-2.5 gap-2">
          <span className="micro-label">PICK THE CHANGED SYMBOL</span>
          <span className="mono text-[11px]" style={{ color: 'var(--muted)' }}>
{'\u2190'} callers · {nodes.length.toLocaleString()} loaded
            {repo?.nodeCount ? ` / ${Number(repo.nodeCount).toLocaleString()}` : ''}
          </span>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
          <input
            className="field w-full pl-9 text-[13.5px] py-2"
            placeholder="filter by file or symbol…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      <ul className="flex-1 overflow-y-auto thin-scroll min-h-0" style={{ maxHeight: '46vh' }}>
        {nodes.length === 0 && (
          <li className="p-4 text-[13px]" style={{ color: 'var(--muted)' }}>
            waiting for <span className="mono">node</span> rows…
          </li>
        )}
        {shown.map((n) => {
          const { path, symbol } = splitQual(n.qual, n.name)
          return (
            <li key={key(n.id)}>
              <button
                disabled={busy}
                onClick={() => { startWalk(n.id); onPick?.() }}
                className="w-full text-left px-3.5 sm:px-4 py-2.5 flex items-center gap-3 group disabled:opacity-45"
                style={{ borderBottom: '1px solid var(--line)' }}
              >
                <span className="micro-label shrink-0 w-[62px]" style={{ color: KIND_TINT[n.kind] || 'var(--muted)' }}>
                  {String(n.kind || '?').slice(0, 8)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block mono text-[13px] truncate">{symbol}</span>
                  <span className="block mono text-[11px] truncate" style={{ color: 'var(--muted)' }}>{path}</span>
                </span>
                <span className="shrink-0 flex items-center gap-2">
                  <span className="mono text-[10.5px] whitespace-nowrap" style={{ color: callerCount(n.id) ? 'var(--ink-soft)' : 'var(--muted)' }}>
                    {callerCount(n.id)}←
                  </span>
                  <Play size={13} className="opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--accent)' }} />
                </span>
              </button>
            </li>
          )
        })}
        {shown.length === LIMIT && (
          <li className="px-4 py-2.5 micro-label">TOP {LIMIT} BY CALLER COUNT — FILTER TO NARROW</li>
        )}
      </ul>
    </section>
  )
}
