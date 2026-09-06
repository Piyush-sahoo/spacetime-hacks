/**
 * THE BLOCK, ON ITS OWN.
 *
 * `Atlas.jsx` draws the room's map and is performance-tuned around a live
 * subscription; it is not something to reach into. But the *shape* of a block —
 * three quads in the 2:1 dimetric of `lib/iso.js`, side faces hatched at 45°,
 * a deck of slabs for a test directory, three drums for a store — is the
 * product's visual vocabulary, and the landing page has to speak it or the
 * hero is a picture of a different product.
 *
 * So the primitives live here, drawn from `lib/iso.js` exactly as the map draws
 * them, and both the hero and the legend render from this one file. Nothing in
 * `Atlas.jsx` or `lib/iso.js` changes.
 *
 * The one difference from the map's own `Block`: every painted polygon carries
 * a class. The hero repaints by writing attributes onto those nodes rather than
 * by re-rendering React sixty times a second, and it needs to be able to find
 * them.
 */
import { P, pts } from '../lib/iso'

/** The fill faces of a block. Queried by the hero when a block lights. */
export const FACE_CLASS = 'ib-face'
/** The 45° hatch laid over them. Hidden while a block is dark. */
export const HATCH_CLASS = 'ib-hatch'

/**
 * The hatch patterns, verbatim from the map. One `<defs>` per SVG, and the
 * ids are namespaced so a hero and a legend on the same page cannot collide
 * with each other or with the room's own `#hatch`.
 */
export function HatchDefs({ ns }) {
  return (
    <defs>
      <pattern id={`${ns}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="1.1" />
      </pattern>
      <pattern id={`${ns}-hatchLight`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
        <line x1="0" y1="0" x2="0" y2="7" stroke="currentColor" strokeWidth=".8" opacity=".55" />
      </pattern>
    </defs>
  )
}

/**
 * One extruded box between two heights: left face, right face, top.
 *
 * Side faces always carry the hatch. `hatchTop` names a pattern for the roof or
 * is null. `ghost` is the DASHED state — no fill, no hatch, a dashed outline —
 * and it is what "nobody has ever opened this file" looks like.
 */
function faces(b, z0, z1, hatchTop, o, kk) {
  const { gx, gy, w, d } = b
  const quads = [
    [P(gx, gy + d, z0), P(gx + w, gy + d, z0), P(gx + w, gy + d, z1), P(gx, gy + d, z1)],
    [P(gx + w, gy, z0), P(gx + w, gy + d, z0), P(gx + w, gy + d, z1), P(gx + w, gy, z1)],
    [P(gx, gy, z1), P(gx + w, gy, z1), P(gx + w, gy + d, z1), P(gx, gy + d, z1)],
  ]
  const out = []
  quads.forEach((q, i) => {
    const p = pts(q)
    out.push(
      <polygon
        key={`${kk}f${i}`}
        className={FACE_CLASS}
        points={p}
        fill={o.fill}
        fillOpacity={o.fillOpacity}
        stroke="var(--ink)"
        strokeWidth={o.sw}
        strokeLinejoin="round"
        strokeDasharray={o.ghost ? '4 3' : undefined}
      />
    )
    const hatch = i < 2 ? `${o.ns}-hatch` : (hatchTop && `${o.ns}-${hatchTop}`)
    if (hatch) {
      out.push(
        <polygon
          key={`${kk}h${i}`}
          className={HATCH_CLASS}
          points={p}
          fill={`url(#${hatch})`}
          style={{ color: 'var(--ink)' }}
          opacity={o.ghost ? 0 : 1}
          stroke="none"
        />
      )
    }
  })
  return out
}

/**
 * What a block is a block OF — the reference's own primitives, chosen by what
 * the directory IS. `kindOfDir` in `lib/iso.js` is what picks between them.
 */
export function bodyOf(b, o) {
  const { gx, gy, w, d, h, kind } = b
  if (kind === 'store') {
    // three stacked drums — data, config, bindings
    const L = 3, gap = 3, lh = (h - gap * (L - 1)) / L
    const out = []
    for (let i = 0; i < L; i += 1) out.push(...faces(b, i * (lh + gap), i * (lh + gap) + lh, null, o, `s${i}`))
    return out
  }
  if (kind === 'cards') {
    // a deck of five thin slabs — a directory of tests
    const L = 5, lh = h / L
    const out = []
    for (let i = 0; i < L; i += 1) out.push(...faces(b, i * lh, (i + 1) * lh, null, o, `c${i}`))
    return out
  }
  if (kind === 'screen') {
    const out = faces(b, 0, h, null, o, 'sc')
    const inset = 0.3
    const scr = [
      P(gx + inset, gy + inset, h), P(gx + w - inset, gy + inset, h),
      P(gx + w - inset, gy + d - inset, h), P(gx + inset, gy + d - inset, h),
    ]
    out.push(
      <polygon key="scr" points={pts(scr)} fill="var(--paper)" stroke="var(--ink)" strokeWidth={0.9}
        strokeDasharray={o.ghost ? '3 2' : undefined} opacity={o.ghost ? 0.55 : 1} />
    )
    for (let i = 1; i <= 3; i += 1) {
      const a = P(gx + inset + 0.2, gy + inset + i * 0.4, h)
      const c = P(gx + w - inset - 0.4 - (i === 3 ? 0.5 : 0), gy + inset + i * 0.4, h)
      out.push(
        <line key={`sl${i}`} x1={a[0]} y1={a[1]} x2={c[0]} y2={c[1]}
          stroke="var(--ink)" strokeWidth={0.8} opacity={o.ghost ? 0.3 : 0.7} />
      )
    }
    return out
  }
  return faces(b, 0, h, null, o, 'bx')
}

/** The roof outline — the four points a highlight or an actor edge is drawn on. */
export const roofOf = (b) => [
  P(b.gx, b.gy, b.h), P(b.gx + b.w, b.gy, b.h),
  P(b.gx + b.w, b.gy + b.d, b.h), P(b.gx, b.gy + b.d, b.h),
]

/** A ring on the ground, `pad` units out from the footprint. */
export const ringOf = (b, pad) => [
  P(b.gx - pad, b.gy - pad, 0), P(b.gx + b.w + pad, b.gy - pad, 0),
  P(b.gx + b.w + pad, b.gy + b.d + pad, 0), P(b.gx - pad, b.gy + b.d + pad, 0),
]

/**
 * A whole block, dark, ready to be lit by whoever owns it.
 *
 * Everything a block can BE is rendered here once and switched by attribute:
 * the faces, the hatch over them, the dashed blue parcel ring that means new
 * ground, and the ignition halo. Nothing is mounted or unmounted while the
 * hero runs.
 */
export function IsoBlock({ b, ns, sw = 1.2, ghost = true, fill = 'none', fillOpacity = 1, children }) {
  const o = { ns, sw, ghost, fill, fillOpacity }
  return (
    <g className="ib" data-id={b.id}>
      {bodyOf(b, o)}
      {children}
    </g>
  )
}
