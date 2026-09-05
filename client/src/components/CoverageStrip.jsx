import { useRoom } from '../lib/room.jsx'
import { num } from '../lib/util'

/**
 * The one number the room is about, sized to be read from the back of it.
 * Every value here is a client-side roll-up of subscribed `node_cov` rows —
 * SpacetimeDB SQL has no GROUP BY, and an aggregate computed on the tab is
 * also an aggregate that cannot drift from the map next to it.
 */
export default function CoverageStrip() {
  const { coverage, agents, covState } = useRoom()
  const { exploredNodes, totalNodes, exploredFiles, totalFiles } = coverage
  const pct = totalNodes ? (exploredNodes / totalNodes) * 100 : 0
  const dark = Math.max(0, totalNodes - exploredNodes)
  const liveAgents = agents.filter((a) => a.online)

  return (
    <section className="panel px-4 sm:px-6 py-3.5 sm:py-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="font-serif-display leading-none text-[40px] sm:text-[54px]" style={{ color: 'var(--accent)' }}>
            {num(exploredNodes)}
          </span>
          <span className="min-w-0">
            <span className="block font-serif-display text-[19px] sm:text-[23px] leading-tight">
              of {num(totalNodes)} symbols explored
            </span>
            <span className="micro-label">
              {num(exploredFiles)}/{num(totalFiles)} FILES LIT · {num(dark)} STILL DARK
            </span>
          </span>
        </div>

        <div className="text-right shrink-0">
          <div className="font-serif-display text-[26px] sm:text-[32px] leading-none">{pct.toFixed(1)}%</div>
          <div className="micro-label">
            {covState === 'live'
              ? liveAgents.length
                ? `${liveAgents.length} AGENT${liveAgents.length === 1 ? '' : 'S'} REPORTING`
                : 'COVERAGE FEED LIVE'
              : covState === 'connecting'
                ? 'SUBSCRIBING…'
                : 'COVERAGE FEED OFFLINE'}
          </div>
        </div>
      </div>

      <div className="mt-3 h-2.5 rounded-full overflow-hidden relative" style={{ background: 'rgba(22,20,19,0.14)' }}>
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{
            width: `${Math.max(pct, exploredNodes > 0 ? 0.6 : 0)}%`,
            background: 'linear-gradient(90deg, var(--accent), #ff8a3d)',
            boxShadow: exploredNodes ? '0 0 12px rgba(255,87,26,0.5)' : 'none',
          }}
        />
      </div>
    </section>
  )
}
