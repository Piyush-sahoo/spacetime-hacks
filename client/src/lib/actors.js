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

/** The main agent keeps the ember the map was always drawn in. */
export const MAIN_COLOR = '#ff571a'

/**
 * Subagent colours.
 *
 * The dark ink ground already spends four hues: ember 19° (explored), amber 45°
 * (requested), green 138° (reported back) and cyan 194° (the walk). These four
 * sit in the gaps — lime 82°, periwinkle 222°, violet 258°, magenta 318° — no
 * closer than 28° to any reserved hue or to each other, and all light enough to
 * read as a lit dot against #0a0908 from the back of a room.
 */
const SUB_COLORS = ['#a3e635', '#7c9cff', '#a78bfa', '#f472d0']

/** Past four subagents, colour stops being information and starts being confetti. */
export const MAX_ACTOR_COLORS = SUB_COLORS.length
/** Everyone in the tail shares one neutral slate, and the rail says how many. */
export const OTHER_COLOR = '#94a3b8'
export const OTHER_SLOT = MAX_ACTOR_COLORS + 1

/** slot 0 = main agent · 1..4 = a coloured subagent · 5 = the collapsed tail. */
export const SLOT_COLORS = [MAIN_COLOR, ...SUB_COLORS, OTHER_COLOR]

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** Painter-side lookup: slot -> [r,g,b]. Built once, read every frame. */
export const SLOT_RGB = SLOT_COLORS.map(hexToRgb)

export const slotColor = (slot) => SLOT_COLORS[slot] || MAIN_COLOR

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
 * @param sessionRows agent_session rows, ALREADY sorted by row id ascending
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
