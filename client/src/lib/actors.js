/**
 * WHO LIT IT — one colour per agent, on one map, at the same time.
 *
 * A subagent inherits its parent's session id, so the session alone cannot tell
 * two agents apart. What the module writes instead is a COMPOSITE key in the
 * existing string columns (`node_cov.last_session`, `touch.session`,
 * `agent_session.session`):
 *
 *     "9f3c-…"                     the main agent
 *     "9f3c-…/general-purpose~a2e7c6ac"   a subagent under it
 *
 * Everything before the `/` is the parent session, everything after is the
 * actor. A row with no `/` — which is every row written before today — reads as
 * the main agent, so the colouring is backwards compatible by construction.
 */

/**
 * An actor's colour answers WHO. It is carried by the ROUTE LINE and by the
 * block OUTLINE — never by the fill, which answers *when* (the temporal state
 * machine at the bottom of this file owns that).
 *
 * An actor keeps its colour after its run ends, because a finished route is
 * still that agent's route and `?session=<id>` exists to show you exactly that.
 * Liveness is drawn separately and honestly: the left rail and the legend list
 * only agents that reported inside `AGENT_LIVE_MS`, and only a live route
 * carries a moving packet.
 */
export const MAIN_COLOR = '#C2410C'

/** No actor could be resolved at all. Ink, not a hue. */
export const NEUTRAL_SLOT = -1

/**
 * Subagent colours.
 *
 * The plate is khaki in light and dark olive in dark, and the SAME hue has to
 * read on both, so every one of these sits at roughly L* 45-55: dark enough to
 * hold against #E6DFBE, light enough to hold against #1E1D15. Four is the cap —
 * past four, colour stops being information and starts being confetti.
 */
const SUB_COLORS = ['#1D7A6C', '#8A5CF0', '#B0347F', '#3F6FD8']

/** Past four subagents, colour stops being information and starts being confetti. */
export const MAX_ACTOR_COLORS = SUB_COLORS.length
/** Everyone in the tail shares one neutral slate, and the rail says how many. */
export const OTHER_COLOR = '#8A8578'
export const OTHER_SLOT = MAX_ACTOR_COLORS + 1

/** slot 0 = main agent · 1..4 = a coloured subagent · 5 = the collapsed tail. */
export const SLOT_COLORS = [MAIN_COLOR, ...SUB_COLORS, OTHER_COLOR]

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** Painter-side lookup: slot -> [r,g,b]. Built once, read every frame. */
export const SLOT_RGB = SLOT_COLORS.map(hexToRgb)

/** `null` for the neutral slot: the caller paints ink, not a colour. */
export const slotColor = (slot) => (slot == null || slot < 0 ? null : SLOT_COLORS[slot] || MAIN_COLOR)

/** `sess/actor` -> { session, actor }. No `/` means the main agent. */
export function splitSession(composite) {
  const s = String(composite || '')
  const i = s.indexOf('/')
  if (i < 0) return { session: s, actor: '' }
  return { session: s.slice(0, i), actor: s.slice(i + 1) }
}

/** `general-purpose~a2e7c6ac` -> { type: 'general-purpose', id: 'a2e7c6ac' } */
export function actorParts(actor) {
  const s = String(actor || '')
  const i = s.indexOf('~')
  if (i < 0) return { type: '', id: s }
  return { type: s.slice(0, i), id: s.slice(i + 1) }
}

/** What the rail and the legend call a subagent. */
export function actorLabel(actor) {
  const { type, id } = actorParts(actor)
  return type ? `${type} · ${id}` : id
}

export function actorShort(actor) {
  const { type, id } = actorParts(actor)
  return type ? type : id
}

/**
 * Assign every distinct actor a stable colour slot.
 *
 * The order is the ARRIVAL order of `agent_session` rows — a server-assigned
 * autoInc id — so every tab computes the same assignment from the same rows
 * without any coordination, and a new subagent appearing can only take the next
 * free slot rather than reshuffling the ones already on screen.
 *
 * LIVE ACTORS ARE OFFERED FIRST. The caller passes the live rows ahead of the
 * full history, and an actor already holding a slot is skipped, so whoever is
 * working right now takes the four bright slots and everyone who has finished
 * takes whatever is left. That ordering matters because a repo with twenty
 * historical subagents would otherwise push the one live agent into the grey
 * tail. It is still derived from server-assigned row ids alone, so every tab
 * computes the same assignment with no coordination.
 *
 * @param sessionRows agent_session rows, live ones first, each run sorted by id asc
 * @returns Map(actor -> slot)
 */
