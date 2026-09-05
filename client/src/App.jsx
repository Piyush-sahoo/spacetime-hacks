import { useEffect, useRef } from 'react'
import { RoomProvider, useRoom } from './lib/room.jsx'
import { defaultName } from './lib/util'
import Landing from './components/Landing.jsx'
import Projects from './components/Projects.jsx'
import ProjectPage from './components/ProjectPage.jsx'
import Room from './components/Room.jsx'

/**
 * Routing, such as it is: the query string IS the route.
 *
 *   ?repo=<slug>[&session=<uuid>]   the map        — the two links people share
 *   ?project=<slug>                 the project page
 *   ?view=projects                  the gallery
 *   (nothing)                       the landing page
 *
 * Every move between them is a real navigation rather than a state change, and
 * that is deliberate: `ROOM_SLUG` is read out of the query string once, at
 * module load, so a client-side route change would leave the room pointed at
 * the repository the tab opened with. A navigation cannot get that wrong, and
 * it gives back the browser's own history and sharing for free.
 */
function route() {
  const qs = new URLSearchParams(window.location.search)
  if (qs.get('repo')) return { view: 'room' }
  const project = qs.get('project')
  if (project) return { view: 'project', slug: project }
  if (qs.get('view') === 'projects') return { view: 'projects' }
  return { view: 'landing' }
}

function Shell() {
  const r = useRef(route()).current

  if (r.view === 'room') return <RoomRoute />
  if (r.view === 'project') return <ProjectPage slug={r.slug} />
  if (r.view === 'projects') return <Projects />
  return <Landing />
}

/**
 * Arriving straight into the map from a shared link.
 *
 * `join` needs the repo row to exist, and the room resolves it from the
 * subscription, so the join waits for it rather than firing on mount and
 * silently doing nothing.
 */
function RoomRoute() {
  const { join, repo, meta } = useRoom()
  const joined = useRef(false)

  useEffect(() => {
    if (joined.current || !repo || meta.status !== 'connected') return
    joined.current = true
    join(defaultName())
  }, [join, repo, meta.status])

  return <Room onLeave={() => { window.location.href = window.location.origin + '/' }} />
}

export default function App() {
  return (
    <RoomProvider>
      <Shell />
    </RoomProvider>
  )
}
