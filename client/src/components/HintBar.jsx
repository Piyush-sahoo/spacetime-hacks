import { useRoom } from '../lib/room.jsx'

/**
 * The bottom rule: what the keyboard does, and the one fact the whole product
 * rests on — every tab is painting the same subscription, so nothing here was
 * refreshed into place.
 */
export default function HintBar({ scope }) {
  const { participants, coverage, atlas } = useRoom()
  const online = participants.filter((p) => p.online).length

  return (
    <div id="hint">
      <span>↑↓ Select</span>
      <span>→ Go inside</span>
      <span>← Come out</span>
      <span>Enter Step one call</span>
      <span>Space Play/pause</span>
      <span>Click a dashed block, then type the ask</span>
      <span style={{ marginLeft: 'auto' }}>
        {scope ? `${scope} · ` : ''}
        {atlas.districts.length} dirs · {coverage.exploredFiles}/{coverage.totalFiles} explored ·{' '}
        {online} watching
      </span>
    </div>
  )
}
