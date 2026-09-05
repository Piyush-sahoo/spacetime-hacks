import { useMemo, useState } from 'react'
import { useRoom } from '../lib/room.jsx'
import { stateColour } from '../lib/actors'

/**
 * THE INDEX — directories, with how much of each the agent has actually seen.
 *
 * This is the navigation, and at 2,974 files it is the ONLY navigation: a plate
 * with three thousand blocks on it is a hairball, so the canvas draws districts
 * and this list is how you get inside one. Click flies the camera there.
 *
 * A directory nobody has ever opened is drawn DASHED and unshadowed — the same
 * grammar the canvas uses for a dark block, because it means the same thing.
 * The swatch is the same clock the canvas paints with, too: green where an
 * agent is standing, red where it has been, blue for new ground. The index and
 * the plate must never disagree about what a colour means.
 */
export default function LeftIndex({ scope, onScope, selected, onSelect }) {
  const { atlas, districtStats, coverage, now } = useRoom()
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return districtStats
      .map((d, i) => ({ ...d, i }))
      .filter((d) => !needle || d.name.toLowerCase().includes(needle))
  }, [districtStats, q])

  const inScope = scope ? atlas.districts[atlas.byDistrict.get(scope)] : null

  return (
    <nav id="index" aria-label="Directories">
      {atlas.districts.length > 12 && (
        <input
          className="filter"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter directories"
          aria-label="Filter directories"
        />
      )}

      {inScope ? (
        <>
          <h4>Inside</h4>
          <button className="ix on" onClick={() => onScope(null)}>
            <span className="code">{inScope.code}</span>
            <span className="nm">{inScope.name}</span>
            <span className="n">← out</span>
          </button>
          <h4>{inScope.count} file{inScope.count === 1 ? '' : 's'}</h4>
          {inScope.files.map((fi) => {
            const f = atlas.files[fi]
            const lit = coverage.lit[fi] > 0
            const b = atlas.blocks[atlas.byFile.get(fi)]
            const colour = lit ? stateColour(coverage.at[fi], coverage.isNew[fi], now) : null
            return (
              <button
                key={fi}
                className={`ix${lit ? '' : ' ghost'}${selected && selected.id === b.id ? ' on' : ''}`}
                onClick={() => onSelect({ kind: 'block', id: b.id })}
                title={f.path}
              >
                {colour ? <span className="sw" style={{ background: colour }} /> : <span className="code">{lit ? '·' : ' '}</span>}
                <span className="nm">{f.label}</span>
                <span className="n">{coverage.lit[fi]}/{f.count}</span>
              </button>
            )
          })}
        </>
      ) : (
        <>
          <h4>Directories · lit / files</h4>
          {rows.map((d) => {
            const dark = d.lit === 0
            const colour = d.lit ? stateColour(d.at, d.isNew, now) : null
            return (
              <button
                key={d.name}
                className={`ix${dark ? ' ghost' : ''}`}
                onClick={() => { onScope(d.name); onSelect(null) }}
                title={`${d.name} — ${d.lit} of ${d.total} files explored`}
              >
                {colour ? <span className="sw" style={{ background: colour }} /> : <span className="code">{d.code}</span>}
                <span className="nm">{d.name}</span>
                <span className="n">{d.lit}/{d.total}</span>
              </button>
            )
          })}
          {!rows.length && <p className="micro-label" style={{ padding: '8px 4px' }}>No directory matches.</p>}
        </>
      )}
    </nav>
  )
}
