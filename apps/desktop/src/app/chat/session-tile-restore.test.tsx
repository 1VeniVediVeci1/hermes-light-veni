import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { withRoutedSessionRestore } from '@/app/session/session-restore-queue'
import { PaneVisibleContext } from '@/components/pane-shell/pane-visibility'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $gatewayState } from '@/store/session'
import {
  $sessionTiles,
  clearAllSessionStates,
  publishSessionState,
  resetTileRuntimeBindings,
  type SessionTileDelegate,
  setSessionTileDelegate
} from '@/store/session-states'

import { SessionTilePane } from './session-tile'
import { watchLiveSessionTileRestores } from './session-tile-restore'

const shown = (id: string, visible = true) => (
  <PaneVisibleContext.Provider key={id} value={visible}>
    <SessionTilePane storedSessionId={id} />
  </PaneVisibleContext.Provider>
)

afterEach(() => {
  cleanup()
  $gatewayState.set('idle')
  $sessionTiles.set([])
  clearAllSessionStates()
})

it('restores the route, both visible split panes, and then a running hidden tile; idle tabs wait', async () => {
  const calls: string[] = []
  const queued = new Map<string, () => void>()

  const resumeTile = vi.fn((id: string) => {
    calls.push(id)

    return new Promise<string>((resolve, reject) => {
      queued.set(id, () => id === 'live' ? resolve('runtime-live') : reject(new Error('fixture unavailable')))
    })
  })

  setSessionTileDelegate({ resumeTile } as unknown as SessionTileDelegate)
  $sessionTiles.set(['hidden', 'left', 'right', 'live'].map(storedSessionId => ({ storedSessionId })))
  const stop = watchLiveSessionTileRestores()
  const paneSet = (hiddenVisible: boolean) => <>{shown('hidden', hiddenVisible)}{shown('left')}{shown('right')}</>
  const panes = render(paneSet(false))

  try {
    let finishRoute!: () => void
    act(() => {
      $gatewayState.set('open')
      // The active-list snapshot can identify a working tile whose body is
      // parked (not mounted); unlike events.since this will subscribe it.
      publishSessionState('live-runtime', { ...createClientSessionState('live'), busy: true })
      void withRoutedSessionRestore(() => {
        calls.push('route')

        return new Promise<void>(resolve => { finishRoute = resolve })
      })
    })
    expect(calls).toEqual(['route'])

    finishRoute()
    await waitFor(() => expect(calls).toEqual(['route', 'left']))
    await act(async () => queued.get('left')?.())
    await waitFor(() => expect(calls).toEqual(['route', 'left', 'right']))
    await act(async () => queued.get('right')?.())
    await waitFor(() => expect(calls).toEqual(['route', 'left', 'right', 'live']))
    await act(async () => queued.get('live')?.())
    expect($sessionTiles.get().find(tile => tile.storedSessionId === 'live')?.runtimeId).toBe('runtime-live')

    act(() => {
      $gatewayState.set('closed')
      resetTileRuntimeBindings()
      publishSessionState('live-runtime', createClientSessionState('live'))
      $gatewayState.set('open')
    })
    await waitFor(() => expect(calls).toEqual(['route', 'left', 'right', 'live', 'left']))
    await act(async () => queued.get('left')?.())
    await waitFor(() => expect(calls).toEqual(['route', 'left', 'right', 'live', 'left', 'right']))
    await act(async () => queued.get('right')?.())

    panes.rerender(paneSet(true))
    await waitFor(() => expect(calls).toEqual(['route', 'left', 'right', 'live', 'left', 'right', 'hidden']))
    await act(async () => queued.get('hidden')?.())
  } finally {
    stop()
  }
})
