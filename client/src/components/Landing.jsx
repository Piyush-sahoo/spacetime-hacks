import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRoom } from '../lib/room.jsx'
import { indexRepo } from '../lib/live'
import { isGithubSlug, parseIndexResult, parseRepoInput, projectLink, projectsLink } from '../lib/funnel'
import { Shell, go } from './FunnelKit.jsx'
import ConnBadge from './ConnBadge.jsx'

/** Roughly how long indexing takes, whatever the repo size. Used only to
 *  animate an honest bar — the answer, not the clock, is what ends it. */
const EXPECTED_MS = 3400

export default function Landing() {
  const { repos } = useRoom()
  const [text, setText] = useState('')
  const [phase, setPhase] = useState('idle') // idle | working | done | failed
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)
  const timers = useRef([])

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  /** Slugs already on the map, so "already indexed" can be said as a fact. */
  const known = useMemo(() => {
    const m = new Map()
    for (const r of repos || []) if (r.slug) m.set(String(r.slug).toLowerCase(), r)
    return m
  }, [repos])

  /**
   * What is on the map, counted from the map.
   *
   * This sentence used to be typed in ("Ten repositories..."), and it went
   * stale the first time anybody indexed anything -- which is the one thing
   * this page invites every visitor to do. It is the same rule the rest of the
   * funnel follows: never state a number the database did not just report.
   */
  const alreadyHere = useMemo(() => {
    // A row with no files is a failed index, not a map -- the gallery filters
    // those out, so the count here has to filter them out too or the two pages
    // disagree in front of the person.
    const shown = (repos || []).filter((r) => Number(r.nodeCount ?? r.node_count ?? 0) > 0)
    if (!shown.length) return 'Repositories that have already been indexed are in the gallery.'
    const size = (r) => Number(r.nodeCount ?? r.node_count ?? 0)
    // Name the biggest REAL `owner/repo`, never a SWE-bench instance id like
    // `django__django-10097`: it is the largest row, but nobody recognises it,
    // and the gallery already ranks a real slug ahead of one for that reason.
    const named = shown.filter((r) => isGithubSlug(r.slug))
    const big = (named.length ? named : shown).reduce((a, b) => (size(b) > size(a) ? b : a))
    const small = Math.min(...shown.map(size))
    return `${shown.length} repositories are already on the map, from a ${small}-file `
      + `library to ${big.slug} at ${size(big).toLocaleString()} files.`
  }, [repos])

  const submit = useCallback(async (e) => {
    e?.preventDefault?.()
    if (phase === 'working') return

    const parsed = parseRepoInput(text)
    if (parsed.error) {
      setPhase('failed'); setError(parsed.error); setResult(null)
      inputRef.current?.focus()
      return
    }

    const already = known.get(parsed.slug.toLowerCase())
    setPhase('working'); setError(null); setResult(null); setProgress(0)

    // The bar walks to 92% over the expected duration and then waits. It never
    // reaches 100% on a timer — only a real answer finishes it.
    const started = Date.now()
    const tick = () => {
      const pct = Math.min(92, Math.round((Date.now() - started) / EXPECTED_MS * 92))
      setProgress(pct)
      if (pct < 92) timers.current.push(setTimeout(tick, 120))
    }
    tick()

    try {
      const out = await indexRepo(parsed.owner, parsed.repo)
      const parsedOut = parseIndexResult(out)
      timers.current.forEach(clearTimeout)
      setProgress(100)

      if (!parsedOut.ok) {
        setPhase('failed')
        setError(parsedOut.message)
        return
      }
      setPhase('done')
      setResult({ ...parsedOut, slug: parsedOut.slug || parsed.slug, already: !!already })
    } catch (err) {
      timers.current.forEach(clearTimeout)
      setProgress(0)
      setPhase('failed')
      setError(err?.message || 'could not reach the database')
    }
  }, [text, phase, known])

  const busy = phase === 'working'

  return (
    <Shell nav={<ConnBadge />}>
      <span className="eyebrow">One room · every tab sees the same map</span>
      <h1>Watch the map your agent is actually using.</h1>

      <p className="fn-lede">
        Every file in your repository is a block on one map. The moment your agent
        reads a file, that block lights — on every screen watching, at the same
        moment. Not a refresh and not a poll: the tool call goes into SpacetimeDB
        and straight back out to every connected tab.
      </p>

      <h2>Why a map at all</h2>

      <p>
        An agent fixes a bug by walking from the code it can see to the test that
        guards the fix. So the question worth measuring is a plain one: does that
        walk arrive? We measured it on <strong>172 human-verified bug fixes across
        7 repositories</strong>.
      </p>

      <div className="fn-scroll">
        <table className="fn-facts-table">
          <thead>
            <tr><th>How the call graph was built</th><th>Reaches the guarding test</th></tr>
          </thead>
          <tbody>
            <tr><td>Name-matched</td><td className="fn-n">31.4%</td></tr>
            <tr><td>Type-resolved</td><td className="fn-n">41.9%</td></tr>
            <tr><td>On matplotlib and pytest, either way</td><td className="fn-n">0%</td></tr>
          </tbody>
        </table>
      </div>

      <p>
        And an agent's context is finite, so a repo map keeps only the top-K
        symbols and drops the rest. At <span className="fn-num">400</span> symbols
        kept it reaches <span className="fn-num">2</span> of{' '}
        <span className="fn-num">44</span> guarding tests. At{' '}
        <span className="fn-num">200</span> or fewer, zero.
      </p>

      <p>
        That is what this is for. It does not make the walk arrive more often. It
        shows you where your agent has actually been, so the parts it never reaches
        stop being invisible to you.
      </p>

      <div className="fn-warn">
        <span className="fn-k">One number we will not print</span>
        <p style={{ margin: 0 }}>
          Recall on <em>your</em> repository. It is not computable without labelled
          fixes, and we are not going to invent one. The map reports what was
          explored. It does not claim what was missed.
        </p>
      </div>

      <h2>Put your repository on the map</h2>

      <form className="fn-form" onSubmit={submit}>
        <input
          ref={inputRef}
          className="fn-input"
          value={text}
          onChange={(e) => { setText(e.target.value); if (phase === 'failed') setPhase('idle') }}
          placeholder="github.com/owner/repo   or   owner/repo"
          aria-label="A GitHub repository URL, or owner/repo"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={busy}
        />
        <button type="submit" className="ctl primary" disabled={busy}>
          {busy ? 'Indexing…' : 'Index it'}
        </button>
      </form>

      <p className="fn-why" style={{ marginTop: 8 }}>
        Reads the repository's public file tree from GitHub and builds the graph
        inside the database. About three and a half seconds whatever the size —
        django/django is 7,087 files and lands in under four. Public repositories
        only. Nothing is cloned, and no token is sent.
      </p>

      {busy && (
        <>
          <div className="fn-bar" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${progress}%` }} />
          </div>
          <p className="fn-why" style={{ margin: 0 }}>
            Fetching the tree from GitHub and building the graph. This usually
            takes about 3.4 seconds.
          </p>
        </>
      )}

      {phase === 'done' && result && <Landed result={result} />}

      {phase === 'failed' && error && (
        <div className="fn-note fn-bad" role="alert">
          <span className="fn-k">Not indexed</span>
          <p style={{ margin: 0 }}>{error}</p>
          <p className="fn-why" style={{ margin: '6px 0 0' }}>{advice(error)}</p>
        </div>
      )}

      <h2>Or just look at one that is already here</h2>
      <p>{alreadyHere}</p>
      <div className="actions">
        <button type="button" className="ctl" onClick={() => go(projectsLink())}>
          Browse the projects
        </button>
      </div>
    </Shell>
  )
}

/** What just happened, said plainly, with the way onward. */
function Landed({ result }) {
  return (
    <div className="fn-note">
      <span className="fn-k">{result.already ? 'Already on the map' : 'On the map'}</span>
      <p style={{ margin: '0 0 6px' }}>
        <strong>{result.slug}</strong>
        {result.already
          ? ' was already indexed, so nothing changed. Indexing is idempotent — the same repository always lands on the same map.'
          : ' is indexed.'}
      </p>
      <p className="fn-why" style={{ margin: '0 0 8px' }}>
        <span className="fn-num">{Number(result.nodes || 0).toLocaleString()}</span> files ·{' '}
        <span className="fn-num">{Number(result.edges || 0).toLocaleString()}</span> edges ·{' '}
        read from <span className="fn-num">{Number(result.blobs || 0).toLocaleString()}</span> blobs
      </p>
      {result.truncated && (
        <p className="fn-expect" style={{ marginBottom: 8 }}>
          <b>Partial map.</b> GitHub truncated the file tree for this repository,
          so some files are missing from the map. What is here is real; it is just
          not all of it.
        </p>
      )}
      {result.capped && (
        <p className="fn-expect" style={{ marginBottom: 8 }}>
          <b>Capped.</b> The repository is larger than one index pass, so the map
          holds the first slice of it.
        </p>
      )}
      <div className="actions">
        <button type="button" className="ctl primary" onClick={() => go(projectLink(result.slug))}>
          Open {result.slug}
        </button>
      </div>
    </div>
  )
}

/** One sentence of what to do about it, per failure the database actually returns. */
function advice(message) {
  const m = String(message).toLowerCase()
  if (m.includes('404')) {
    return 'GitHub has no public repository at that name. Check the spelling — and note that a private repository cannot be indexed, because nothing here is authenticated against GitHub.'
  }
  if (m.includes('no indexable source files')) {
    return 'The tree was read, but nothing in it is source we can build a graph from. A repository of documentation, data or notebooks has no call graph to map.'
  }
  if (m.includes('owner and repo are required')) {
    return 'The owner or the repository name came through empty.'
  }
  if (m.includes('403') || m.includes('rate')) {
    return 'GitHub is rate-limiting the database right now. Wait a minute and try again.'
  }
  return 'Nothing was written to the map. Try again, or pick one of the repositories that is already indexed.'
}
