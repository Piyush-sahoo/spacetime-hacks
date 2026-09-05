import { useSyncExternalStore } from 'react'
import { key, idHex } from './util'

export const TABLES = ['repo', 'node', 'edge', 'participant', 'walk', 'frontier', 'verdict']

// Primary keys per CONTRACT.md. participant is keyed by identity, everything
// else by a u64 `id`.
function rowKey(table, row) {
  if (table === 'participant') return idHex(row.identity)
  return key(row.id)
}

/**
 * One flat, coalesced mirror of the subscribed tables.
 *
 * Everything the UI paints is read out of here, and the ONLY thing that writes
 * here is a subscription callback. That is what makes a second tab — which
 * never clicked anything — show the identical animation.
 */
export class Store {
  constructor() {
    this.tables = Object.fromEntries(TABLES.map((t) => [t, new Map()]))
    this.meta = {
      status: 'idle', // idle | connecting | connected | error | offline
      mode: null, // 'live' | 'mock'
      error: null,
      identity: null,
      subscribed: false,
    }
    this.version = 0
    this.snapshot = this.#build()
    this.listeners = new Set()
    this.pending = false
  }

  #build() {
    return { version: this.version, meta: { ...this.meta } }
  }

  subscribe = (fn) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = () => this.snapshot

  // Coalesce bursts: the initial `node` sync is 20k rows, and the frontier
  // arrives in clumps. One repaint per frame, not one per row.
  #touch() {
    if (this.pending) return
    this.pending = true
    const flush = () => {
      this.pending = false
      this.version += 1
      this.snapshot = this.#build()
      for (const fn of this.listeners) fn()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush)
    else setTimeout(flush, 16)
  }

  setMeta(patch) {
    this.meta = { ...this.meta, ...patch }
    this.#touch()
  }

  upsert(table, row) {
    const m = this.tables[table]
    if (!m) return
    m.set(rowKey(table, row), row)
    this.#touch()
  }

  remove(table, row) {
    const m = this.tables[table]
    if (!m) return
    m.delete(rowKey(table, row))
    this.#touch()
  }

  clearTables() {
    for (const t of TABLES) this.tables[t].clear()
    this.#touch()
  }

  rows(table) {
    return [...(this.tables[table]?.values() ?? [])]
  }

  count(table) {
    return this.tables[table]?.size ?? 0
  }

  get(table, k) {
    return this.tables[table]?.get(key(k))
  }
}

export function useStoreVersion(store) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
