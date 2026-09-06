import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRoom } from '../lib/room.jsx'
import { indexRepo, enrichAll, summarizeDirsAll, rememberedKey } from '../lib/live'
import { isGithubSlug, parseIndexResult, parseRepoInput, projectLink, projectsLink } from '../lib/funnel'
import { Shell, go } from './FunnelKit.jsx'
import ConnBadge from './ConnBadge.jsx'
import HeroMap, { MapLegend } from './HeroMap.jsx'
import PreviewMaps from './PreviewMaps.jsx'

/** Roughly how long indexing takes, whatever the repo size. Used only to
 *  animate an honest bar — the answer, not the clock, is what ends it. */
/** The GitHub tree call. Flat in repo size — one request. */
const TREE_MS = 3400
/** Reading every file afterwards. Scales with the repo; the module caps at 150s. */
const READ_MS = 60000

/** Where the method behind the one measured number on this page is written down. */
const REPO = 'https://github.com/Piyush-sahoo/spacetime-hacks'

export default function Landing() {
  const { repos, participants, store } = useRoom()
  const [text, setText] = useState('')
  const [phase, setPhase] = useState('idle') // idle | working | done | failed
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState('tree')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)
  const timers = useRef([])
  // The second pass, when a key is remembered. null until it starts.
  const [, setEnrich] = useState(null)
  const stopEnrich = useRef(false)
  useEffect(() => () => { stopEnrich.current = true }, [])

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
   * Never a number that was typed in. A row with no files is a failed index
   * rather than a map — the gallery filters those out, so this filters them out
   * too, or the two pages disagree in front of the person.
   */
  const shown = useMemo(() => {
    const size = (r) => Number(r.nodeCount ?? r.node_count ?? 0)
    return (repos || [])
      .filter((r) => size(r) > 0 && r.slug)
      .map((r) => ({ slug: String(r.slug), nodes: size(r) }))
  }, [repos])

  /**
   * THE COUNTER IS THE PRODUCT, IN MINIATURE.
   *
   * Every number here is counted from the same subscription the maps are drawn
   * from — so it moves for the same reason they do. Somebody indexing a repo in
   * another country moves REPOSITORIES while you are reading the page, and
   * nobody refreshed anything. That is the claim the page makes in prose two
   * paragraphs down, made instead by a number that ticks.
   *
   * It is derived from `shown` — the very list the gallery renders — rather than
   * re-filtering `repos` alongside it. Two copies of "a row with no files is a
   * failed index, not a map" is two chances to drift, and the failure would be a
   * counter contradicting the grid directly beneath it, in front of a person.
   */
  const counts = useMemo(() => ({
    repos: shown.length,
    files: shown.reduce((n, r) => n + r.nodes, 0),
    watching: (participants || []).filter((p) => p.online).length,
  }), [shown, participants])

  /**
   * The range on the map, in one clause, counted from the map.
   *
   * Never a number that was typed in. The biggest is named as a REAL
   * `owner/repo` rather than a SWE-bench instance id like `django__django-10097`
   * — it is the largest row, but nobody recognises it.
   */
  const range = useMemo(() => {
    if (!shown.length) return ''
    const named = shown.filter((r) => isGithubSlug(r.slug))
    const big = (named.length ? named : shown).reduce((a, b) => (b.nodes > a.nodes ? b : a))
    const small = Math.min(...shown.map((r) => r.nodes))
    return `From a ${small}-file library to ${big.slug} at ${big.nodes.toLocaleString()} files.`
  }, [shown])

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

    // TWO PHASES, BECAUSE THERE ARE TWO.
    //
    // The tree arrives in about three seconds; then the database reads every
    // file to count what is in it and write what it does, and that takes as
    // long as the repository is big. A single bar calibrated to the first
    // phase hit 92% and then sat there for two minutes looking hung.
    //
    // So the bar walks fast to the tree mark, then slowly across the reading,
    // and the line underneath says which one is happening. It never reaches
    // 100% on a timer — only a real answer finishes it.
    const started = Date.now()
    const tick = () => {
      const ms = Date.now() - started
      const pct = ms < TREE_MS
        ? Math.round((ms / TREE_MS) * 26)
        : Math.min(94, 26 + Math.round(((ms - TREE_MS) / READ_MS) * 68))
      setProgress(pct)
      setStage(ms < TREE_MS ? 'tree' : 'read')
      if (pct < 94) timers.current.push(setTimeout(tick, 200))
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

      // A map with nothing written on it is half a map. If a key is remembered,
      // the second pass runs here rather than waiting for somebody to find a
      // separate button — every block gets its size and its sentence as part of
      // adding the repo, which is what "add my repo" was always asking for.
      const key = rememberedKey()
      const files = Number(parsedOut.nodes) || 0
      if (key && parsedOut.repoId && files > 0) {
        setEnrich({ done: 0, total: files })
        const res = await enrichAll(
          parsedOut.repoId, files, key,
          (p) => setEnrich({ done: p.done, total: files }),
          () => stopEnrich.current
        )
        setEnrich(res.ok ? { done: res.done, total: files, finished: true }
                         : { done: res.done, total: files, error: res.error })

        // And then the directories. This one reads NO files — every sentence it
        // needs was just written into `file_meta` — so it is a handful of model
        // calls over text the database already holds, and it is what lets the
        // map answer "what is this whole folder for" the first time somebody
        // clicks a boundary instead of a block.
        if (res.ok && !stopEnrich.current) {
          const dirs = await summarizeDirsAll(
            parsedOut.repoId, key,
            (p) => setEnrich({ done: res.done, total: files, finished: true, dirs: p.done }),
            () => stopEnrich.current
          )
          setEnrich({
            done: res.done, total: files, finished: true,
            dirs: dirs.done, dirTotal: dirs.total, dirError: dirs.ok ? null : dirs.error,
          })
        }
      }
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
      {/* ── 1 · the map ───────────────────────────────────────────────────── */}
      <span className="eyebrow">One room · every tab sees the same map</span>
      <h1>Watch the map your agent is actually using.</h1>

      <div className="livecount" aria-live="polite">
        <span className="lc">
          <b>{counts.repos}</b>
          <i>{counts.repos === 1 ? 'repository' : 'repositories'}</i>
        </span>
        <span className="lc">
          <b>{counts.files.toLocaleString()}</b>
          <i>files mapped</i>
        </span>
        <span className="lc">
          <b>{counts.watching}</b>
          <i>{counts.watching === 1 ? 'person watching' : 'watching right now'}</i>
        </span>
        <span className="lc dot" title="These numbers come off the live subscription, not a build-time constant">
          <em />live
        </span>
      </div>

      <p className="fn-lede">
        Every file is a block. It lights the moment your agent reads it, on every
        screen watching, at the same moment.
      </p>

      <HeroMap />

      <p className="fn-cap">
        <span className="fn-k">A demonstration</span>
        Real files from this repository, on a scripted walk. The live ones are below.
      </p>

      {/* ── the conversion action ─────────────────────────────────────────── */}
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
        Public repositories. The map itself lands in about three seconds; reading
        every file to describe it takes a little longer.
        Nothing is cloned and no token is sent.
      </p>

      {busy && (
        <>
          <div className="fn-bar" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${progress}%` }} />
          </div>
          <p className="fn-why" style={{ margin: 0 }}>
            {stage === 'tree'
              ? 'Fetching the tree from GitHub and building the graph.'
              : 'Reading each file — counting what is in it, and writing what it does.'}
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

      {/* ── 2 · the previews: real maps, not pictures of them ─────────────── */}
      <h2>{shown.length ? `${shown.length} maps are already live` : 'Maps that are already live'}</h2>
      <PreviewMaps />
      <p className="fn-why">
        {range} Drawn out of the database as you look at them. Open one and you
        are in that room.
      </p>
      <div className="actions">
        <button type="button" className="ctl" onClick={() => go(projectsLink())}>
          Browse the projects
        </button>
      </div>

      {/* ── 3 · the colours ───────────────────────────────────────────────── */}
      <h2>What the colours mean</h2>
      <MapLegend />

      {/* ── 4 · the one piece of evidence ─────────────────────────────────── */}
      <h2>Why a map, and not a summary</h2>
      <Cliff />
      <p className="fn-why">
        Both rows are a repo map that keeps only the top-K symbols, against the
        tests that guard the fix.{' '}
        <a href={REPO} target="_blank" rel="noreferrer">The method</a>.
      </p>

      {/* ── 5 · the honesty ───────────────────────────────────────────────── */}
      <div className="fn-warn">
        <span className="fn-k">One number we will not print</span>
        <p style={{ margin: 0 }}>
          Recall on <em>your</em> repository — it is not computable without
          labelled fixes, and we are not going to invent one. The map reports
          what was explored; it does not claim what was missed.
        </p>
      </div>
    </Shell>
  )
}

/**
 * THE CONTEXT CLIFF, as forty-four squares.
 *
 * The sharpest fact on the page used to be a clause inside a paragraph. It is
 * one comparison against one denominator, so it is drawn as the denominator:
 * forty-four guarding tests, and the ones a top-K repo map actually reaches
 * filled in. The rest are dashed, which here means what it means everywhere
 * else on this product — it is not there.
 */
const CLIFF = [
  { budget: '400 symbols kept', reached: 2 },
  { budget: '200 or fewer', reached: 0 },
]
const TOTAL = 44

function Cliff() {
  return (
    <div className="fn-cliff">
      {CLIFF.map((row) => (
        <div key={row.budget} className="fn-cliff-row">
          <span className="fn-cliff-k">{row.budget}</span>
          <div className="fn-cells" aria-hidden="true">
            {Array.from({ length: TOTAL }, (_, i) => (
              <i key={i} className={i < row.reached ? 'on' : undefined} />
            ))}
          </div>
          <span className="fn-cliff-n fn-num"><b>{row.reached}</b> of {TOTAL}</span>
        </div>
      ))}
      <span className="fn-cliff-foot">Guarding tests the walk arrives at, out of 44</span>
    </div>
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
