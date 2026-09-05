import { ShieldAlert, FlaskConical } from 'lucide-react'
import { useRoom } from '../lib/room.jsx'
import { key, splitQual, pct } from '../lib/util'

/**
 * Lands on both screens because it is a `verdict` row arriving over the
 * subscription — nobody computes it in the browser.
 */
export default function Verdict() {
  const { walk, verdict, nodeById, walkDone } = useRoom()
  if (!walk) return null

  if (!verdict) {
    if (!walkDone) return null
    return (
      <section className="panel p-4">
        <span className="micro-label">WALK EXHAUSTED · WAITING FOR VERDICT ROW…</span>
      </section>
    )
  }

  const lb = Number(verdict.wilsonLb)
  const th = Number(verdict.threshold)
  const missed = verdict.missedTest && key(verdict.missedTest) !== '0' ? nodeById(verdict.missedTest) : null
  const refuse = String(verdict.decision || '').toUpperCase() !== 'SKIP'

  return (
    <section className="verdict-in panel-dark p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="micro-label mb-1.5" style={{ color: 'rgba(250,249,246,0.5)' }}>VERDICT</div>
          <div className="flex items-center gap-2.5">
            <ShieldAlert size={22} style={{ color: refuse ? 'var(--danger)' : 'var(--good)' }} />
            <span
              className="font-serif-display text-[34px] sm:text-[42px] leading-none"
              style={{ color: refuse ? '#ff6a5a' : '#7fd0a2' }}
            >
              {verdict.decision}
            </span>
          </div>
        </div>
        <div className="micro-label text-right" style={{ color: 'rgba(250,249,246,0.5)' }}>
          WALK #{key(verdict.walkId)}<br />
          {walk.graphComplete ? 'FRONTIER EXHAUSTED' : `BOUND k=${Number(walk.k)}`}
        </div>
      </div>

      {/* the numbers */}
      <div className="mt-5 grid grid-cols-3 gap-3 sm:gap-4">
        <Stat label="WILSON LOWER BOUND" value={lb.toFixed(3)} tint="#ff6a5a" />
        <Stat label="THRESHOLD TO SKIP" value={th.toFixed(2)} />
        <Stat label="PRIOR RECALL" value={Number(verdict.recallPrior).toFixed(3)} />
      </div>

      {/* lb vs threshold, drawn */}
      <div className="mt-5">
        <div className="relative h-2 rounded-full overflow-hidden" style={{ background: 'rgba(250,249,246,0.12)' }}>
          <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, lb * 100))}%`, background: '#ff6a5a' }} />
          <div className="absolute top-[-4px] bottom-[-4px] w-px" style={{ left: `${Math.min(100, th * 100)}%`, background: 'var(--cream)' }} />
        </div>
        <div className="flex justify-between mt-2">
          <span className="mono text-[11px]" style={{ color: '#ff6a5a' }}>lb {pct(lb)}</span>
          <span className="mono text-[11px]" style={{ color: 'rgba(250,249,246,0.6)' }}>threshold {pct(th)}</span>
        </div>
      </div>

      <p className="mt-5 text-[13.5px] leading-relaxed" style={{ color: 'rgba(250,249,246,0.78)' }}>
        {verdict.reason}
      </p>

      {/* the road it can't see */}
      <div
        className="mt-5 rounded-xl p-4"
        style={{ background: 'rgba(192,38,24,0.14)', border: '1px solid rgba(255,106,90,0.45)' }}
      >
        <div className="micro-label flex items-center gap-1.5 mb-1.5" style={{ color: '#ff6a5a' }}>
          <FlaskConical size={12} /> GUARDING TEST THE WALK NEVER REACHED
        </div>
        {missed ? (
          <>
            <p className="mono text-[13.5px] break-all" style={{ color: '#ffb3a8' }}>
              {splitQual(missed.qual, missed.name).symbol}
            </p>
            <p className="mono text-[11px] break-all mt-0.5" style={{ color: 'rgba(255,179,168,0.6)' }}>
              {splitQual(missed.qual, missed.name).path}
            </p>
          </>
        ) : (
          <p className="mono text-[13px]" style={{ color: '#ffb3a8' }}>node #{key(verdict.missedTest)}</p>
        )}
        <p className="text-[12.5px] mt-2" style={{ color: 'rgba(250,249,246,0.62)' }}>
          A skip would have silently dropped it. That is the road the map doesn&rsquo;t have.
        </p>
      </div>

      <div className="mt-4 pt-4" style={{ borderTop: '1px solid rgba(250,249,246,0.14)' }}>
        <div className="text-[12.5px] leading-relaxed" style={{ color: 'rgba(250,249,246,0.55)' }}>
          <PriorNoteDark />
        </div>
      </div>
    </section>
  )
}

function Stat({ label, value, tint }) {
  return (
    <div>
      <div className="micro-label mb-1" style={{ color: 'rgba(250,249,246,0.45)' }}>{label}</div>
      <div className="mono text-[20px] sm:text-[24px]" style={{ color: tint || 'var(--cream)' }}>{value}</div>
    </div>
  )
}

function PriorNoteDark() {
  return (
    <span>
      Measured <span className="mono">0.419</span> recall across <span className="mono">172</span> labelled
      fixes in <span className="mono">7</span> repos. Recall is not computable on an unlabelled repo.
    </span>
  )
}
