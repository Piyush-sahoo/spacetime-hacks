import { PRIOR, WALK_K } from './config'
import { key } from './util'

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

const EXTRA = [
  ['django.forms.fields', ['CharField.to_python', 'DateTimeField.clean', 'Field.widget_attrs', 'Field.prepare_value']],
  ['django.forms.widgets', ['Widget.render', 'TextInput.get_context', 'Select.format_value']],
  ['django.forms.models', ['ModelForm.save', 'modelform_factory']],
  ['django.core.management.base', ['BaseCommand.handle', 'Command.execute', 'Command.check']],
  ['django.core.management.commands.runserver', ['Command.handle', 'inner_run']],
  ['django.contrib.admin.options', ['ModelAdmin.save_model', 'ModelAdmin.changeform_view', 'ModelAdmin.get_queryset']],
  ['django.contrib.admin.sites', ['AdminSite.register', 'AdminSite.admin_view']],
  ['django.utils.timezone', ['now', 'make_aware', 'localtime']],
  ['django.utils.encoding', ['force_str', 'smart_str']],
  ['django.http.request', ['HttpRequest.get_host', 'HttpRequest.is_secure']],
  ['django.http.response', ['HttpResponse.__init__', 'JsonResponse.__init__']],
  ['django.urls.resolvers', ['URLResolver.resolve', 'RegexPattern.match']],
  ['django.template.base', ['Template.render', 'Variable.resolve']],
  ['django.views.generic.base', ['View.dispatch', 'View.get']],
]

const TESTS = [
  ['tests.queries.test_query', ['TestQuery.test_filter_conditional', 'TestQuery.test_multiple_fields']],
  ['tests.expressions.tests', ['BasicExpressionsTests.test_filter_with_join']],
  ['tests.lookup.tests', ['LookupTests.test_exact_query_rhs_with_selected_columns']],
  ['tests.forms_tests.field_tests.test_datetimefield', ['DateTimeFieldTest.test_datetimefield_1']],
  ['tests.admin_views.tests', ['AdminViewBasicTest.test_change_save']],
]

function buildGraph() {
  const nodes = []
  const preds = new Map()
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
  const extra = []
  for (const [file, syms] of EXTRA) {
    for (const s of syms) extra.push(mk('Function', s.split('.').pop(), `${file}::${s}`))
  }
  const tests = []
  for (const [file, syms] of TESTS) {
    for (const s of syms) tests.push(mk('Test', s.split('.').pop(), `${file}::${s}`))
  }

  for (let i = 0; i < fn.length; i++) {
    const p = []
    if (i + 1 < fn.length) p.push(fn[i + 1])
    if (i + 3 < fn.length) p.push(fn[i + 3])
    if (i + 7 < fn.length) p.push(fn[i + 7])
    preds.set(String(fn[i]), p)
  }
  // Cross-package filaments so the survey has roads that ignore folders.
  if (extra[0] && fn[2]) preds.set(String(fn[2]), [...(preds.get(String(fn[2])) || []), extra[0]])
  if (extra[4] && fn[5]) preds.set(String(fn[5]), [...(preds.get(String(fn[5])) || []), extra[4]])
  if (extra[8] && extra[1]) preds.set(String(extra[1]), [extra[8], extra[9] || extra[8]])
  if (extra[12] && extra[3]) preds.set(String(extra[3]), [extra[12]])
  if (extra[16] && extra[6]) preds.set(String(extra[6]), [extra[16], extra[17] || extra[16]])
  if (extra[20] && extra[10]) preds.set(String(extra[10]), [extra[20]])
  if (extra[24] && extra[14]) preds.set(String(extra[14]), [extra[24]])
  for (let i = 0; i < extra.length - 1; i += 3) {
    preds.set(String(extra[i]), [...(preds.get(String(extra[i])) || []), extra[i + 1]])
  }

  // Only ONE test is reachable from production code — the rest are the roads
  // the agent can't see. This is the whole point of the demo.
  preds.set(String(fn[fn.length - 1]), [tests[0]])
  for (const t of tests) if (!preds.has(String(t))) preds.set(String(t), [])

  const edges = []
  let eid = 1n
  for (const [dst, srcs] of preds) {
    for (const src of srcs) {
      edges.push({ id: eid++, repoId: 1n, src, dst: BigInt(dst), kind: 'CALLS' })
    }
  }

  return { nodes, preds, tests, fn, extra, edges }
}

