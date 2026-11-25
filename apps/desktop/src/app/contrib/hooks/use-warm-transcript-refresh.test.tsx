import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionStateCache } from '@/app/session/hooks/use-session-state-cache'
import { getLatestSessionMessages, type SessionMessagesResponse } from '@/hermes'
import { toChatMessages } from '@/lib/chat-messages'
import { $changeEventsAvailable, notifySessionsChanged } from '@/store/live-sync'
import {
  $activeSessionId,
  $selectedStoredSessionId,
  setCronSessions,
  setMessagingSessions,
  setSessions
} from '@/store/session'
import { $sessionTiles, clearAllSessionStates } from '@/store/session-states'
import { makeSessionInfo } from '@/test/session-info'

import { useBackgroundSync } from './use-background-sync'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal()),
  getLatestSessionMessages: vi.fn()
}))
vi.mock('@/store/projects', async importOriginal => ({
  ...(await importOriginal()),
  refreshProjects: vi.fn(),
  refreshProjectTree: vi.fn()
}))

const noop = () => undefined
const requestGateway = vi.fn(async () => ({ sessions: [] })) as never
const scope = { connectionId: 'storage-owner', profile: 'work' }
const stateMessages = toChatMessages([{ content: 'cached', role: 'assistant', timestamp: 1 }])

function page(storedId: string): SessionMessagesResponse {
  return {
    messages: [{ content: 'remote reply', role: 'assistant', timestamp: 2 }],
    profile: scope.profile,
    session_id: storedId
  }
}

function renderSync(ids: string[], busyIds: string[] = [], activeIsMessaging = false) {
  let count = 1
  const refreshSessions = async () => {
    // Publish asynchronously, like the real batched sidebar list request.
    await Promise.resolve()
    const rows = ids.map(id =>
      makeSessionInfo({
        connection_id: scope.connectionId,
        id,
        profile: scope.profile,
        message_count: count,
        last_active: count,
        _lineage_root_id: `root-${id}`
      })
    )
    setSessions(rows.filter(row => !['messaging', 'cron'].includes(row.id)))
    setCronSessions(rows.filter(row => row.id === 'cron'))
    setMessagingSessions(rows.filter(row => row.id === 'messaging'))
  }
  const activeSessionId = 'rt-active'
  const busyRef = { current: false }
  const { result } = renderHook(() => {
    const cache = useSessionStateCache({
      activeSessionId,
      busyRef,
      selectedStoredSessionId: 'active',
      setAwaitingResponse: noop,
      setBusy: noop,
      setMessages: noop
    })
    useBackgroundSync({
      activeConnectionId: 'foreground',
      activeGatewayProfile: 'default',
      activeIsMessaging,
      activeSessionId,
      activeStoredSessionId: 'active',
      freshDraftReady: false,
      gatewayState: 'open',
      refreshActiveTranscript: noop,
      refreshCronJobs: noop,
      refreshCurrentModel: noop,
      refreshHermesConfig: noop,
      refreshMessagingSessions: noop,
      refreshSessions,
      requestGateway,
      updateSessionState: cache.updateSessionState,
      warmTranscriptCache: cache
    })
    return cache
  })
  return {
    seed: () =>
      act(async () => {
        for (const id of ids.filter(id => id !== 'cold')) {
          result.current.updateSessionState(
            `rt-${id}`,
            state => ({
              ...state,
              busy: busyIds.includes(id),
              messages: stateMessages
            }),
            id
          )
        }
      }),
    changed: () => {
      count += 1
    },
    get: (id: string) => result.current.sessionStateByRuntimeIdRef.current.get(`rt-${id}`),
    evict: (id: string) => result.current.sessionStateByRuntimeIdRef.current.delete(`rt-${id}`)
  }
}

async function tick() {
  await act(async () => {
    notifySessionsChanged()
    await vi.advanceTimersByTimeAsync(10_000)
  })
}

describe('warm transcripts on background sync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    $changeEventsAvailable.set(true)
    $activeSessionId.set('rt-active')
    $selectedStoredSessionId.set('active')
    vi.mocked(getLatestSessionMessages).mockImplementation(async id => page(id))
  })

  afterEach(() => {
    cleanup()
    clearAllSessionStates()
    setSessions([])
    setCronSessions([])
    setMessagingSessions([])
    $sessionTiles.set([])
    $changeEventsAvailable.set(false)
    $activeSessionId.set(null)
    $selectedStoredSessionId.set(null)
    vi.resetAllMocks()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('refreshes changed warm rows only, and stamps the exact resume scope', async () => {
    const cache = renderSync(['active', 'running', 'messaging', 'cron', 'cold'], ['running'])
    await cache.seed()
    await tick()
    expect(getLatestSessionMessages).not.toHaveBeenCalled()

    cache.changed()
    await tick()
    expect(vi.mocked(getLatestSessionMessages).mock.calls.map(([id]) => id)).toEqual(['messaging', 'cron'])
    expect(getLatestSessionMessages).toHaveBeenCalledWith(
      'messaging',
      scope,
      expect.objectContaining({ passive: true })
    )
    expect(cache.get('messaging')).toMatchObject({
      messages: toChatMessages(page('messaging').messages),
      transcriptProvenance: {
        ...scope,
        coverage: 'latest-page',
        lineageRootId: 'root-messaging',
        source: 'persisted-display',
        storedSessionId: 'messaging'
      }
    })
    expect(cache.get('running')?.messages).toBe(stateMessages)
    expect(cache.get('active')?.messages).toBe(stateMessages)
    expect(cache.get('cold')).toBeUndefined()

    await tick()
    expect(getLatestSessionMessages).toHaveBeenCalledTimes(2)
  })

  it.each(['visit', 'evict'] as const)('discards a completed read after %s during the request', async race => {
    const cache = renderSync(['warm'])
    await cache.seed()
    await tick()

    let release!: (value: SessionMessagesResponse) => void
    vi.mocked(getLatestSessionMessages).mockReturnValueOnce(
      new Promise(resolve => {
        release = resolve
      })
    )
    cache.changed()
    await tick()
    expect(getLatestSessionMessages).toHaveBeenCalledTimes(1)
    const before = cache.get('warm')
    const { shouldRecordTail } = vi.mocked(getLatestSessionMessages).mock.calls[0][2] ?? {}

    await act(async () => {
      if (race === 'visit') {
        // The target is no longer selected by completion, but the read still loses ownership.
        $selectedStoredSessionId.set('warm')
        $selectedStoredSessionId.set('active')
      } else {
        cache.evict('warm')
      }
      expect(shouldRecordTail?.(page('warm'))).toBe(false)
      release(page('warm'))
    })
    expect(cache.get('warm')).toBe(race === 'visit' ? before : undefined)
  })

  it('catches up on window return even with a messaging session in the foreground', async () => {
    const cache = renderSync(['warm'], [], true)
    await cache.seed()
    await tick()
    cache.changed()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(cache.get('warm')?.messages).toEqual(toChatMessages(page('warm').messages))
  })
})
