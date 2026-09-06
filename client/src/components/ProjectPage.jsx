import { useEffect, useMemo, useRef, useState } from 'react'
import { enrichRepoOverHttp, parseEnrich, watchDirectory, rememberedKey, rememberKey } from '../lib/live'
import {
  baseLink, isLiveSession, liveAgentCount, millis, projectsLink, sessionLink,
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
  // Whether the LINKED session is here, which is a different question from
  // whether anybody is: an ended session must not be captioned "live now"
  // because some other agent happens to be connected to the same repository.
  const latestLive = isLiveSession(latest)
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
              This session {latestLive ? '· live now' : `· last seen ${ago(millis(latest.lastAt ?? latest.last_at))}`}
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

      <Deepen repo={repo} />

      {/* ── one paste, any agent ───────────────────────────────────────── */}
      <SetupPrompt slug={slug} base={base} />

      {/* ── the walkthrough ────────────────────────────────────────────── */}
      <h2>Or do it yourself — six steps</h2>
      <p>
        The manual path, for Claude Code, if you would rather run the commands
        than hand them to an agent. You need Python 3 (standard library only,
        nothing to pip install). Steps 1 to 4 are run <strong>once, ever</strong>.
        Step 6 is run inside the repository you actually want to watch.
      </p>

      <ol className="fn-steps">
        <Step
          n={1}
          title="Log in to SpacetimeDB"
          why="The login writes the bearer token the plugin reads out of ~/.config/spacetime/cli.toml. Without it the plugin has nothing to authenticate with. No CLI yet? curl -sSf https://install.spacetimedb.com | sh"
          expect={<><b>Expect:</b> the CLI prints the identity you are now logged in as.</>}
        >
          <Copy title="log in" text={'spacetime login'} />
        </Step>

        <Step
          n={2}
          title="Add the marketplace"
          why="Straight from GitHub — nothing to clone, and it runs from any directory. Claude Code fetches the repository itself."
          expect={<><b>Expect:</b> <code>Successfully added marketplace: map-room</code>.</>}
        >
          <Copy title="add the marketplace" text={'claude plugin marketplace add Piyush-sahoo/spacetime-hacks'} />
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
          why="The hook count is the one number that tells you whether the build you installed is the current one. Claude Code caches a plugin by version number, so an install that says it succeeded can still be handing you an older copy."
          expect={<>
            <b>Expect:</b> <code>Skills (1)</code> and <code>Hooks (5)</code> —
            PostToolUse, UserPromptSubmit, Stop, SessionEnd, SubagentStop. If it
            says <code>Hooks (3)</code> you are on a cached older build: go back
            and run step 2 again, then step 3. See the last entry under{' '}
            <em>When it does not work</em>.
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
            text={'cd /path/to/your/repo\npython3 "$(ls -d ~/.claude/plugins/cache/map-room/map-room/*/scripts/map_room_cli.py | tail -1)" doctor'}
          />
          <p className="fn-why" style={{ margin: '0 0 6px' }}>
            Run it from inside the repository you want checked — the doctor reads
            the current directory to work out which map this checkout belongs to.
            The installed copy of the script lives under{' '}
            <code>~/.claude/plugins/cache/map-room/map-room/&lt;version&gt;/scripts/</code>,
            and that version moves every time the plugin updates, which is why the
            command globs for it rather than naming one.
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
            — three and a half seconds — or run the same globbed script path from
            step 6 with <code>index</code> instead of <code>doctor</code>.
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
          <p className="fn-q"><strong>python3 says it cannot open that file.</strong></p>
          <p className="fn-a">
            The glob found nothing, which means the plugin is not installed —
            go back to step 3. Check what is actually there with{' '}
            <code>ls ~/.claude/plugins/cache/map-room/map-room/</code>; you
            should see a version directory. Do not hand-type a version number,
            because it moves on every update.
          </p>
        </li>
        <li>
          <p className="fn-q"><strong>Step 4 says Hooks (3), and reinstalling does not change it.</strong></p>
          <p className="fn-a">
            Claude Code caches an installed plugin under{' '}
            <code>~/.claude/plugins/cache/map-room/map-room/&lt;version&gt;/</code>,
            keyed on the version in the manifest — so <code>install</code> is a
            silent no-op when that version is already there, however much the code
            behind it changed. Run{' '}
            <code>claude plugin marketplace update map-room</code>, then{' '}
            <code>claude plugin uninstall map-room@map-room</code> and step 3
            again. The uninstall is the part that matters. Confirm with step 4
            before going further: on the old three-hook build a session that ends
            never switches its agent off, and the map keeps showing it as live.
          </p>
        </li>
        <li>
          <p className="fn-q"><strong>The binding is cached and now stale.</strong></p>
          <p className="fn-a">
            A resolved binding is trusted for a week. After indexing a repository
            that was previously unindexed, run the step 6 command with{' '}
            <code>rebind</code> instead of <code>doctor</code> to forget it.
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

/** Files per call. Small enough that a batch answers in about four seconds. */
const ENRICH_BATCH = 20

/**
 * Deepen this map — the second pass, driven from here rather than at index time.
 *
 * Indexing reads a repo's file TREE and is instant. That is what makes pasting a
 * URL feel free, and it is also what leaves the map thin: one node per file, and
 * the only edges directory containment, so every block stands the same height
 * and an impact walk traverses FOLDERS rather than dependencies.
 *
 * This reads the file CONTENTS. It is opt-in, batched, and resumable on
 * `offset`, so django/django's 2,975 files are a thing you can start, watch, and
 * stop — and nobody who pastes a large repo pays for it without asking.
 *
 * The import edges come from a REGEX and are written with no model involved at
 * all: the key box is optional and only ever buys the one-sentence summaries.
 * That is why the resolution counters are on screen rather than in a log — an
 * import that resolved to nothing was DROPPED, and the count of those is the
 * honest measure of how much of the wiring this actually found.
 */
function Deepen({ repo }) {
  // Remembered in this browser, so it is typed once and every repo added after
  // this one deepens itself as part of being added.
  const [apiKey, setApiKey] = useState(() => rememberedKey())
  const [busy, setBusy] = useState(false)
  const [st, setSt] = useState(null)
  const stop = useRef(false)

  useEffect(() => () => { stop.current = true }, [])

  if (!repo) return null

  const total = Number(repo.nodeCount ?? repo.node_count ?? 0)

  const run = async (startAt) => {
    rememberKey(apiKey)
    stop.current = false
    setBusy(true)
    let off = Number(startAt) || 0
    const acc = {
      offset: off, total, done: 0, skipped: 0, imports: 0,
      seen: 0, resolved: 0, unresolved: 0, ambiguous: 0, llm: '', error: null,
    }
    try {
      for (;;) {
        const r = parseEnrich(await enrichRepoOverHttp(repo.id, off, ENRICH_BATCH, apiKey))
        if (!r.ok) { acc.error = r.error; break }
        acc.done += Number(r.done) || 0
        acc.skipped += Number(r.skipped) || 0
        acc.imports += Number(r.imports) || 0
        acc.seen += Number(r.seen) || 0
        acc.resolved += Number(r.resolved) || 0
        acc.unresolved += Number(r.unresolved) || 0
        acc.ambiguous += Number(r.ambiguous) || 0
        acc.total = Number(r.total) || acc.total
        acc.llm = String(r.llm || '')
        off = Number(r.next) || (off + ENRICH_BATCH)
        acc.offset = off
        setSt({ ...acc })
        if (stop.current) break
        if (!Number(r.done)) break
        if (off >= acc.total) break
      }
    } catch (e) {
      acc.error = String(e?.message || e)
    }
    setSt({ ...acc })
    setBusy(false)
  }

  const pct = st && st.total ? Math.min(100, Math.round((st.offset / st.total) * 100)) : 0
  const rate = st && st.seen ? Math.round((st.resolved / st.seen) * 100) : 0
  const finished = !!st && !busy && !st.error && st.offset >= st.total

  return (
    <>
      <h2>Deepen this map</h2>
      <p>
        Indexing read this repository's file <strong>tree</strong> — every path,
        in about three seconds, which is why it was free. It did not read a
        single file. So every block on the map stands at the same height, and
        the only edges are which folder a file is in.
      </p>
      <p>
        This reads the files. It writes one <code>IMPORTS</code> edge for every
        import statement that resolves to another file in this repository, and
        it counts the functions and classes in each one so the blocks stand at
        different heights. <strong>The edges come from a regular expression, not
        from a model</strong> — an import it cannot resolve is dropped and
        counted, never guessed.
      </p>

      <div className="fn-warn">
        <span className="fn-k">Optional — one-sentence descriptions</span>
        <p style={{ margin: '0 0 8px' }}>
          Leave this empty and everything above still happens. A key only buys
          the sentence that says what each file <em>does</em>, which is the one
          thing a regular expression cannot write. It is sent straight to the
          database as a procedure argument and is never stored anywhere.
        </p>
        <input
          type="password"
          className="ctl"
          style={{ width: '100%', fontFamily: 'inherit' }}
          placeholder="OpenAI API key (optional)"
          value={apiKey}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>

      <div className="actions">
        <button type="button" className="ctl primary" disabled={busy} onClick={() => run(0)}>
          {busy ? 'Reading files…' : 'Deepen this map'}
        </button>
        {st && !busy && st.offset > 0 && st.offset < st.total ? (
          <button type="button" className="ctl" onClick={() => run(st.offset)}>
            Resume from {st.offset}
          </button>
        ) : null}
        {busy ? (
          <button type="button" className="ctl" onClick={() => { stop.current = true }}>
            Stop after this batch
          </button>
        ) : null}
      </div>

      {st ? (
        <div className="fn-note" style={{ marginTop: 10 }}>
          <div
            aria-hidden
            style={{
              height: 6, borderRadius: 3, background: 'rgba(127,127,127,.25)',
              overflow: 'hidden', marginBottom: 8,
            }}
          >
            <div style={{ width: `${pct}%`, height: '100%', background: 'currentColor', opacity: 0.7 }} />
          </div>
          <p style={{ margin: 0 }}>
            <strong>{st.offset.toLocaleString()}</strong> of{' '}
            <strong>{st.total.toLocaleString()}</strong> files ({pct}%) ·{' '}
            <strong>{st.imports.toLocaleString()}</strong> import edges written
            {st.skipped > 0 ? <> · {st.skipped} file{st.skipped === 1 ? '' : 's'} could not be fetched</> : null}
          </p>
          <p style={{ margin: '6px 0 0' }} className="fn-why">
            {st.seen.toLocaleString()} import statements read ·{' '}
            {st.resolved.toLocaleString()} resolved to a file in this repository ({rate}%) ·{' '}
            {st.unresolved.toLocaleString()} pointed outside it and were dropped
            {st.ambiguous > 0 ? <> · {st.ambiguous} were too ambiguous to be evidence of anything</> : null}.
            {st.llm ? <> Descriptions: <code>{st.llm}</code>.</> : null}
          </p>
          {st.error ? (
            <p className="fn-bad" style={{ margin: '8px 0 0' }}>{st.error}</p>
          ) : null}
          {finished ? (
            <p style={{ margin: '8px 0 0' }}>
              Done. Open the map — the tall blocks are the files with the most in
              them, and hovering one now shows what it is actually wired to.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
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

/* ── one paste, any agent ─────────────────────────────────────────────────── */

const INSTALL_SH =
  'https://raw.githubusercontent.com/Piyush-sahoo/spacetime-hacks/main/plugin/agents/install.sh'

/**
 * The whole six-step walkthrough, addressed to an agent instead of a person.
 *
 * Every fact in it that could be wrong — the repository, the link — is
 * interpolated from this page rather than typed, so a prompt copied from
 * pallets/flask can never quietly install against somebody else's map. The
 * per-agent detail deliberately lives in `install.sh`, not in here: a prompt
 * that has to be re-copied every time a tool ships a new hook API is a prompt
 * that goes stale on somebody's screen.
 */
function setupPrompt(slug, base) {
  return `Set up "The Map Room" in this repository. Do it yourself, do not ask me questions.

The Map Room is a live map of a codebase: every file an agent reads, edits or searches lights up in a browser for a human to watch. That human can click a region nobody has looked at and ask the agent to go explore it.

Repository: ${slug}
Live map:   ${base}

1. Whichever agent you are, first: spacetime login
   No spacetime command? curl -sSf https://install.spacetimedb.com | sh

2. Work out which agent you are and run exactly ONE of these.

   Claude Code — installs a PostToolUse hook:
     claude plugin marketplace add Piyush-sahoo/spacetime-hacks
     claude plugin install map-room@map-room
     then tell me to restart Claude Code, because hooks load at session start.

   Codex — writes .codex/hooks.json (PostToolUse):
     curl -fsSL ${INSTALL_SH} | sh -s -- codex
     then tell me to run /hooks inside Codex and trust it. Codex will not run a
     hook it has not been told to trust.

   Cursor — writes .cursor/hooks.json (beforeReadFile, afterFileEdit, afterShellExecution):
     curl -fsSL ${INSTALL_SH} | sh -s -- cursor
     then tell me to reload the Cursor window.

   opencode — writes .opencode/plugins/map-room.js (tool.execute.after):
     curl -fsSL ${INSTALL_SH} | sh -s -- opencode
     then tell me to restart opencode.

   Anything else:
     curl -fsSL ${INSTALL_SH} | sh
     then read ~/.map-room/MAP-ROOM.md and wire it into whatever hook, rule or
     instruction file your tool has. If it has none, follow that file and call
     the report command yourself after you read files.

3. Verify. From the root of this repository:
     python3 ~/.map-room/map_room_cli.py doctor
   On Claude Code the plugin brings its own copy, so run instead:
     python3 "$(ls -d ~/.claude/plugins/cache/map-room/map-room/*/scripts/map_room_cli.py | tail -1)" doctor

   Good: repo_id has a number, repo_slug is ${slug}, token says found.

   repo_id : UNBOUND is not a bug. A repository nobody has indexed reports
   NOTHING, deliberately — there is no default map to fall back to. Fix it by
   running that same script with "index" instead of "doctor", then "rebind".

4. Prove it. Read one real file in this repository, then:
     python3 ~/.map-room/map_room_cli.py report <that file>

5. From then on, when the human clicks a region on the map, answer it:
     python3 ~/.map-room/map_room_cli.py pending
     python3 ~/.map-room/map_room_cli.py claim <id>
     python3 ~/.map-room/map_room_cli.py complete <id> "two or three plain lines"
   Never report a file you did not actually open.

6. Report back in four lines: which agent you are; ENFORCED (your tool runs the
   hook, you cannot forget) or COOPERATIVE (you call report yourself); what
   doctor printed for repo_id and token; and the session link step 4 gave you.`
}

/**
 * Enforced or cooperative, stated on the page as plainly as it would be said
 * out loud. All four turned out to have a real per-tool-call hook, so all four
 * are enforced — but the distinction still has to be on the page, because the
 * fallback for a fifth agent is cooperative and the number on the map means
 * something different when it is.
 */
const AGENT_MODES = [
  ['Claude Code', true, 'PostToolUse hook, from the installed plugin.',
    'https://docs.claude.com/en/docs/claude-code/hooks'],
  ['Codex', true, 'PostToolUse hook in .codex/hooks.json. Trust it once via /hooks.',
    'https://developers.openai.com/codex/hooks'],
  ['Cursor', true, 'beforeReadFile, afterFileEdit and afterShellExecution in .cursor/hooks.json.',
    'https://cursor.com/docs/hooks'],
  ['opencode', true, 'A plugin whose tool.execute.after runs on every tool call.',
    'https://opencode.ai/docs/plugins/'],
  ['Anything else', false, 'No hook to install: the agent is asked to call report itself.', null],
]

function SetupPrompt({ slug, base }) {
  const text = useMemo(() => setupPrompt(slug, base), [slug, base])

  return (
    <>
      <h2>One paste, any agent</h2>
      <div className="fn-paste">
        <span className="fn-k">Copy setup instruction</span>
        <p className="fn-what">
          Copy this, paste it into your coding agent, and it installs itself.
          It already names <strong>{slug}</strong> and this map's link, so there
          is nothing to fill in and nothing to decide. Works from Claude Code,
          Codex, Cursor and opencode.
        </p>
        <Copy text={text} title="the setup instruction" />
      </div>

      <div className="fn-scroll">
      <table className="fn-matrix">
        <thead>
          <tr><th>Agent</th><th>How it reports</th><th>What actually fires</th></tr>
        </thead>
        <tbody>
          {AGENT_MODES.map(([name, enforced, how, doc]) => (
            <tr key={name}>
              <td>{name}</td>
              <td className="fn-mode">
                <span className={enforced ? 'fn-tag on' : 'fn-tag'}>
                  {enforced ? 'Enforced' : 'Cooperative'}
                </span>
              </td>
              <td>
                {how}
                {doc && <> <a href={doc} target="_blank" rel="noreferrer">docs</a></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <p className="fn-why" style={{ marginTop: 0 }}>
        <strong>Enforced</strong> means the tool itself runs the reporting
        command on every matching tool call — the model is not asked and cannot
        opt out, which is what makes a dark region mean “nobody read this”.{' '}
        <strong>Cooperative</strong> means the agent has been asked to report
        and can forget. Both write the same rows; only one of them is a
        guarantee. Answering the human's clicks is cooperative everywhere: no
        hook can read a file for you.
      </p>
    </>
  )
}
