import { useEffect, useMemo, useState } from 'react'
import { watchDirectory } from '../lib/live'
import {
  isGithubSlug, liveAgentCount, millis, projectLink, reportedTouches, SITE,
} from '../lib/funnel'
import { Shell, go } from './FunnelKit.jsx'

/**
 * Every repository on the map, live.
 *
 * The room's subscription is scoped to ONE repo, which is all a map needs and
 * exactly wrong for a gallery — so this opens its own feed over `repo` and
 * `agent_session` (both tiny). A repository somebody indexes in another tab
 * appears here without a refresh, and an agent going offline goes dark here
 * without one either. That is the whole point of the database being live.
 */
export default function Projects() {
  const [{ repos, sessions }, setFeed] = useState({ repos: [], sessions: [] })
  const [ready, setReady] = useState(false)
  // Liveness is time-based as well as flag-based, so it has to be re-evaluated
  // even when no row changed.
  const [, setNow] = useState(0)

  useEffect(() => {
    const stop = watchDirectory((next) => { setFeed(next); setReady(true) })
    const t = setInterval(() => setNow((n) => n + 1), 5000)
    return () => { stop(); clearInterval(t) }
  }, [])

  const rows = useMemo(() => {
    const now = Date.now()
    return (repos || [])
      .map((r) => ({
        id: r.id,
        slug: String(r.slug || ''),
        label: r.label || '',
        nodes: Number(r.nodeCount ?? r.node_count ?? 0),
        edges: Number(r.edgeCount ?? r.edge_count ?? 0),
        status: String(r.status || ''),
        live: liveAgentCount(sessions, r.id, now),
        calls: reportedTouches(sessions, r.id),
        lastAt: lastTouchAt(sessions, r.id),
      }))
      // A repo with no files is a failed index, not a map. It would open onto
      // an empty plate, so it is not offered.
      .filter((r) => r.nodes > 0 && r.slug)
      .sort((a, b) => {
        // Somebody is working in it right now — that goes first, always.
        if ((b.live > 0) - (a.live > 0)) return (b.live > 0) - (a.live > 0)
        // Then a real `owner/repo`, ahead of a benchmark instance id.
        const g = isGithubSlug(b.slug) - isGithubSlug(a.slug)
        if (g) return g
        return b.nodes - a.nodes
      })
  }, [repos, sessions])

  const totalLive = rows.reduce((n, r) => n + r.live, 0)

  return (
    <Shell>
      <span className="eyebrow">
        {ready
          ? `${rows.length} repositories · ${totalLive} agent${totalLive === 1 ? '' : 's'} working right now`
          : 'Reading the map…'}
      </span>
      <h1>Projects on the map</h1>
      <p className="fn-lede">
        Every repository that has been indexed. Open one to get its two links and
        the four commands that put your own agent on it. This list is live — it
        moves as agents connect and as repositories are added.
      </p>

      {ready && rows.length === 0 && (
        <div className="fn-note fn-bad">
          <span className="fn-k">Nothing here</span>
          <p style={{ margin: 0 }}>
            No indexed repository came back from the database. Either nothing has
            been indexed yet, or the connection did not open.
          </p>
        </div>
      )}

      <div className="fn-grid">
        {rows.map((r) => (
          <button
            key={String(r.id)}
            type="button"
            className="fn-card"
            onClick={() => go(projectLink(r.slug))}
          >
            {r.live > 0
              ? <span className="fn-live">{r.live} agent{r.live === 1 ? '' : 's'} live</span>
              : <span className="fn-idle">{r.lastAt ? `last seen ${ago(r.lastAt)}` : 'never visited'}</span>}
            <span className="fn-slug">{r.slug}</span>
            <span className="fn-facts">
              <span className="fn-num">{r.nodes.toLocaleString()} files</span>
              <span className="fn-num">{r.edges.toLocaleString()} edges</span>
              {r.calls > 0 && <span className="fn-num">{r.calls.toLocaleString()} calls</span>}
            </span>
          </button>
        ))}
      </div>

      <h2>Not here yet?</h2>
      <p>Any public GitHub repository takes about three and a half seconds to add.</p>
      <div className="actions">
        <button type="button" className="ctl primary" onClick={() => go(SITE + '/')}>
          Add a repository
        </button>
      </div>
    </Shell>
  )
}

function lastTouchAt(sessions, repoId) {
  const id = String(repoId)
  let best = 0
  for (const s of sessions || []) {
    if (String(s.repoId ?? s.repo_id) !== id) continue
    best = Math.max(best, millis(s.lastAt ?? s.last_at))
  }
  return best
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
