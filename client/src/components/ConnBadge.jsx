import { useRoom } from '../lib/room.jsx'
import { STDB_MODULE } from '../lib/config'

const COPY = {
  idle: ['connecting…', 'var(--muted)'],
  connecting: ['connecting…', 'var(--muted)'],
  connected: ['live', 'var(--accent)'],
  offline: ['reconnecting…', 'var(--danger)'],
  error: ['not connected', 'var(--danger)'],
}

export default function ConnBadge({ className = '' }) {
  const { meta, isMock } = useRoom()
  if (isMock) {
    return (
      <span className={`inline-flex items-center gap-2 ${className}`}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--danger)' }} />
        <span className="micro-label" style={{ color: 'var(--danger)' }}>MOCK DATA · NOT LIVE</span>
      </span>
    )
  }
  const [label, colour] = COPY[meta.status] || COPY.idle
  const pulsing = meta.status === 'connected' || meta.status === 'connecting' || meta.status === 'idle'
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${pulsing ? 'status-dot' : ''}`} style={{ background: colour }} />
      <span className="micro-label" style={{ color: meta.status === 'connected' ? 'var(--ink)' : colour }}>
        {label} · {STDB_MODULE}
      </span>
    </span>
  )
}
