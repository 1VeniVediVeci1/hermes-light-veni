import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearNotifications, notify } from '@/store/notifications'
import { stubResizeObserver } from '@/test/jsdom'

import { NotificationStack } from './notifications'

beforeAll(stubResizeObserver)

describe('toast titles', () => {
  beforeEach(() => {
    clearNotifications()
  })

  afterEach(() => {
    cleanup()
    clearNotifications()
  })

  it('keeps an action card mounted as it turns into download progress', async () => {
    const card = { id: 'update', title: 'Update available', message: 'Version 2 is available.', placement: 'bottom-right' } as const
    const onDismiss = vi.fn()
    notify({ ...card, onDismiss, action: {
      label: 'Download and update', keepOpen: true,
      onClick: () => notify({ ...card, title: 'Downloading…', progress: 42, meta: '42% · 8.3 MB/s', onDismiss })
    } })
    render(<NotificationStack />)
    fireEvent.click(screen.getByRole('button', { name: 'Download and update' }))
    const bar = screen.getByRole('progressbar', { name: 'Downloading…' })
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
    expect(screen.getByText('42% · 8.3 MB/s')).toBeTruthy()
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull())
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it.each(['default', 'bottom-right'] as const)(
    'caps the %s toast stack at one back edge and keeps older notifications reachable',
    async placement => {
      for (let index = 0; index < 7; index++) {
        notify({ id: `notice-${index}`, message: `Notice ${index}`, placement, durationMs: 0 })
      }

      render(<NotificationStack />)
      expect(screen.getAllByRole('status')).toHaveLength(1)
      expect(document.querySelectorAll('[data-slot="card-stack-edge"]')).toHaveLength(1)
      fireEvent.click(screen.getByRole('button', { name: /Show.*6/ }))
      expect(screen.getByText('Notice 0')).toBeTruthy()
      expect(screen.getAllByRole('status')).toHaveLength(7)
      fireEvent.click(screen.getAllByRole('button', { name: /Dismiss/ })[0])
      await waitFor(() => expect(screen.queryByText('Notice 6')).toBeNull())
    }
  )
})
