import { PRIOR, WALK_K } from './config'

/**
 * LOCAL MOCK — review-only.
 *
 * This exists so the UI can be looked at before the module is published. It is
 * never the default path, every row it produces is labelled MOCK in the UI, and
 * the room paints a red hazard stripe while it is on. If you are reading real
 * numbers off a mock room, that is a bug in the labelling, not in the mock.
 *
 * It implements the SAME api surface as live.js, and — importantly — it drives
 * the store the same way: reducers mutate, the "subscription" writes, the UI
 * only reads. So the two-tab behaviour is exercised by the same code path.
 */

const wilsonLb = (hits, n, z = 1.645) => {
  if (!n) return 0
  const p = hits / n
  const z2 = z * z
  const den = 1 + z2 / n
  const centre = p + z2 / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return (centre - margin) / den
}

const FILES = [
  ['django.db.models.query', ['QuerySet.filter', 'QuerySet._filter_or_exclude', 'QuerySet.annotate', 'QuerySet.get']],
  ['django.db.models.sql.query', ['Query.add_q', 'Query.build_filter', 'Query.resolve_lookup_value', 'Query.names_to_path']],
  ['django.db.models.expressions', ['Combinable.__and__', 'F.resolve_expression', 'Value.as_sql']],
  ['django.db.models.lookups', ['Lookup.as_sql', 'Exact.process_rhs', 'In.process_rhs']],
  ['django.db.models.fields.related_lookups', ['RelatedExact.get_prep_lookup', 'RelatedIn.as_sql']],
  ['django.core.exceptions', ['FieldError', 'ValidationError']],
  ['django.db.backends.base.operations', ['BaseDatabaseOperations.quote_name']],
]

const TESTS = [
  ['tests.queries.test_query', ['TestQuery.test_filter_conditional', 'TestQuery.test_multiple_fields']],
  ['tests.expressions.tests', ['BasicExpressionsTests.test_filter_with_join']],
  ['tests.lookup.tests', ['LookupTests.test_exact_query_rhs_with_selected_columns']],
]

function buildGraph() {
  const nodes = []
  const preds = new Map() // node id -> [predecessor ids]
  let next = 10000000000n
  const mk = (kind, name, qual) => {
    const id = next
    next += 1n
    nodes.push({ id, repoId: 1n, kind, name, qual })
    return id
  }

  const fn = []
  for (const [file, syms] of FILES) {
    for (const s of syms) fn.push(mk('Function', s.split('.').pop(), `${file}::${s}`))
  }
  const tests = []
  for (const [file, syms] of TESTS) {
    for (const s of syms) tests.push(mk('Test', s.split('.').pop(), `${file}::${s}`))
  }

  // Chain callers backwards: node i is called by a couple of later nodes.
  for (let i = 0; i < fn.length; i++) {
    const p = []
    if (i + 1 < fn.length) p.push(fn[i + 1])
    if (i + 3 < fn.length) p.push(fn[i + 3])
    if (i + 7 < fn.length) p.push(fn[i + 7])
    preds.set(String(fn[i]), p)
  }
  // Only ONE test is reachable from production code — the rest are the roads
  // the agent can't see. This is the whole point of the demo.
  preds.set(String(fn[fn.length - 1]), [tests[0]])
  for (const t of tests) if (!preds.has(String(t))) preds.set(String(t), [])

  return { nodes, preds, tests, fn }
}

export function connectMock(store) {
  const g = buildGraph()
  const me = 'mock-you-0000'
  let walkSeq = 1n
  let frontierSeq = 1n
  let verdictSeq = 1n
  const timers = new Set()
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn() }, ms)
    timers.add(t)
    return t
  }

  store.clearTables()
  store.setMeta({ status: 'connected', mode: 'mock', identity: me, error: null })

  const repo = {
    id: 1n,
    slug: 'django (MOCK)',
    label: 'django/django — MOCK DATA, NOT A REAL GRAPH',
    nodeCount: g.nodes.length,
    edgeCount: g.nodes.length * 3,
    reachability: 0.419,
    status: 'ready',
  }

  const walkState = new Map() // walk id -> { origin, hop, frontier:Set, seen:Set }

  const api = {
    mode: 'mock',
    subscribe(_queries, onApplied) {
      later(() => {
        store.upsert('repo', repo)
        for (const n of g.nodes) store.upsert('node', n)
        // A second participant so the presence rail is not a lonely list.
        store.upsert('participant', {
          identity: 'mock-peer-1111',
          name: 'mock-peer (not a real person)',
          repoId: 1n,
          focusNode: 0n,
          online: true,
        })
        onApplied?.()
      }, 260)
      return { unsubscribe() {} }
    },

    joinRoom(name, repoId) {
      later(() => {
        store.upsert('participant', {
          identity: me, name, repoId: repoId, focusNode: 0n, online: true,
        })
      }, 90)
    },

    setFocus(nodeId) {
      const p = store.get('participant', me)
      if (p) store.upsert('participant', { ...p, focusNode: nodeId })
    },

    startWalk(repoId, origin, k) {
      const id = walkSeq
      walkSeq += 1n
      later(() => {
        const w = {
          id, repoId: repoId, origin, k, hop: 0, selected: 1,
          graphComplete: false, done: false, startedBy: me,
        }
        store.upsert('walk', w)
        store.upsert('frontier', {
          id: frontierSeq++, walkId: id, hop: 0, nodeId: origin, isTest: false,
        })
        walkState.set(String(id), {
          origin, hop: 0, frontier: [origin], seen: new Set([String(origin)]), selected: 1,
        })
      }, 120)
      return id
    },

    stepWalk(walkId) {
      later(() => {
        const s = walkState.get(String(walkId))
        const w = store.get('walk', walkId)
        if (!s || !w || w.done) return
        const nextHop = s.hop + 1
        const found = []
        for (const cur of s.frontier) {
          for (const p of g.preds.get(String(cur)) || []) {
            if (s.seen.has(String(p))) continue
            s.seen.add(String(p))
            found.push(p)
          }
        }
        for (const nid of found) {
          const node = g.nodes.find((n) => n.id === nid)
          store.upsert('frontier', {
            id: frontierSeq++, walkId: walkId, hop: nextHop, nodeId: nid,
            isTest: node?.kind === 'Test',
          })
        }
        s.hop = nextHop
        s.frontier = found
        s.selected += found.length

        const exhausted = found.length === 0
        const atK = nextHop >= (Number(w.k) || WALK_K)
        const done = exhausted || atK
        store.upsert('walk', {
          ...w, hop: nextHop, selected: s.selected,
          graphComplete: exhausted, done,
        })

        if (done) {
          const lb = wilsonLb(PRIOR.hits, PRIOR.n)
          const missed = g.tests.find((t) => !s.seen.has(String(t))) || g.tests[0]
          later(() => {
            store.upsert('verdict', {
              id: verdictSeq++,
              walkId: walkId,
              decision: 'RUN_FULL',
              recallPrior: PRIOR.recall,
              wilsonLb: lb,
              threshold: PRIOR.threshold,
              reason:
                'recall is not computable on an unlabelled repo; this cites the measured prior across 172 labelled fixes in 7 repos',
              missedTest: missed,
            })
          }, 260)
        }
      }, 150)
    },

    disconnect() {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    },
  }
  return api
}
