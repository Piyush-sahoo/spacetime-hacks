import { useState } from 'react'
import { RoomProvider } from './lib/room.jsx'
import Landing from './components/Landing.jsx'
import Room from './components/Room.jsx'

function Shell() {
  const [inRoom, setInRoom] = useState(false)
  return inRoom ? <Room onLeave={() => setInRoom(false)} /> : <Landing onEnter={() => setInRoom(true)} />
}

export default function App() {
  return (
    <RoomProvider>
      <Shell />
    </RoomProvider>
  )
}
