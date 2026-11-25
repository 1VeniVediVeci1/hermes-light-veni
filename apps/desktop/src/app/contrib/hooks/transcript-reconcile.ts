import { graftRefreshedTailOntoBackfill } from '@/app/chat/transcript-backfill'
import { isSessionRecentlyInterrupted } from '@/app/session/hooks/use-prompt-actions/utils'
import { preserveLocalPendingTurnMessages } from '@/app/session/hooks/use-session-actions/utils'
import type { SessionMessage } from '@/hermes'
import { type ChatMessage, preserveLocalAssistantErrors, preserveLocalSystemNotices } from '@/lib/chat-messages'
import { sessionMessagesSignature } from '@/lib/session-signatures'

import type { ClientSessionState } from '../../types'

/** Stop idles the view before its completion receipt binds the stored rows.
 * A page read in that gap can duplicate the stopped turn (#144899 N2). */
export function stopAwaitsItsReceipt(state: ClientSessionState, runtimeId: string): boolean {
  if (!state.interrupted || !isSessionRecentlyInterrupted(runtimeId)) {
    return false
  }

  const messages = state.messages
  const lastUser = messages.findLastIndex(message => message.role === 'user')
  const lastReply = messages.findLastIndex(message => message.role === 'assistant' && !message.hidden)

  if (lastReply > lastUser) {
    return !messages[lastReply].persistedTurn
  }

  return lastUser >= 0 && messages[lastUser].rowId === undefined
}

export function runtimeOwnsLiveTranscript(state: ClientSessionState | undefined, runtimeId: string): boolean {
  return Boolean(
    state &&
    (state.busy ||
      state.awaitingResponse ||
      state.needsInput ||
      state.turnLive ||
      stopAwaitsItsReceipt(state, runtimeId))
  )
}

/** An empty read racing a backend respawn or a commit must not blank a populated transcript. */
export function emptyPageOverPopulatedTranscript(
  page: readonly unknown[],
  current: ClientSessionState | undefined,
  storedSessionId: string
): boolean {
  return page.length === 0 && Boolean(current?.messages.length) && current?.storedSessionId === storedSessionId
}

export function refreshedTranscriptSignature(
  messages: SessionMessage[],
  current: ClientSessionState | undefined,
  storedSessionId: string
): string | undefined {
  return emptyPageOverPopulatedTranscript(messages, current, storedSessionId)
    ? undefined
    : sessionMessagesSignature(messages)
}

/** Keep backfilled pages, optimistic input, local errors, and trailing client notices. */
export function mergeRefreshedTranscript(
  tail: ChatMessage[],
  previous: ChatMessage[],
  keepBackfill = true
): ChatMessage[] {
  return preserveLocalSystemNotices(
    preserveLocalAssistantErrors(
      preserveLocalPendingTurnMessages(keepBackfill ? graftRefreshedTailOntoBackfill(tail, previous) : tail, previous),
      previous
    ),
    previous
  )
}
