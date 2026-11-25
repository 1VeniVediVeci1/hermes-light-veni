import { type MutableRefObject, useLayoutEffect, useMemo } from 'react'

import { ambientOwnerConnectionId, sessionReadOwnerPin } from '@/api/client'
import { transcriptRestScope } from '@/app/session/hooks/use-session-actions/provisional-transcript'
import { ambientResumeConnectionId } from '@/app/session/hooks/use-session-actions/resume-owner'
import {
  createPersistedDisplayTranscriptProvenance,
  hasPersistedDisplayTranscriptProvenance
} from '@/app/session/hooks/use-session-actions/transcript-provenance'
import { getLatestSessionMessages, type SessionInfo, type SessionMessagesResponse } from '@/hermes'
import { toChatMessages } from '@/lib/chat-messages'
import { sessionListFingerprint } from '@/lib/session-signatures'
import { $clarifyRequests } from '@/store/clarify'
import { $connectionRequests } from '@/store/connection-request'
import { gatewayActivationEpoch, pendingSessionReplay } from '@/store/gateway'
import { $changeEventsAvailable } from '@/store/live-sync'
import { hasBlockingPromptRequest } from '@/store/prompts'
import {
  $activeSessionId,
  $cronSessions,
  $messagingSessions,
  $selectedStoredSessionId,
  $sessions,
  sessionMatchesStoredId,
  sessionOwnerRouteFromRow
} from '@/store/session'
import { isSessionOwnerRoute } from '@/store/session-request-router'
import {
  $attentionSessionIds,
  $sessionStates,
  $sessionTiles,
  $workingSessionIds,
  knownOwnerForSession
} from '@/store/session-states'

import type { ClientSessionState } from '../../types'

import {
  emptyPageOverPopulatedTranscript,
  mergeRefreshedTranscript,
  refreshedTranscriptSignature,
  runtimeOwnsLiveTranscript
} from './transcript-reconcile'

export interface WarmTranscriptCache {
  runtimeIdByStoredSessionIdRef: MutableRefObject<Map<string, string>>
  sessionStateByRuntimeIdRef: MutableRefObject<Map<string, ClientSessionState>>
}

type UpdateSessionState = (
  runtimeId: string,
  update: (state: ClientSessionState) => ClientSessionState
) => ClientSessionState

function listedRows() {
  return [...$sessions.get(), ...$cronSessions.get(), ...$messagingSessions.get()]
}

function listedTarget(storedId: string, rows: readonly SessionInfo[]) {
  // Do not re-key an old runtime to a continuation here. Activate owns that
  // handoff, and a matching lineage alias alone is not a durable id match.
  const matches = rows.filter(row => row.id === storedId)
  const row = matches[0]
  if (
    !row ||
    !row.profile ||
    matches.some(other => other.connection_id !== row.connection_id || other.profile !== row.profile)
  ) {
    return undefined
  }

  // Use the same REST scope as switching from the sidebar, including an
  // explicit source for a tagged row or an untagged remote list.
  const scope = transcriptRestScope(sessionOwnerRouteFromRow(row), row, ambientResumeConnectionId())
  const provenance = createPersistedDisplayTranscriptProvenance({
    storedSessionId: storedId,
    lineageRootId: row._lineage_root_id ?? null,
    scope
  })
  const connectionId = provenance.connectionId || ambientOwnerConnectionId() || ''
  const ownerPin = sessionReadOwnerPin(storedId, scope)
  if (ownerPin.connectionId && ownerPin.connectionId !== connectionId) {
    // A conflicting remembered owner must not redirect an untagged list read.
    return undefined
  }
  return { row, scope, provenance, connectionId, fingerprint: sessionListFingerprint(row) }
}

function isSelected(row: SessionInfo, runtimeId: string): boolean {
  const selected = $selectedStoredSessionId.get()
  return $activeSessionId.get() === runtimeId || (selected !== null && sessionMatchesStoredId(row, selected))
}

