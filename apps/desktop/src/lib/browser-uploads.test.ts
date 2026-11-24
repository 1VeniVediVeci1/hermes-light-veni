import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useComposerActions } from '@/app/chat/hooks/use-composer-actions'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $connection } from '@/store/session'
import { clearWebappSession, seedWebappSession } from '@/test/webapp-session'

import { installBrowserDesktopBridge } from './browser-desktop-bridge'

afterEach(() => {
  cleanup()
  clearNotifications()
  clearWebappSession()
  Reflect.deleteProperty(window, 'hermesDesktop')
  document.documentElement.removeAttribute('data-hermes-desktop-host')
  $connection.set(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function png(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  return bytes
}

describe('browser image paste size', () => {
  it('stages an image over the old 16 MiB limit without a deadline', async () => {
    seedWebappSession('served-token')

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ path: '/srv/hermes/cache/images/upload.png' }), { status: 200 })
    )

    vi.stubGlobal('fetch', fetchMock)
    expect(installBrowserDesktopBridge()).toBe(true)

    await expect(window.hermesDesktop!.saveImageBuffer(png(16 * 1024 * 1024 + 1), '.png')).resolves.toBe(
      '/srv/hermes/cache/images/upload.png'
    )
    expect((fetchMock.mock.calls[0] as [URL, RequestInit])[0].pathname).toBe('/api/chat/image-upload')
    expect((fetchMock.mock.calls[0] as [URL, RequestInit])[1].signal).toBeUndefined()
  })
})

describe('browser file stage size', () => {
  const overImageLimit = (name: string, type: string) =>
    new File([new Uint8Array(16 * 1024 * 1024 + 1)], name, { type })

  async function installBrowser() {
    seedWebappSession('served-token')

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin)

      if (url.pathname === '/api/chat/file-upload' && init?.method === 'POST') {
        return new Response(JSON.stringify({ path: '/srv/hermes/uploads/huge.zip' }), { status: 200 })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)
    expect(installBrowserDesktopBridge()).toBe(true)
    $connection.set(await window.hermesDesktop.getConnection('owner'))

    const uploads = () => fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/chat/file-upload'))

    return { uploads }
  }

  const renderComposer = () =>
    renderHook(() => useComposerActions({ activeSessionId: null, currentCwd: '/workspace', requestGateway: vi.fn() }))

  it('uploads a picked non-image file over 16 MiB without an error', async () => {
    const { uploads } = await installBrowser()
    const { result } = renderComposer()
    const file = overImageLimit('huge.zip', 'application/zip')

    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] })
      this.dispatchEvent(new Event('change'))
    })

    await act(async () => {
      await result.current.pickContextPaths('file')
    })

    const requests = uploads()
    expect(requests).toHaveLength(1)
    expect((requests[0]?.[1]?.body as FormData).get('file')).toMatchObject({ name: file.name, size: file.size })
    expect($notifications.get()).toHaveLength(0)
  })
})
