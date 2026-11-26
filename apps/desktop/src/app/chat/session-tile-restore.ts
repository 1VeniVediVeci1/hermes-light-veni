import { resolveStoredSession } from '@/app/session/hooks/use-session-actions/utils'
import { queueSessionRestore } from '@/app/session/session-restore-queue'
import { $connection, $gatewayState } from '@/store/session'
import { isSessionRemovalPending } from '@/store/session-removal'
import { $sessionTiles, $workingSessionIds, patchSessionTile, sessionTileDelegate } from '@/store/session-states'

export const WRONG_BACKEND_TILE_ERROR =
  'Wrong backend — this session lives on another connection. Reconnect to that backend to open it.'

export function sessionTileResumeFailure(
  message: string,
  durableSessionFound: boolean | undefined,
  tileStillUnbound: boolean,
  backendIdentityChanged = false
): string | undefined {
  if (!tileStillUnbound) {
    return undefined
  }

  if (!/session not found|\b404\b/i.test(message)) {
    return message
  }

  if (backendIdentityChanged) {
    return WRONG_BACKEND_TILE_ERROR
  }

  if (durableSessionFound) {
    return 'Session is still available — retry resuming it.'
  }

  return 'Session unavailable — you can retry resuming it.'
}

/** True when a persisted tile's owner is a different backend than the one that
 *  just became active. An unqualified local boot (no connectionId, mode local)
 *  counts as the local identity — that is the post-update empty backend. */
export function tileBackendIdentityChanged(
  ownerConnectionId: string | null | undefined,
  activeConnection: { connectionId?: string | null; mode?: string | null } | null | undefined
): boolean {
  const owner = String(ownerConnectionId || '').trim()

  if (!owner || !activeConnection) {
    return false
  }

  const active =
    String(activeConnection.connectionId || '').trim() || (activeConnection.mode === 'local' ? 'local' : '')

  return Boolean(active) && owner !== active
}

export function unbindTilesForBackendIdentityChange<
  T extends { error?: string; ownerRoute?: { connectionId?: string }; runtimeId?: string }
>(
  tiles: readonly T[],
  activeConnection: { connectionId?: string | null; mode?: string | null } | null | undefined
): T[] {
  let changed = false

  const next = tiles.map(tile => {
    if (!tileBackendIdentityChanged(tile.ownerRoute?.connectionId, activeConnection)) {
      return tile
    }

    if (!tile.runtimeId && tile.error === WRONG_BACKEND_TILE_ERROR) {
      return tile
    }

    changed = true
    const unbound = { ...tile, error: WRONG_BACKEND_TILE_ERROR }
    delete unbound.runtimeId

    return unbound
  })

  return changed ? next : (tiles as T[])
}

/** Should this tile dispatch a `session.resume`?
 *
 *  - The gateway must be OPEN: persisted tiles mount at boot while it is still
 *    connecting, and an ungated resume rejected there latched every restored
 *    tile into the error card.
 *  - A bound runtime, a latched error, or an in-flight attempt means there is
 *    nothing to do.
 *  - A removal-pending session is skipped for the same reason the primary's
 *    `resumeSession` skips it: a 4001 racing a delete unbinds this tile's
 *    runtime and re-arms the effect against an id that is already gone. The
 *    resume would 404 and latch an error card for a chat the user deleted;
 *    `closeSessionTile` lands moments later. */
export function shouldResumeSessionTile(opts: {
  gatewayOpen: boolean
  removalPending: boolean
  resuming: boolean
  runtimeId: null | string | undefined
  tileError: string | undefined
}): boolean {
  return !opts.removalPending && opts.gatewayOpen && !opts.runtimeId && !opts.tileError && !opts.resuming
}

function pendingTile(storedSessionId: string) {
  const tile = $sessionTiles.get().find(candidate => candidate.storedSessionId === storedSessionId)

  if (!tile) {
    return undefined
  }

  return shouldResumeSessionTile({
    gatewayOpen: $gatewayState.get() === 'open',
    removalPending: isSessionRemovalPending(storedSessionId),
    resuming: false,
    runtimeId: tile.pendingResume ? undefined : tile.runtimeId,
    tileError: tile.error
  }) ? tile : undefined
}

export function queueTileRestore(
  storedSessionId: string, priority: 'visible' | 'background', stillWanted: () => boolean
): Promise<void> {
  return queueSessionRestore(priority, async () => {
    const tile = stillWanted() ? pendingTile(storedSessionId) : undefined
    const delegate = sessionTileDelegate()

    if (!tile || !delegate) {
      return
    }

    // A reconnect, reclaim or gap may supersede this attempt while REST is
    // pending; leave the new intent to its own scheduled restore.
    const stillCurrent = () => {
      const current = pendingTile(storedSessionId)

      return current && current.ownerRoute === tile.ownerRoute && current.pendingResume === tile.pendingResume
    }

    try {
      const runtimeId = await delegate.resumeTile(storedSessionId, { reuseRecentAttachment: true })

      if (stillCurrent()) {
        patchSessionTile(storedSessionId, { error: undefined, pendingResume: undefined, runtimeId })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const notFound = /session not found|\b404\b/i.test(message)
      // A recents page or inconclusive by-id probe cannot authorize deletion.
      const stored = notFound ? await resolveStoredSession(storedSessionId, tile.ownerRoute).catch(() => undefined) : undefined

      if (stillCurrent()) {
        const identityChanged = tileBackendIdentityChanged(tile.ownerRoute?.connectionId, $connection.get())
        patchSessionTile(storedSessionId, {
          error: sessionTileResumeFailure(message, Boolean(stored), true, identityChanged)
        })
      }
    }
  })
}

/** Events.since catches up retained cursors but does not subscribe this socket.
 * Use the existing active-list/event liveness projection to reattach only
 * running tiles (including parked bodies); idle tiles wait for a visible pane. */
export function watchLiveSessionTileRestores(): () => void {
  const queued = new Set<string>()
  let stopped = false

  const check = () => {
    const working = $workingSessionIds.get()

    for (const { storedSessionId } of $sessionTiles.get()) {
      if (!working.includes(storedSessionId) || queued.has(storedSessionId) || !pendingTile(storedSessionId)) {
        continue
      }

      queued.add(storedSessionId)
      void queueTileRestore(storedSessionId, 'background', () =>
        !stopped && $workingSessionIds.get().includes(storedSessionId)
      ).finally(() => {
        queued.delete(storedSessionId)

        if (!stopped) {
          check()
        }
      })
    }
  }

  const stops = [$workingSessionIds.listen(check), $sessionTiles.listen(check), $gatewayState.subscribe(check)]

  return () => {
    stopped = true
    stops.forEach(stop => stop())
  }
}
