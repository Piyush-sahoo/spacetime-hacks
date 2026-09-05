/**
 * THE ROUTE — an agent's path through the repo, in order.
 *
 * Coverage is a SET: "these twelve files are lit". That answers *what* but
 * never *how it got there*. What the map wants is a route.
 *
 * `touch.id` is a monotonic autoInc assigned by the server, so sorting a
 * session's touches by `id` recovers the true order of its tool calls exactly —
 * no schema change, no republish, no clock to trust. The step index `n` that
 * falls out of that ordering IS the depth of the call.
 *
 * A subagent inherits its parent's session id and carries its own actor after a
 * `/`, so grouping on the whole composite key separates the trunk from its
 * branches for free. A branch is anchored to wherever the trunk stood when the
 * subagent's first touch landed, which is what makes the drawing read as one
 * run splitting rather than two runs overlapping.
 */

import { key, tsMs, cmpBig } from './util'
import { splitSession } from './actors'

/**
 * @param touchRows raw `touch` rows off the subscription
 * @param opts.repoId  keep only this repo (string key)
 * @param opts.session keep only this session (the bare uuid; subagents of it
 *                     are kept too, since they share it)
 * @param opts.slotOf  composite key -> colour slot. NOT liveness-gated: a
 *                     finished run keeps its actor's colour, which is the whole
 *                     point of `?session=<id>`.
 * @param opts.liveOf  composite key -> is that actor reporting right now. This
 *                     is the channel liveness travels on now that it no longer
 *                     rides the colour: only a live route gets a moving packet,
 *                     which is also what lets the draw loop park.
 * @param opts.colourOf slot -> hex, or null for neutral ink
 * @returns [{ key, session, actor, isMain, slot, colour, live, steps: [...] }]
 *          trunk first, then branches in order of first appearance.
 */
export function routesFor(touchRows, opts = {}) {
  const { repoId = null, session = null, slotOf, colourOf, liveOf } = opts
  const groups = new Map()

  for (const t of touchRows || []) {
    if (repoId != null && key(t.repoId) !== repoId) continue
    const composite = String(t.session || '')
    const { session: sess, actor } = splitSession(composite)
    if (session && sess !== session) continue
    let g = groups.get(composite)
    if (!g) {
      g = { key: composite, session: sess, actor, isMain: !actor, rows: [] }
      groups.set(composite, g)
    }
    g.rows.push(t)
  }

  const out = []
  for (const g of groups.values()) {
    // THE ORDERING. Everything downstream — the polyline, the step numbers in
    // the activity feed, the scrub — is this one sort.
    g.rows.sort((a, b) => cmpBig(a.id, b.id))
    const steps = g.rows.map((t, i) => ({
      n: i + 1,
      id: key(t.id),
      nodeId: key(t.nodeId),
      path: String(t.path || ''),
      tool: String(t.tool || ''),
      agentName: String(t.agentName || ''),
      at: tsMs(t.at),
      sessionKey: g.key,
    }))
    const slot = slotOf ? slotOf(g.key) : 0
    out.push({
      key: g.key,
      session: g.session,
      actor: g.actor,
      isMain: g.isMain,
      slot,
      colour: colourOf ? colourOf(slot) : null,
      live: liveOf ? !!liveOf(g.key) : false,
      steps,
      firstId: steps.length ? steps[0].id : '0',
      lastAt: steps.length ? steps[steps.length - 1].at : 0,
    })
  }

  out.sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
    return cmpBig(a.firstId, b.firstId)
  })

  // Anchor every branch to where the trunk stood when it spawned.
  const trunk = out.find((r) => r.isMain)
  if (trunk && trunk.steps.length) {
    for (const r of out) {
      if (r === trunk || !r.steps.length) continue
      let anchor = null
      for (const s of trunk.steps) {
        if (cmpBig(s.id, r.firstId) < 0) anchor = s
        else break
      }
      if (anchor) r.anchor = { nodeId: anchor.nodeId, path: anchor.path, n: anchor.n }
    }
  }

  return out
}

/**
 * Every step of every route, back in wall-clock order — the tape the ACTIVITY
 * feed reads, and the ruler the timeline scrubs along.
 *
 * Sorted by `touch.id` across routes, because that is the only ordering the
 * server actually promises. `k` is the global step index.
 */
export function timelineOf(routes) {
  const all = []
  for (const r of routes) {
    for (const s of r.steps) all.push({ ...s, route: r.key, slot: r.slot, colour: r.colour, actor: r.actor, live: r.live })
  }
  all.sort((a, b) => cmpBig(a.id, b.id))
  all.forEach((s, i) => { s.k = i + 1 })
  return all
}

/**
 * The hops a route draws: consecutive steps that landed on DIFFERENT blocks.
 * Two Reads of the same file in a row are two steps but zero movement, so they
 * must not become a zero-length hop with a packet stuck on it.
 *
 * `blockOf(step)` resolves a step to a block, or null when the touch missed the
 * survey (`node_id = 0`, a path the graph does not hold).
 *
 * THE LIVE WIRE USES THIS TOO, on a two-step route made of the previous touch
 * and the one that just arrived. There is exactly one path builder on this map
 * and this is the door to it: the flash between consecutive reads and the
 * persistent route can never disagree about where a hop goes.
 */
export function hopsOf(route, blockOf) {
  const hops = []
  let prev = null
  let prevStep = null
  const anchorBlock = route.anchor ? blockOf(route.anchor) : null
  if (anchorBlock) { prev = anchorBlock; prevStep = route.anchor }
  const seen = new Set()
  for (const s of route.steps) {
    const b = blockOf(s)
    if (!b) continue
    if (prev && b.id !== prev.id) {
      const tag = `${prev.id}>${b.id}`
      const back = `${b.id}>${prev.id}`
      // A return hop takes the other bend so it does not lie under the outbound.
      const bend = seen.has(back) ? 'yx' : 'xy'
      seen.add(tag)
      hops.push({ from: prev, to: b, bend, step: s, prevStep, i: hops.length })
    }
    prev = b
    prevStep = s
  }
  return hops
}
