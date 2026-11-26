// A restore may arrive through both the route and tile/queue restore paths.
// The marker survives owner routing's object spreads, but never goes on the wire.
export const RESTORE_SNAPSHOT = Symbol('restore session snapshot')

const REUSE_MS = 5_000
const MAX_SNAPSHOTS = 16

interface RestoreSnapshot {
  result: object
  runtimeId: string
  storedId: string
  until: number
}

/** Owned by the actual gateway socket, after owner routing. Never use a
 * renderer-wide cache for an ID that can exist on more than one backend. */
export class SessionRestoreSnapshots {
  private readonly entries = new Map<string, RestoreSnapshot>()

  get<T>(profile: unknown, id: string): T | undefined {
    const entry = this.entries.get(JSON.stringify([profile ?? '', id]))

    return entry && entry.until > Date.now() ? entry.result as T : undefined
  }

  record(profile: unknown, id: string, result: unknown): void {
    if (!result || typeof result !== 'object' || !('session_id' in result) || typeof result.session_id !== 'string') {
      return
    }

    const key = JSON.stringify([profile ?? '', id])
    this.entries.delete(key)
    this.entries.set(key, { result, runtimeId: result.session_id, storedId: id, until: Date.now() + REUSE_MS })

    if (this.entries.size > MAX_SNAPSHOTS) {
      this.entries.delete(this.entries.keys().next().value!)
    }
  }

  forget(id?: string): void {
    if (!id) {
      this.entries.clear()

      return
    }

    for (const [key, entry] of this.entries) {
      if (entry.runtimeId === id || entry.storedId === id) {
        this.entries.delete(key)
      }
    }
  }
}
