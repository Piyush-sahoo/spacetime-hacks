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
 * An actor's colour is THE ONLY HUE IN THE PRODUCT. Everything else — paper,
 * ink, rules, plates, blocks — is monochrome, which is precisely what makes a
 * live route pop off the plate.
 *
 * Because it is the only hue, it must never be spent on a lie. A colour on the
 * map is a promise that an agent is connected RIGHT NOW; a session that has
 * stopped reporting gets `NEUTRAL_SLOT` and reads as plain ink.
 */
export const MAIN_COLOR = '#C2410C'

/** Explored, but nobody live is standing there. Ink, not a hue. */
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
 * ONLY LIVE ROWS BELONG IN HERE. An `agent_session` row is never deleted and
 * `online` is not reliably cleared, so feeding this every row that ever existed
 * is what used to paint a repo in full subagent colour with nothing connected.
 * The caller filters; this function assumes the filter already happened.
 *
 * @param liveSessionRows live agent_session rows, ALREADY sorted by row id asc
 * @returns Map(actor -> slot)
 */
export function assignSlots(liveSessionRows) {
  const slots = new Map()
  let next = 1
  for (const r of liveSessionRows) {
    const { actor } = splitSession(r.session)
    if (!actor || slots.has(actor)) continue
    slots.set(actor, next <= MAX_ACTOR_COLORS ? next : OTHER_SLOT)
    if (next <= MAX_ACTOR_COLORS) next += 1
  }
  return slots
}
