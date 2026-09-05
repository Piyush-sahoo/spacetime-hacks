/**
 * The funnel's own logic: reading what a person pasted, reading what the
 * database answered, and building the two links.
 *
 * Kept out of the components so every branch here is testable on its own, and
 * so the ONE rule that matters — never claim a success the database did not
 * report — lives in a single function.
 */

/** Where this build is being watched. Whatever origin actually served it. */
export const SITE =
  typeof window !== 'undefined' ? window.location.origin : ''

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
/** GitHub's own rules: no leading dot/dash, and a short list of legal chars. */
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** github.com's reserved first path segments — never an owner. */
const RESERVED = new Set([
  'features', 'topics', 'trending', 'collections', 'events', 'sponsors',
  'about', 'pricing', 'enterprise', 'settings', 'notifications', 'explore',
  'marketplace', 'apps', 'orgs', 'login', 'join', 'new', 'search',
])

/**
 * Anything a person might paste -> { owner, repo, slug } or { error }.
 *
 * Accepts `owner/repo`, an https URL, an ssh remote, a URL with a branch or a
 * file path after it, and a `.git` suffix. Everything else is refused with a
 * sentence rather than silently mangled into a lookup that will 404 later.
 */
export function parseRepoInput(raw) {
  let s = String(raw || '').trim()
  if (!s) return { error: 'Paste a GitHub repo first.' }

  // git@github.com:owner/repo.git -> github.com/owner/repo
  s = s.replace(/^[a-z]+:\/\//i, '').replace(/^[^@\s/]+@/, '').replace(/:(?=[^/\d])/, '/')
  s = s.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')

  const parts = s.split('/').filter(Boolean)
  if (parts.length && parts[0].includes('.')) {
    const host = parts[0].toLowerCase()
    if (!GITHUB_HOSTS.has(host)) {
      return {
        error: `Only GitHub is supported — the map is built from GitHub's tree API. ${parts[0]} is not GitHub.`,
      }
    }
    parts.shift()
  }

  if (parts.length < 2) {
    return { error: 'That needs to be owner/repo — for example pallets/flask.' }
  }

  const [owner, repo] = parts
  if (RESERVED.has(owner.toLowerCase())) {
    return { error: `${owner} is a github.com page, not an owner. Paste the repo itself.` }
  }
  if (!PART.test(owner) || !PART.test(repo)) {
    return { error: 'That does not look like a GitHub owner and repo name.' }
  }
  return { owner, repo, slug: `${owner}/${repo}` }
}

/**
 * The status string `index_repo` returns -> a result object.
 *
 * The procedure answers with `ok repo_id=N slug=... blobs=N nodes=N edges=N
 * truncated=bool capped=bool ...` or with `error: <sentence>`, and it answers
 * with HTTP 200 either way — so the ONLY thing that decides success is this
 * string. A shape we do not recognise is treated as a failure, never as a
 * success: the cost of a false "done" is a person staring at an empty map.
 */
export function parseIndexResult(text) {
  const s = String(text ?? '').trim().replace(/^"|"$/g, '')
  if (!s) return { ok: false, message: 'The database answered with nothing.' }
  if (/^error\b/i.test(s)) {
    return { ok: false, message: s.replace(/^error:?\s*/i, '') || 'indexing failed' }
  }
  if (!/^ok\b/.test(s)) return { ok: false, message: s }

  const field = (k) => {
    const m = s.match(new RegExp(`\\b${k}=([^\\s]+)`))
    return m ? m[1] : null
  }
  const num = (k) => {
    const v = field(k)
    const n = v === null ? NaN : Number(v)
    return Number.isFinite(n) ? n : null
  }
  const repoId = num('repo_id')
  const nodes = num('nodes')
  if (repoId === null) return { ok: false, message: s }

  return {
    ok: true,
    repoId,
    slug: field('slug'),
    blobs: num('blobs'),
    nodes,
    edges: num('edges'),
    // The repo was bigger than one tree request: the map is a real but partial
    // map, and saying so is the whole point.
    truncated: field('truncated') === 'true',
    capped: field('capped') === 'true',
    raw: s,
  }
}

/** Everything every agent has ever explored in this repo. */
export const baseLink = (slug) => `${SITE}/?repo=${encodeURIComponent(String(slug))}`

/** One session's route, and nothing else. */
export const sessionLink = (slug, session) =>
  `${baseLink(slug)}&session=${encodeURIComponent(String(session))}`

/** Funnel routes. Every one of them is a real URL, so back and share work. */
export const projectsLink = () => `${SITE}/?view=projects`
export const projectLink = (slug) => `${SITE}/?project=${encodeURIComponent(String(slug))}`

/** A real `owner/repo`, as opposed to a SWE-bench instance id like `django__django-11292`. */
export const isGithubSlug = (slug) => /^[^/\s]+\/[^/\s]+$/.test(String(slug || ''))

/**
 * How recent an agent row has to be to count as here NOW.
 *
 * `end_session` switches `online` off properly now, but rows written before
 * that reducer existed — and rows from a session that was killed rather than
 * ended — can still say `true` forever. So liveness is BOTH flags: the row says
 * online, and it has moved inside this window. An agent that has gone quiet
 * reads as gone, which is the honest answer.
 */
export const LIVE_WINDOW_MS = 120000

export function liveAgentCount(sessions, repoId, now = Date.now()) {
  const id = String(repoId)
  let n = 0
  for (const s of sessions || []) {
    if (String(s.repoId ?? s.repo_id) !== id) continue
    if (!s.online) continue
    if (now - millis(s.lastAt ?? s.last_at) > LIVE_WINDOW_MS) continue
    n += 1
  }
  return n
}

/** Total tool calls any agent has ever reported against this repo. */
export function reportedTouches(sessions, repoId) {
  const id = String(repoId)
  let n = 0
  for (const s of sessions || []) {
    if (String(s.repoId ?? s.repo_id) === id) n += Number(s.touches || 0)
  }
  return n
}

/** SpacetimeDB timestamps arrive as micros, as Date, or as a plain number. */
export function millis(ts) {
  if (ts == null) return 0
  if (ts instanceof Date) return ts.getTime()
  if (typeof ts === 'object') {
    const micros = ts.microsSinceUnixEpoch ?? ts.micros_since_unix_epoch ?? ts.__timestamp_micros_since_unix_epoch__
    if (micros != null) return Number(micros) / 1000
  }
  const n = Number(ts)
  if (!Number.isFinite(n)) return 0
  return n > 1e14 ? n / 1000 : n
}
