import { PRIOR } from '../lib/config'

/**
 * The honesty panel. This number is carried, not measured here, and the copy
 * says so — CONTRACT.md is explicit that recall is not computable on an
 * unlabelled repo.
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
        (<span className="mono">{PRIOR.hits}/{PRIOR.n}</span>).
      </p>
      <p className="text-[13.5px] leading-relaxed mt-2" style={{ color: 'var(--muted)' }}>
        Recall is <em>not computable</em> on an unlabelled repo — nothing here tells you
        this repo's recall. The verdict cites the prior, which is why it refuses.
      </p>
    </div>
  )
}
