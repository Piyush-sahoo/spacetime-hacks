// Identity can arrive as an Identity object (SDK), a hex string, or a bigint
// depending on where it came from. Normalise to a hex string for keys/compare.
export function idHex(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'bigint') return v.toString(16)
  if (typeof v.toHexString === 'function') return v.toHexString()
  if (v.data != null) return String(v.data)
  return String(v)
}

export function shortId(v) {
  const h = idHex(v)
  return h.length > 8 ? h.slice(0, 6) : h
}

// u64 columns arrive as bigint. Everything we key on becomes a string.
export function key(v) {
  return typeof v === 'bigint' ? v.toString() : String(v)
}

export function asBig(v) {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return BigInt(Math.trunc(v))
  return BigInt(String(v || 0))
}

const ADJ = ['guest']
export function defaultName() {
  const n = 1000 + Math.floor(Math.random() * 9000)
  return `${ADJ[0]}-${n}`
}

export function pct(x) {
  if (x == null || Number.isNaN(x)) return '—'
  return `${(x * 100).toFixed(1)}%`
}

export function num(x) {
  if (x == null) return '—'
  return Number(x).toLocaleString('en-US')
}

// A qualified name like "django.db.models.query::QuerySet.filter" → parts we can
// render as file / symbol without a router or a parser.
export function splitQual(qual, name) {
  const q = String(qual || '')
  const i = q.indexOf('::')
  if (i === -1) return { path: q || '', symbol: name || q }
  return { path: q.slice(0, i), symbol: q.slice(i + 2) || name }
}

export function cmpBig(a, b) {
  const A = asBig(a), B = asBig(b)
  return A < B ? -1 : A > B ? 1 : 0
}

// SpacetimeDB `timestamp` columns arrive as a Timestamp object in the SDK, but
// can also turn up as raw microseconds. Normalise to epoch milliseconds.
export function tsMs(v) {
  if (v == null) return 0
  if (typeof v === 'number') return v > 1e14 ? v / 1000 : v
  if (typeof v === 'bigint') return Number(v / 1000n)
  if (typeof v.toDate === 'function') { const d = v.toDate(); return d ? d.getTime() : 0 }
  const micros = v.microsSinceUnixEpoch ?? v.__timestamp_micros_since_unix_epoch__
  if (micros != null) return Number(BigInt(micros) / 1000n)
  return 0
}
