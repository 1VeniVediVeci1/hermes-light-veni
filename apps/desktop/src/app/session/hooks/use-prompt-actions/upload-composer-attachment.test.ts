import { afterEach, describe, expect, it, vi } from 'vitest'

import { uploadComposerAttachment } from '.'

// Per-file copy, matching the convention of the other shards in this directory
// (preview-open.test.tsx, session-tile-actions.test.ts): the id the desktop
// holds is the *runtime* session id from session.create.
const RUNTIME_SESSION_ID = 'rt-abc123'

// Kept byte-identical to index.test.tsx: both specifiers are alias-based and
// this file sits in the same directory, so the mocks resolve to the same
// modules the parent suite mocks.
vi.mock('@/hermes', () => ({
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  getSession: vi.fn(),
  PROMPT_SUBMIT_REQUEST_TIMEOUT_MS: 1_800_000,
  setApiRequestProfile: vi.fn(),
  transcribeAudio: vi.fn()
}))

vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestGatewayForAgent: vi.fn()
}))

describe('uploadComposerAttachment remote read failures', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('turns a size-limit error from HTTP staging into a friendly remote-gateway message', async () => {
    const api = vi.fn(async () => {
      throw new Error('Attachment upload failed: file is too large (20971520 bytes; limit 16777216 bytes).')
    })
    vi.stubGlobal('hermesDesktop', { api })

    const requestGateway = vi.fn(async () => ({}) as never)

    await expect(
      uploadComposerAttachment(
        { id: 'file:big', kind: 'file', label: 'huge.csv', path: '/abs/huge.csv' },
        { remote: true, requestGateway, sessionId: RUNTIME_SESSION_ID }
      )
    ).rejects.toThrow(/huge\.csv.*16 MB/)

    expect(api).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/api/chat/file-upload', upload: { path: '/abs/huge.csv', filename: 'huge.csv' }
    }))
    expect(requestGateway).not.toHaveBeenCalled()
  })
})

describe('uploadComposerAttachment image cache contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('always re-reads the image from disk, even when a stale previewUrl is cached', async () => {
    // attachImagePath drops `previewUrl` as soon as a thumbnail exists, so a
    // populated `previewUrl` here does not mean it holds full-resolution
    // bytes (#93324) — the upload must never trust it and must always read
    // the on-disk file for the bytes the model receives.
    const diskDataUrl = 'data:image/png;base64,ZnJvbS1kaXNr'
    const hostPath = '/gw/images/shot.png'
    const readFileDataUrlForAttach = vi.fn(async () => diskDataUrl)
    const readFileDataUrl = vi.fn()
    const api = vi.fn(async () => ({ path: hostPath }))
    vi.stubGlobal('hermesDesktop', { api, readFileDataUrl, readFileDataUrlForAttach })
    const requestGateway = vi.fn(async () => ({ attached: true, path: hostPath }) as never)

    const uploaded = await uploadComposerAttachment(
      {
        id: 'image:shot.png',
        kind: 'image',
        label: 'shot.png',
        path: '/local/shot.png',
        previewUrl: 'data:image/png;base64,c3RhbGUtY2FjaGVk'
      },
      { remote: true, requestGateway, sessionId: RUNTIME_SESSION_ID }
    )

    expect(readFileDataUrlForAttach).toHaveBeenCalledExactlyOnceWith('/local/shot.png')
    expect(readFileDataUrl).not.toHaveBeenCalled()
    expect(api).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      method: 'POST', path: '/api/chat/image-upload', body: { data_url: diskDataUrl, filename: 'shot.png' }
    }))
    expect(requestGateway).toHaveBeenCalledExactlyOnceWith('image.attach', {
      path: hostPath, session_id: RUNTIME_SESSION_ID
    })
    expect(uploaded.path).toBe(hostPath)
  })
})

describe('uploadComposerAttachment local cross-platform staging', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses image.attach_bytes for a Windows image when the local backend cwd is POSIX', async () => {
    const readFileDataUrl = vi.fn(async () => 'data:image/jpeg;base64,aGVsbG8=')
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { readFileDataUrl }
    })

    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'image.attach_bytes') {
        return { attached: true, path: '/root/tmp/photo.jpg' } as never
      }

      return {} as never
    })

    const uploaded = await uploadComposerAttachment(
      {
        id: 'image:photo.jpg',
        kind: 'image',
        label: 'photo.jpg',
        path: 'C:\\Users\\alice\\Pictures\\photo.jpg'
      },
      {
        backendCwd: '/root',
        remote: false,
        requestGateway,
        sessionId: RUNTIME_SESSION_ID
      }
    )

    expect(readFileDataUrl).toHaveBeenCalledWith('C:\\Users\\alice\\Pictures\\photo.jpg')
    expect(requestGateway).toHaveBeenCalledWith('image.attach_bytes', {
      content_base64: 'aGVsbG8=',
      filename: 'photo.jpg',
      session_id: RUNTIME_SESSION_ID
    }, 0)
    expect(requestGateway).not.toHaveBeenCalledWith('image.attach', expect.anything())
    expect(uploaded.path).toBe('/root/tmp/photo.jpg')
  })
})
