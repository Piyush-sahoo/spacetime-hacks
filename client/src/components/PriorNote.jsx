import { PRIOR } from '../lib/config'

/**
 * The honesty panel. This number is a published measurement over labelled
 * fixes, not something computed from the repo on screen — recall is not
 * computable on an unlabelled repo, and the copy says so.
 */
export default function PriorNote({ compact = false }) {
  if (compact) {
    return (
      <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--muted)' }}>
        <span className="mono" style={{ color: 'var(--ink-soft)' }}>measured {PRIOR.recall.toFixed(3)} recall</span>{' '}
        across {PRIOR.n} labelled fixes in {PRIOR.repos} repos. Recall is not computable on an unlabelled repo.
      </p>
    )
  }
  return (
    <div className="panel p-4 sm:p-5">
      <div className="micro-label mb-2">THE CARRIED PRIOR</div>
      <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
        Measured <span className="mono" style={{ color: 'var(--ink)' }}>{PRIOR.recall.toFixed(3)}</span> recall
        across <span className="mono" style={{ color: 'var(--ink)' }}>{PRIOR.n}</span> labelled fixes
        in <span className="mono" style={{ color: 'var(--ink)' }}>{PRIOR.repos}</span> repos
        (<span className="mono">{PRIOR.hits}/{PRIOR.n}</span>, type-resolved graph;{' '}
        <span className="mono">{PRIOR.recallNameMatched.toFixed(3)}</span> name-matched).
      </p>
      <p className="text-[13.5px] leading-relaxed mt-2" style={{ color: 'var(--muted)' }}>
        Recall is <em>not computable</em> on an unlabelled repo — nothing here tells you
        this repo&rsquo;s recall. The verdict cites the measurement, which is why it refuses.
      </p>
      <p className="micro-label mt-3">{PRIOR.source}</p>
    </div>
  )
}