export function connectMock(store) {
  const g = buildGraph()
  const me = 'mock-you-0000'
  let walkSeq = 1n
  let frontierSeq = 1n
  let verdictSeq = 1n
  let reqSeq = 1n
  let touchSeq = 1n
  const timers = new Set()
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn() }, ms)
    timers.add(t)
    return t
  }

  store.clearTables()
  store.setMeta({ status: 'connected', mode: 'mock', identity: me, error: null, tables: ['repo', 'node', 'edge', 'participant', 'walk', 'frontier', 'verdict', 'node_cov', 'touch', 'agent_session', 'exploration_request'] })

  const repo = {
    id: 1n,
    slug: 'django (MOCK)',
    label: 'django/django — MOCK DATA, NOT A REAL GRAPH',
    nodeCount: g.nodes.length,
    edgeCount: g.edges.length,
    reachability: 0.419,
    status: 'ready',
  }

  const walkState = new Map()

  const seed = () => {
    store.upsert('repo', repo)
    for (const n of g.nodes) store.upsert('node', n)
    for (const e of g.edges) store.upsert('edge', e)
    store.upsert('participant', {
      identity: 'mock-peer-1111',
      name: 'mock-peer (not a real person)',
      repoId: 1n,
      focusNode: 0n,
      online: true,
    })
    store.upsert('agent_session', {
      id: 1n,
      session: 'mock-agent',
      agentName: 'mock-agent',
      repoId: 1n,
      online: true,
      touches: 0,
      startedAt: Date.now() - 4000,
      lastAt: Date.now() - 4000,
    })
  }

  const api = {
    mode: 'mock',
    has: () => true,
    hasReducer: (n) => n === 'request_exploration' || n === 'start_walk' || n === 'step_walk',
    subscribe(_queries, onApplied) {
      later(() => {
        seed()
        onApplied?.()
      }, 180)
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
                'recall is not computable on an unlabelled repo; this cites the measured prior across 172 labelled fixes in 7 repos. Measured test->fix recall 0.419 and its one-sided 95% Wilson lower bound 0.358 are both below the 0.95 bar.',
              missedTest: missed,
            })
          }, 260)
        }
      }, 150)
    },

    requestExploration(repoId, nodeId, note) {
      const id = reqSeq
      reqSeq += 1n
      const path = String(note || '')
      later(() => {
        store.upsert('exploration_request', {
          id, repoId, nodeId, path, note: path,
          status: 'pending', askedBy: me, claimedBy: '', result: '', at: Date.now(),
        })
        later(() => {
          store.upsert('exploration_request', {
            id, repoId, nodeId, path, note: path,
            status: 'claimed', askedBy: me, claimedBy: 'mock-agent', result: '', at: Date.now(),
          })
          const origin = g.nodes.find((n) => key(n.id) === key(nodeId))
          const prefix = origin ? String(origin.qual).split('::')[0] : ''
          const same = g.nodes.filter((n) => String(n.qual).startsWith(prefix))
          let lit = 0
          for (const n of same) {
            store.upsert('node_cov', {
              nodeId: n.id, repoId, touches: 1, lastTool: 'Read',
              lastSession: 'mock-agent', explored: true, lastAt: Date.now(),
            })
            store.upsert('touch', {
              id: touchSeq++, repoId, nodeId: n.id, path,
              tool: 'Read', session: 'mock-agent', agentName: 'mock-agent', at: Date.now(),
            })
            lit += 1
          }
          const sess = store.get('agent_session', 1n) || {
            id: 1n, session: 'mock-agent', agentName: 'mock-agent', repoId, online: true, touches: 0,
          }
          store.upsert('agent_session', { ...sess, touches: (sess.touches || 0) + 1, lastAt: Date.now(), online: true })
          later(() => {
            store.upsert('exploration_request', {
              id, repoId, nodeId, path, note: path,
              status: 'done', askedBy: me, claimedBy: 'mock-agent',
              result: `looked; ${lit} symbol${lit === 1 ? '' : 's'} read`,
              at: Date.now(),
            })
          }, 900)
        }, 700)
      }, 80)
    },

    disconnect() {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    },
  }
  return api
}
