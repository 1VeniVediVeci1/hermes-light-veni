import { computed } from 'nanostores'

import { RESTORE_SNAPSHOT } from '@/api/session-restore-snapshot'
import { routeSessionId } from '@/app/routes'
import { singleFlightSessionResume } from '@/app/session/hooks/use-prompt-actions/single-flight-resume'
import { primaryResumeParams } from '@/app/session/hooks/use-session-actions/resume-owner'
import { queueSessionRestore } from '@/app/session/session-restore-queue'
import { stableArray } from '@/lib/stable-array'
import type { SessionResumeResult } from '@/types/hermes'

import { $queuedPromptsBySession, serverOwnsComposerQueue } from './composer-queue'
import { journaledPendingSessions, pendingSnapshotFence, reconcilePendingSubmissions } from './pending-submissions'
import { $connection, $gatewayState, $selectedStoredSessionId, $sessions, resolveComposerSessionKey } from './session'
import { knownOwnerForSession, ownerConnectionMode, requestForOwnedSession } from './session-states'

type GatewayRequest = <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>

// A queue card or journal entry the owner has to settle: everything but a local-only card.
const holdsOwnerWork = (key: string): boolean =>
  ($queuedPromptsBySession.get()[key] ?? []).some(entry => Boolean(entry.serverStatus))

/** Sessions whose queue on this machine still names owner-held work: a send queued behind a
 *  running turn, or the lost turn that paused it. */
export function sessionsWithOwnerWork(): string[] {
  const keys = new Set(journaledPendingSessions())

  for (const key of Object.keys($queuedPromptsBySession.get())) {
    if (holdsOwnerWork(key)) {
      keys.add(key)
    }
  }

  return [...keys]
}

async function reconcileOne(request: GatewayRequest, key: string): Promise<void> {
  const owner = knownOwnerForSession(key)
  const profile = owner ? (typeof owner === 'string' ? owner : owner.profile) : undefined

  const snapshot = await singleFlightSessionResume(
    key,
    () =>
      requestForOwnedSession<SessionResumeResult>(
        key,
        request,
        'session.resume',
        { ...primaryResumeParams(key, false, undefined, profile), [RESTORE_SNAPSHOT]: true }
      ),
    { scope: owner }
  ).catch(() => null)

  const info = snapshot?.info

  if (info && Array.isArray(info.pending_submissions)) {
    reconcilePendingSubmissions(
      info.stored_session_id ?? key,
      info.pending_submissions,
      pendingSnapshotFence(info.replay_epoch, info.last_sequence)
    )
  }
}

// The read goes to the chat's OWN backend (`requestForOwnedSession`), which for a bare profile name
// is that profile's backend, not the foreground connection `serverOwnsComposerQueue` inspects: a
// profile with a remote override is a remote, possibly legacy, backend. Only a route provably local
// is read; an owner whose backend mode is unknown is skipped (its chat's own open path reads it).
function ownerRouteIsLocal(key: string): boolean {
  const owner = knownOwnerForSession(key)

  return (owner ? ownerConnectionMode(owner) : $connection.get()?.mode) === 'local'
}

/**
 * Re-read the owner's pending list for every chat this machine queued owner work in, except the
 * one on screen (its route resume reads it). The queue card of a send queued behind a running turn
 * is otherwise refreshed only when its chat is opened: after a relaunch that lands elsewhere, or an
 * owner restart while the app stays up, a send paused behind a turn the restart lost sat invisible
 * and never ran. Every open edge re-reads: a snapshot from an earlier connection says nothing about
 * what the restarted owner holds.
 *
 * This is a real attachment, not an events.since read: the latter cannot tell us which queued
 * admissions survived a restart. Only do it for proven local canonical owners with pending work,
 * behind visible restores. Legacy resume can auto-continue an interrupted turn.
 */
async function reconcileOwnerQueues(request: GatewayRequest, stillOpen: () => boolean): Promise<void> {
  await Promise.all(sessionsWithOwnerWork().map(key => queueSessionRestore('background', async () => {
    // The URL knows its session before the primary hook has selected it.
    // Recheck at dispatch: the user may also have switched while queued.
    const sessions = $sessions.get()
    const selected = routeSessionId(window.location.hash.slice(1)) ?? $selectedStoredSessionId.get()

    if (
      stillOpen() && resolveComposerSessionKey(key, sessions) !== resolveComposerSessionKey(selected, sessions) &&
      serverOwnsComposerQueue(key) && ownerRouteIsLocal(key)
    ) {
      await reconcileOne(request, key)
    }
  })))
}

/** Reconcile off-screen owner work once per gateway open, after the list can route it. */
export function watchOwnerQueues(request: GatewayRequest): () => void {
  let currentOpen: object | undefined

  const check = () => {
    if ($gatewayState.get() !== 'open') {
      currentOpen = undefined
    } else if (!currentOpen && $sessions.get().length > 0) {
      const open = {}
      currentOpen = open
      void reconcileOwnerQueues(request, () => currentOpen === open)
    }
  }

  const stops = [$gatewayState.subscribe(check), $sessions.listen(check)]

  return () => {
    currentOpen = undefined
    stops.forEach(stop => stop())
  }
}

let pausedIds: readonly string[] = []

/** Sessions whose owner FIFO is paused behind a turn it lost in a restart: the queue holds an
 *  `unknown` card that only the user's Discard resolves, so the session needs the user. */
export const $pausedQueueSessionIds = computed(
  $queuedPromptsBySession,
  queues =>
    (pausedIds = stableArray(
      pausedIds,
      Object.keys(queues).filter(key => queues[key]?.some(entry => entry.serverStatus === 'unknown'))
    ))
)
