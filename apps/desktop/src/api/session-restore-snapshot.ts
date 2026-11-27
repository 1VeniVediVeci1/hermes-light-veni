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

const snapshotKey = (profile: unknown, id: string) => JSON.stringify([profile ?? '', id])

/** Owned by the actual gateway socket, after owner routing. Never use a
 * renderer-wide cache for an ID that can exist on more than one backend. */
export class SessionRestoreSnapshots {
  private readonly entries = new Map<string, RestoreSnapshot>()
  // When each stored or runtime id was last forgotten, on one counter. An answer sent before a
  // frame for either of its ids may predate that frame, so it is not kept.
  private readonly forgotten = new Map<string, number>()
  private clock = 0

  /** Taken before a restore is sent; `record` refuses its answer if either id is forgotten after. */
  mark(): number {
    return this.clock
  }

  get<T>(profile: unknown, id: string): T | undefined {
    const entry = this.entries.get(snapshotKey(profile, id))

    return entry && entry.until > Date.now() ? entry.result as T : undefined
  }

  /** One entry under the requested and the runtime id, so forgetting either id drops both. */
  record(mark: number, profile: unknown, id: string, result: unknown, runtimeProfile: unknown = profile): void {
    if (!result || typeof result !== 'object' || !('session_id' in result) || typeof result.session_id !== 'string') {
      return
    }

    const runtimeId = result.session_id

    if ((this.forgotten.get(id) ?? 0) > mark || (this.forgotten.get(runtimeId) ?? 0) > mark) {
      return
    }

    const entry = { result, runtimeId, storedId: id, until: Date.now() + REUSE_MS }

    for (const key of new Set([snapshotKey(profile, id), snapshotKey(runtimeProfile, runtimeId)])) {
      this.entries.delete(key)
      this.entries.set(key, entry)
    }

    while (this.entries.size > MAX_SNAPSHOTS) {
      this.entries.delete(this.entries.keys().next().value!)
    }
  }

  forget(id?: string): void {
    if (!id) {
      this.entries.clear()
      this.forgotten.clear()

      return
    }

    this.forgotten.set(id, ++this.clock)

    for (const [key, entry] of this.entries) {
      if (entry.runtimeId === id || entry.storedId === id) {
        this.entries.delete(key)
      }
    }
  }
}