export function assignSlots(sessionRows) {
  const slots = new Map()
  let next = 1
  for (const r of sessionRows) {
    const { actor } = splitSession(r.session)
    if (!actor || slots.has(actor)) continue
    slots.set(actor, next <= MAX_ACTOR_COLORS ? next : OTHER_SLOT)
    if (next <= MAX_ACTOR_COLORS) next += 1
  }
  return slots
}

/* ── WHEN IT WAS LIT ────────────────────────────────────────────────────────
 *
 * COLOUR MEANS *WHEN*, NOT *WHO*.
 *
 * The fill of a block is a clock, not a name. Green is "an agent is standing
 * here right now", red is "somebody has been here and left", blue is "this file
 * did not exist when the map was cut", and no fill at all is "nobody has ever
 * opened this". Between green and red there is a continuous fade, so a glance
 * from the far side of the room tells you where the work IS rather than where
 * it has ever been.
 *
 * Everything that was ever touched keeps a colour FOREVER. The old rule — hue
 * only while a session is connected — is what made a finished run go grey, and
 * it took `?session=<id>` down with it: the one URL whose entire purpose is
 * showing you a run that has already ended.
 *
 * WHO is still on the map. It moved to the OUTLINE and to the route line, both
 * of which are drawn in the actor's colour, so a block being worked on right
 * now by subagent #2 is green with a periwinkle edge and a periwinkle route
 * leading to it.
 */

/** An agent is standing here. */
export const STATE_LIVE = '#22c55e'
/** Explored, and nobody has been back. */
export const STATE_COLD = '#ef4444'
/** Minted after the survey — this ground is new. */
export const STATE_NEW = '#3b82f6'

/**
 * The clock here is the AGENT'S CONTEXT, not wall time.
 *
 * A file read five minutes ago is almost certainly still in the agent's window
 * and informing what it does next. One read fifteen minutes and a few hundred
 * tool calls ago has effectively fallen out — the agent is working from a
 * summary of it at best. That is the distinction worth drawing on a map of an
 * agent's attention, and it is why green is generous and red arrives late.
 */
/** Fully green under this age — read, and still in mind. */
export const TOUCH_LIVE_MS = 300000
/** Fully red past this one — read, but out of context. It fades between. */
export const TOUCH_COLD_MS = 900000

const LIVE_RGB = [34, 197, 94]
const COLD_RGB = [239, 68, 68]

/**
 * The fade is QUANTISED to 24 steps on purpose.
 *
 * Blocks are memoised on their props, and the fill is a prop. A continuous
 * value would hand every cooling block a new string on every tick and re-render
 * all of them; 24 steps across four and a half minutes is finer than the eye
 * resolves and lets the memo do its job.
 */
const FADE_STEPS = 24

/** 'dark' | 'live' | 'cooling' | 'cold' | 'new'. `at` is ms, 0 for untouched. */
export function stateOf(at, isNew, now) {
  // Blue beats red: "new" is a property of the FILE, "cold" is a property of
  // attention. A file created ten minutes ago and not looked at since is still
  // new ground.
  if (isNew) return 'new'
  if (!at) return 'dark'
  const age = now - at
  if (age < TOUCH_LIVE_MS) return 'live'
  if (age >= TOUCH_COLD_MS) return 'cold'
  return 'cooling'
}

/** The fill for a block, or `null` for ground nobody has ever opened. */
export function stateColour(at, isNew, now) {
  const s = stateOf(at, isNew, now)
  if (s === 'dark') return null
  if (s === 'new') return STATE_NEW
  if (s === 'live') return STATE_LIVE
  if (s === 'cold') return STATE_COLD
  const raw = (now - at - TOUCH_LIVE_MS) / (TOUCH_COLD_MS - TOUCH_LIVE_MS)
  const u = Math.round(Math.max(0, Math.min(1, raw)) * FADE_STEPS) / FADE_STEPS
  const r = Math.round(LIVE_RGB[0] + (COLD_RGB[0] - LIVE_RGB[0]) * u)
  const g = Math.round(LIVE_RGB[1] + (COLD_RGB[1] - LIVE_RGB[1]) * u)
  const b = Math.round(LIVE_RGB[2] + (COLD_RGB[2] - LIVE_RGB[2]) * u)
  return `rgb(${r},${g},${b})`
}

/** What the tooltip and the panel call each state. */
export const STATE_LABEL = {
  dark: 'never opened',
  live: 'read, still in context',
  cooling: 'falling out of context',
  cold: 'read, out of context',
  new: 'new ground',
}
