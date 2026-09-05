// Both configurable via env; the defaults are the live deployment.
export const STDB_URI = import.meta.env.VITE_STDB_URI || 'wss://maincloud.spacetimedb.com'
export const STDB_MODULE = import.meta.env.VITE_STDB_MODULE || 'map-room'
export const ROOM_SLUG = import.meta.env.VITE_ROOM_SLUG || 'django__django-11292'

// k is fixed by the contract: bounded backwards walk, k = 6.
export const WALK_K = 6

// Cadence at which the tab that started a walk calls step_walk. The reducer is
// a safe no-op once the walk is done, so an over-eager tick costs nothing.
export const STEP_MS = 320
// If a walk stops advancing for this long, another tab may take the wheel, so a
// walk survives its starter closing the tab mid-demo.
export const STALL_TAKEOVER_MS = 2600

// The published measurement the verdict cites. Displayed verbatim; the server
// puts the same numbers on the verdict row.
export const PRIOR = {
  hits: 72,
  n: 172,
  recall: 0.419,
  recallNameMatched: 0.314,
  repos: 7,
  threshold: 0.95,
  source: 'SWE-bench Verified, 172 labelled fixes across 7 repositories',
}