function canRefresh(row: SessionInfo, runtimeId: string, state: ClientSessionState): boolean {
  const live = $sessionStates.get()[runtimeId]
  return (
    !isSelected(row, runtimeId) &&
    !$sessionTiles
      .get()
      .some(tile => tile.runtimeId === runtimeId || sessionMatchesStoredId(row, tile.storedSessionId)) &&
    !runtimeOwnsLiveTranscript(state, runtimeId) &&
    !runtimeOwnsLiveTranscript(live, runtimeId) &&
    !state.streamId &&
    !live?.streamId &&
    !$workingSessionIds.get().includes(row.id) &&
    !$attentionSessionIds.get().includes(row.id) &&
    !$clarifyRequests.get()[runtimeId] &&
    !$connectionRequests.get()[runtimeId] &&
    !hasBlockingPromptRequest(runtimeId) &&
    !pendingSessionReplay(runtimeId)
  )
}

function createWarmTranscriptReconciler(cache: WarmTranscriptCache, updateSessionState: UpdateSessionState) {
  const { runtimeIdByStoredSessionIdRef, sessionStateByRuntimeIdRef } = cache
  const observed = new Map<string, { runtimeId: string; connectionId: string; profile: string; fingerprint: string }>()
  const signatures = new WeakMap<ClientSessionState['messages'], string>()
  let generation = 0
  let pending: number | undefined
  let draining = false

  const isBound = (storedId: string, runtimeId: string) =>
    runtimeIdByStoredSessionIdRef.current.get(storedId) === runtimeId

  const rememberRows = () => {
    for (const [storedId, seen] of observed) {
      if (!isBound(storedId, seen.runtimeId) || !sessionStateByRuntimeIdRef.current.has(seen.runtimeId)) {
        observed.delete(storedId)
      }
    }
    const rows = listedRows()
    for (const [runtimeId, state] of sessionStateByRuntimeIdRef.current) {
      const storedId = state.storedSessionId
      if (!storedId || !isBound(storedId, runtimeId) || observed.has(storedId)) {
        continue
      }
      const target = listedTarget(storedId, rows)
      if (target) {
        observed.set(storedId, {
          runtimeId,
          connectionId: target.connectionId,
          profile: target.provenance.profile,
          fingerprint: target.fingerprint
        })
      }
    }
  }

  async function reconcile(request: number) {
    const epoch = gatewayActivationEpoch()
    const isCurrentRound = () =>
      request === generation && $changeEventsAvailable.get() && epoch === gatewayActivationEpoch()
    const rows = listedRows()
    for (const [storedId, seen] of observed) {
      if (!isCurrentRound()) {
        return
      }
      const target = listedTarget(storedId, rows)
      if (
        !target ||
        target.connectionId !== seen.connectionId ||
        target.provenance.profile !== seen.profile ||
        target.fingerprint === seen.fingerprint
      ) {
        continue
      }
      const { runtimeId } = seen
      const state = sessionStateByRuntimeIdRef.current.get(runtimeId)
      if (
        !state?.messages.length ||
        state.storedSessionId !== storedId ||
        !isBound(storedId, runtimeId) ||
        !canRefresh(target.row, runtimeId, state)
      ) {
        continue
      }
      const knownOwner = knownOwnerForSession(runtimeId, rows)
      if (
        isSessionOwnerRoute(knownOwner) &&
        (knownOwner.connectionId !== target.connectionId ||
          (knownOwner.targetProfile || knownOwner.profile) !== target.provenance.profile)
      ) {
        continue
      }
      if (state.transcriptProvenance && !hasPersistedDisplayTranscriptProvenance(state, target.provenance)) {
        // Same stored id is not permission to merge across owners or lineages.
        continue
      }

      // A visit can start and finish during the REST read without leaving
      // the target active at completion. Revoke the write at selection time.
      let visited = false
      const noteVisit = () => {
        visited ||= isSelected(target.row, runtimeId)
      }
      const unlistenSelected = $selectedStoredSessionId.listen(noteVisit)
      const unlistenActive = $activeSessionId.listen(noteVisit)
      const ownsRead = () => {
        if (
          !isCurrentRound() ||
          visited ||
          !isBound(storedId, runtimeId) ||
          sessionStateByRuntimeIdRef.current.get(runtimeId) !== state ||
          !canRefresh(target.row, runtimeId, state)
        ) {
          return false
        }
        const current = listedTarget(storedId, listedRows())
        return (
          current?.connectionId === target.connectionId &&
          current.provenance.profile === target.provenance.profile &&
          current.provenance.lineageRootId === target.provenance.lineageRootId &&
          current.fingerprint === target.fingerprint
        )
      }

      const acceptPage = (page: SessionMessagesResponse) =>
        page.session_id === storedId &&
        (!page.profile || page.profile === target.provenance.profile) &&
        !emptyPageOverPopulatedTranscript(page.messages, state, storedId) &&
        ownsRead()

      try {
        // The REST helper also records the backfill cursor. A discarded read
        // must not overwrite that metadata for a newly activated transcript.
        const page = await getLatestSessionMessages(storedId, target.scope, {
          passive: true,
          shouldRecordTail: acceptPage
        }).catch(() => undefined)
        if (!page || !acceptPage(page)) {
          // Keep the old fingerprint so the next event can retry.
          continue
        }
        const signature = refreshedTranscriptSignature(page.messages, state, storedId)
        if (signature === undefined) {
          continue
        }
        if (signatures.get(state.messages) !== signature) {
          const messages = mergeRefreshedTranscript(
            toChatMessages(page.messages),
            state.messages,
            Boolean(state.transcriptProvenance)
          )
          const next = updateSessionState(runtimeId, current => ({
            ...current,
            messages,
            transcriptProvenance: target.provenance
          }))
          signatures.set(next.messages, signature)
        }
        seen.fingerprint = target.fingerprint
      } finally {
        unlistenSelected()
        unlistenActive()
      }
    }
  }

  return {
    rememberRows,
    cancel() {
      generation += 1
      pending = undefined
    },
    // List refreshes can overlap; transcript reads never do. Keep only the
    // latest ready pass and discard any older in-flight transcript result.
    async afterListRefresh(refresh: () => Promise<unknown>) {
      rememberRows()
      const request = ++generation
      await refresh()
      if (request !== generation) {
        return
      }
      pending = request
      if (draining) {
        return
      }
      draining = true
      try {
        while (pending !== undefined) {
          const next = pending
          pending = undefined
          await reconcile(next)
        }
      } finally {
        draining = false
      }
    },
    hasInactiveRows() {
      rememberRows()
      const rows = listedRows()
      return [...observed].some(([storedId, seen]) => {
        const target = listedTarget(storedId, rows)
        return target && !isSelected(target.row, seen.runtimeId)
      })
    }
  }
}

