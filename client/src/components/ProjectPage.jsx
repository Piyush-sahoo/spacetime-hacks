import { useEffect, useMemo, useState } from 'react'
import { watchDirectory } from '../lib/live'
import {
  baseLink, liveAgentCount, millis, projectsLink, sessionLink,
} from '../lib/funnel'
import { Copy, Shell, Step, go } from './FunnelKit.jsx'

const PLUGIN_REPO = 'https://github.com/Piyush-sahoo/spacetime-hacks'

/**
 * One repository: its two links, and the walkthrough that puts an agent on it.
 *
 * The two links are the product. Everything under them exists to get a person
 * from "I can see the map" to "I can see MY agent on the map" without having to
 * ask anybody anything.
 */
export default function ProjectPage({ slug }) {
  const [{ repos, sessions }, setFeed] = useState({ repos: [], sessions: [] })
  const [ready, setReady] = useState(false)
  const [, setNow] = useState(0)

  useEffect(() => {
    const stop = watchDirectory((next) => { setFeed(next); setReady(true) })
    const t = setInterval(() => setNow((n) => n + 1), 5000)
    return () => { stop(); clearInterval(t) }
  }, [])

  const repo = useMemo(
    () => (repos || []).find((r) => String(r.slug || '').toLowerCase() === String(slug).toLowerCase()),
    [repos, slug]
  )

  const mine = useMemo(() => {
    if (!repo) return []
    const id = String(repo.id)
    return (sessions || [])
      .filter((s) => String(s.repoId ?? s.repo_id) === id)
      // The main agent only. A subagent's key is `<session>/<actor>`, and its
      // route is already drawn inside its parent's link.
      .filter((s) => !String(s.session || '').includes('/'))
      .sort((a, b) => millis(b.lastAt ?? b.last_at) - millis(a.lastAt ?? a.last_at))
  }, [repo, sessions])

  const live = repo ? liveAgentCount(sessions, repo.id) : 0
  const latest = mine[0]
  const base = baseLink(slug)

  if (ready && !repo) {
    return (
      <Shell narrow>
        <span className="eyebrow">Not on the map</span>
        <h1>{slug}</h1>
        <div className="fn-note fn-bad">
          <p style={{ margin: 0 }}>
            No indexed repository has that name. It may never have been indexed,
            or the name may be spelled differently here.
          </p>
        </div>
        <div className="actions">
          <button type="button" className="ctl primary" onClick={() => go(projectsLink())}>
            See what is on the map
          </button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <span className="eyebrow">
        {repo
          ? <>
              {Number(repo.nodeCount ?? repo.node_count ?? 0).toLocaleString()} files ·{' '}
              {Number(repo.edgeCount ?? repo.edge_count ?? 0).toLocaleString()} edges ·{' '}
              {live > 0 ? `${live} agent${live === 1 ? '' : 's'} working right now` : 'nobody connected'}
            </>
          : 'Reading the map…'}
      </span>
      <h1>{slug}</h1>

      {/* ── the two links ──────────────────────────────────────────────── */}
      <h2>Two links</h2>
      <p>
        The same map, scoped two ways. Open them side by side and you are
        comparing <strong>one run</strong> against <strong>the whole history</strong>:
        what this agent went to, laid over everywhere anyone has ever been.
      </p>

      <div className="fn-links">
        <div className="fn-link">
          <span className="fn-k">Base</span>
          <p className="fn-what">Everything every agent has ever explored in this repository.</p>
          <Copy text={base} title="the base link" />
        </div>

        {latest ? (
          <div className="fn-link">
            <span className="fn-k">
              This session {live > 0 ? '· live now' : `· last seen ${ago(millis(latest.lastAt ?? latest.last_at))}`}
            </span>
            <p className="fn-what">
              One agent's route, and nothing else. <span className="fn-num">
                {Number(latest.touches || 0).toLocaleString()}
              </span> tool calls reported.
            </p>
            <Copy text={sessionLink(slug, latest.session)} title="the session link" />
          </div>
        ) : (
          <div className="fn-link fn-pending">
            <span className="fn-k">This session — none yet</span>
            <p className="fn-what">
              One agent's route, and nothing else. No agent has reported against
              this repository yet, so there is no session to link to. Follow the
              steps below and your terminal prints yours on the first prompt.
            </p>
            <pre>{sessionLink(slug, '<your-session-uuid>')}</pre>
          </div>
        )}
      </div>

      <p className="fn-why" style={{ marginTop: 10 }}>
        The session id is Claude Code's own <code>session_id</code>. It is already
        written into every reported tool call, so the link needs nothing new — it
        exists the moment your session does.
      </p>

      {/* ── the walkthrough ────────────────────────────────────────────── */}
      <h2>Put your own agent on it — six steps</h2>
      <p>
        You need Python 3 (standard library only, nothing to pip install) and
        Claude Code. Steps 1 to 4 are run <strong>once, ever</strong>, from a
        checkout of The Map Room. Step 6 is run inside the repository you actually
        want to watch.
      </p>

      <ol className="fn-steps">
        <Step
          n={1}
          title="Get The Map Room and log in to SpacetimeDB"
          why="The login writes the bearer token that the plugin reads out of ~/.config/spacetime/cli.toml. Without it the plugin has nothing to authenticate with."
          expect={<><b>Expect:</b> the CLI prints the identity you are now logged in as.</>}
        >
          <Copy
            title="clone and log in"
            text={`git clone ${PLUGIN_REPO}\ncd spacetime-hacks\nspacetime login`}
          />
        </Step>

        <Step
          n={2}
          title="Register this checkout as a plugin marketplace"
          why={'Run it from the root of that checkout. The path has to be absolute — "." is rejected — which is what $(pwd) is doing here.'}
          expect={<><b>Expect:</b> <code>Added marketplace: map-room</code>.</>}
        >
          <Copy title="add the marketplace" text={'claude plugin marketplace add "$(pwd)"'} />
        </Step>

        <Step
          n={3}
          title="Install the plugin"
          why="It installs at user scope, so it is active in every project you open — read the note under these steps before you decide that is what you want."
          expect={<><b>Expect:</b> <code>Installed map-room@map-room</code>.</>}
        >
          <Copy title="install the plugin" text="claude plugin install map-room@map-room" />
        </Step>

        <Step
          n={4}
          title="Confirm what got installed"
          expect={<>
            <b>Expect:</b> <code>Skills (1)</code> and <code>Hooks (5)</code> —
            PostToolUse, UserPromptSubmit, Stop, SessionEnd, SubagentStop. If it
            says Hooks (3) you have an older build; pull and reinstall.
          </>}
        >
          <Copy title="check the install" text="claude plugin details map-room@map-room" />
        </Step>

        <Step
          n={5}
          title="Restart Claude Code"
          why="Hooks are read when the session starts. Until you restart — or run /reload-plugins — the plugin is installed but nothing is firing, which looks exactly like it being broken."
          expect={<><b>Expect:</b> nothing visible. This is the step people skip.</>}
        >
          <Copy title="reload the plugins" text="/reload-plugins" />
        </Step>

        <Step
          n={6}
          title="Open your repository and check the binding"
          why="Run this inside the repository you want to watch — not inside The Map Room. It prints what the plugin resolved, which is the answer to “is this actually working?”."
          expect={<>
            <b>Expect:</b> <code>repo_id</code> filled in with <code>(lookup)</code>{' '}
            beside it, <code>repo_slug</code> equal to <strong>{slug}</strong>, and{' '}
            <code>token : found</code>. If <code>repo_id</code> is empty, read the
            failures below — do not ignore it, because an unbound checkout reports
            nothing at all, on purpose.
          </>}
        >
          <Copy
            title="run the doctor"
            text={`cd /path/to/your/repo\npython3 ~/.claude/plugins/marketplaces/map-room/plugin/scripts/map_room_cli.py doctor`}
          />
          <p className="fn-why" style={{ margin: '0 0 6px' }}>
            Or, from a checkout of The Map Room:{' '}
            <code>python3 plugin/scripts/map_room_cli.py doctor</code>
          </p>
        </Step>
      </ol>

      <div className="fn-warn">
        <span className="fn-k">Nothing to paste</span>
        <p style={{ margin: 0 }}>
          There is no id to copy anywhere in the happy path. On your first prompt
          the plugin runs <code>git remote get-url origin</code>, turns it into{' '}
          <code>owner/repo</code>, and matches that against the indexed slug. If
          your remote is <strong>{slug}</strong>, it binds itself and starts
          reporting. Then it prints your session link into the terminal, once:
        </p>
        <pre style={{ margin: '8px 0 0' }}>{`[The Map Room] this session: ${sessionLink(slug, '2b7dbe79-be1d-48fe-a172-fa3cb8edfe09')}`}</pre>
      </div>

      {/* ── honest failure modes ───────────────────────────────────────── */}
      <h2>When it does not work</h2>
      <ul className="fn-faq">
        <li>
          <p className="fn-q"><strong>The doctor prints an empty repo_id, and the map stays dark.</strong></p>
          <p className="fn-a">
            The plugin could not match your checkout to an indexed repository, so
            it is reporting nothing — deliberately. There is no default repository
            id: if there were, every unconfigured checkout would light up somebody
            else's map. The three causes are below.
          </p>
        </li>
        <li>
          <p className="fn-q"><strong>Your repository is not indexed yet.</strong></p>
          <p className="fn-a">
            The doctor says <code>not-indexed</code>. Index it from the front page
            — three and a half seconds — or run{' '}
            <code>python3 plugin/scripts/map_room_cli.py index</code>.
          </p>
        </li>
        <li>
          <p className="fn-q"><strong>There is no origin remote.</strong></p>
          <p className="fn-a">
            The doctor says <code>no-remote</code>. Nothing to match on. Use the
            escape hatch below.
          </p>
        </li>
        <li>
          <p className="fn-q"><strong>You are on a fork, or in one repo of a monorepo.</strong></p>
          <p className="fn-a">
            Your remote's <code>owner/repo</code> is not the indexed one, so it
            binds to the wrong map or to none. Escape hatch below.
          </p>
        </li>
        <li>
          <p className="fn-q"><strong>Everything looks right and still nothing happens.</strong></p>
          <p className="fn-a">
            You have not restarted Claude Code since installing. Hooks load at
            session start. This is step 5 and it is the one people skip.
          </p>
        </li>
        <li>
          <p className="fn-q"><strong>The binding is cached and now stale.</strong></p>
          <p className="fn-a">
            A resolved binding is trusted for a week. After indexing a repository
            that was previously unindexed, run{' '}
            <code>python3 plugin/scripts/map_room_cli.py rebind</code> to forget it.
          </p>
        </li>
      </ul>

      <h2>The escape hatch</h2>
      <p>
        Only for the cases above. Drop a <code>.map-room.json</code> at the root of
        your checkout and the plugin stops guessing:
      </p>
      <Copy
        title="the escape hatch file"
        text={`{ "repo_id": ${repo ? String(repo.id) : 'N'} }`}
      />
      <p className="fn-why">
        {repo
          ? <>That is this repository's id. It is a pin, not a default — it overrides the git remote entirely.</>
          : <>Replace N with the repository's id.</>}
      </p>

      <h2>Before you install it on everything</h2>
      <div className="fn-warn">
        <span className="fn-k">Read this</span>
        <p style={{ margin: '0 0 8px' }}>
          The plugin installs at <strong>user scope</strong>. Its hook fires in{' '}
          <em>every</em> repository you open in Claude Code, and it reports the
          file paths it sees into a table that anybody with the link can read. It
          only reports for a repository whose remote matches an indexed one — but
          an indexed repository is a public one, and the paths you touched in it
          become public too.
        </p>
        <p style={{ margin: 0 }}>Turn it off when you are not watching the map:</p>
        <Copy title="disable the plugin" text="claude plugin disable map-room@map-room" />
      </div>

      <div className="actions">
        <button type="button" className="ctl primary" onClick={() => go(base)}>
          Open the map
        </button>
        <button type="button" className="ctl" onClick={() => go(projectsLink())}>
          All projects
        </button>
      </div>
    </Shell>
  )
}

function ago(ms) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