export function useWarmTranscriptRefresh({
  cache,
  enabled,
  activeSessionId,
  selectedStoredId,
  connectionId,
  profile,
  updateSessionState
}: {
  cache?: WarmTranscriptCache
  enabled: boolean
  activeSessionId: string | null
  selectedStoredId: string | null
  connectionId: string | null
  profile: string
  updateSessionState: UpdateSessionState
}) {
  const runtimeIdByStoredSessionIdRef = cache?.runtimeIdByStoredSessionIdRef
  const sessionStateByRuntimeIdRef = cache?.sessionStateByRuntimeIdRef
  const reconciler = useMemo(
    () =>
      runtimeIdByStoredSessionIdRef && sessionStateByRuntimeIdRef
        ? createWarmTranscriptReconciler(
            { runtimeIdByStoredSessionIdRef, sessionStateByRuntimeIdRef },
            updateSessionState
          )
        : undefined,
    [runtimeIdByStoredSessionIdRef, sessionStateByRuntimeIdRef, updateSessionState]
  )
  useLayoutEffect(() => () => reconciler?.cancel(), [connectionId, enabled, profile, reconciler])
  useLayoutEffect(() => {
    if (enabled) {
      reconciler?.rememberRows()
    }
    // Remember the row while the cached runtime is still the active view, not
    // only after a list refresh has already observed a remote append.
  }, [activeSessionId, enabled, reconciler, selectedStoredId])
  return enabled ? reconciler : undefined
}
