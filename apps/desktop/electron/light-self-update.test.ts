import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLightSelfUpdater, lastSwapFailure, selectLightRelease } from './light-self-update'
import type { UpdaterStatusWire } from './updater'

const { fetch, getPath, spawn } = vi.hoisted(() => ({ fetch: vi.fn(), getPath: vi.fn(), spawn: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: true, getPath }, net: { fetch } }))
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn,
  // Fake extraction and swap subprocesses; exercise actual streaming, hashing and staging.
  execFile: (_file: string, args: string[], _opts: unknown, done: (error?: unknown) => void) => {
    const payload = path.join(args[3], 'HermesLight')
    void mkdir(payload).then(() => writeFile(path.join(payload, 'Hermes Light.exe'), '')).then(() => done(), done)
  }
}))

const ownTag = 'light-20261123-235959'
const tag = 'light-20261124-000000'
const name = 'HermesLight-win-x64.zip'
const url = `https://github.com/1VeniVediVeci1/hermes-light-veni/releases/download/${tag}/${name}`
const asset = { name, browser_download_url: url, size: 123, digest: `sha256:${'A1'.repeat(32)}` }

function release(fields: Record<string, unknown> = {}) {
  return { tag_name: tag, draft: false, prerelease: false, assets: [asset], ...fields }
}

describe('portable Light release selection', () => {
  it('offers only newer stable Light tags', () => {
    expect(selectLightRelease(release(), ownTag)?.tag).toBe(tag)
    expect(selectLightRelease(release(), tag)).toBeNull()
    expect(selectLightRelease(release({ tag_name: 'light-20261123-000000' }), ownTag)).toBeNull()
    expect(selectLightRelease(release({ tag_name: 'v99.0.0' }), ownTag)).toBeNull()
    expect(selectLightRelease(release({ prerelease: true }), ownTag)).toBeNull()
  })

  it('selects the exact asset and validates the download metadata', () => {
    expect(selectLightRelease(release({ assets: [{ name: 'other.zip' }, asset] }), ownTag)).toEqual({
      tag, url, size: 123, sha256: 'a1'.repeat(32)
    })
    expect(selectLightRelease(release({ assets: [{ ...asset, digest: null }] }), ownTag)?.sha256).toBeUndefined()
    expect(() => selectLightRelease(release({ assets: [{ ...asset, digest: 'sha256:bad' }] }), ownTag)).toThrow(/digest/)
    expect(() => selectLightRelease(release({ assets: [{ ...asset, browser_download_url: 'https://example.com' }] }), ownTag))
      .toThrow(/asset/)
  })
})

const sixHours = 6 * 60 * 60 * 1000

describe('swap failure surfacing', () => {
  it('reports only the most recent attempt, preferring the administrator pass reason', () => {
    const log = [
      'T1 Waiting for 1 and other Hermes Light processes under D:\\Program Files\\HermesLight',
      'T2 Update failed: old reason',
      'T3 Waiting for 2 and other Hermes Light processes under D:\\Program Files\\HermesLight',
      'T4 Access denied, requesting administrator rights: denied',
      'T5 Administrator update failed: file in use',
      'T6 Update failed: Administrator update failed (exit 1)'
    ].join('\r\n')
    expect(lastSwapFailure(log)).toBe('file in use')
    expect(lastSwapFailure(`${log}\r\nT7 Waiting for 3 and other Hermes Light processes under X\r\nT8 Renamed install to X.old`)).toBeUndefined()
    expect(lastSwapFailure('')).toBeUndefined()
  })
})

describe('Light update polling', () => {
  let fixture: string
  const processProperties = new Map<string, PropertyDescriptor | undefined>()

  function stubProcess(name: string, value: string) {
    processProperties.set(name, Object.getOwnPropertyDescriptor(process, name))
    Object.defineProperty(process, name, { configurable: true, value })
  }

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    for (const [name, descriptor] of processProperties) {
      if (descriptor) Object.defineProperty(process, name, descriptor)
      else Reflect.deleteProperty(process, name)
    }
    processProperties.clear()
    if (fixture) await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  })

  async function fixtureUpdater() {
    fixture = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'light-update-test-'))
    const install = path.join(fixture, 'install')
    await mkdir(install)
    await writeFile(path.join(fixture, 'light-release.json'), JSON.stringify({
      tag: ownTag, repo: '1VeniVediVeci1/hermes-light-veni', asset: name
    }))
    stubProcess('execPath', path.join(install, 'Hermes Light.exe'))
    stubProcess('resourcesPath', fixture)
    vi.stubEnv('HERMES_LIGHT_DISABLE_UPDATES', '')
    vi.stubEnv('SystemRoot', fixture)
    if (process.platform !== 'win32') stubProcess('platform', 'win32')
    getPath.mockReturnValue(fixture)

    const bytes = Buffer.from('test portable archive')
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const metadata = vi.fn((latest = tag) => Response.json(release({
      tag_name: latest, assets: [{ ...asset, browser_download_url: url.replace(tag, latest), size: bytes.length, digest }]
    })))
    const download = vi.fn(async () => new Response(bytes))
    fetch.mockImplementation(async (address: string) => address.endsWith('/latest') ? metadata() : download())
    const quitForHandoff = vi.fn()
    const onStatus = vi.fn<(status: UpdaterStatusWire) => void>()
    const log = vi.fn()
    const create = () => createLightSelfUpdater({
      light: true, primary: true, isQuitting: () => false, quitForHandoff, onStatus, log
    })!
    spawn.mockReset()
    spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    return { bytes, metadata, download, onStatus, log, quitForHandoff, create }
  }

  it('offers new versions on schedule without downloading, and keeps the offer when offline', async () => {
    const { create, metadata, download, onStatus, log } = await fixtureUpdater()
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    const updater = create()
    updater.start()
    updater.start()
    await vi.advanceTimersByTimeAsync(3_999)
    expect(metadata).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledTimes(1))
    expect(await updater.check()).toMatchObject({ updateAvailable: true, latestTag: tag })

    metadata.mockImplementationOnce(() => { throw new Error('offline') })
    await vi.advanceTimersByTimeAsync(sixHours)
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('offline')))
    expect(onStatus).toHaveBeenCalledTimes(1)
    expect(await updater.check()).toMatchObject({ latestTag: tag })

    const newerTag = 'light-20261124-060000'
    metadata.mockImplementationOnce(() => Response.json(release({
      tag_name: newerTag, assets: [{ ...asset, browser_download_url: url.replace(tag, newerTag) }]
    })))
    await vi.advanceTimersByTimeAsync(sixHours)
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledTimes(2))
    expect(await updater.apply(tag)).toEqual({ ok: false, error: 'offer-changed' })
    expect(await updater.check()).toMatchObject({ latestTag: newerTag })
    expect(download).not.toHaveBeenCalled()
  })

  it('downloads only on apply, reports throttled progress, and hands the staged payload to swap', async () => {
    const { bytes, create, download, onStatus, quitForHandoff } = await fixtureUpdater()
    vi.useFakeTimers({ toFake: ['setInterval', 'performance'] })
    let stream!: ReadableStreamDefaultController<Uint8Array>
    download.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { stream = controller } })))
    const samples: { at: number; percent: number; bytesPerSecond: number }[] = []
    onStatus.mockImplementation(({ lightProgress }) => {
      if (lightProgress?.stage === 'fetch') samples.push({ ...lightProgress, at: performance.now() })
    })
    const updater = create()
    await updater.check({ force: true })
    expect(download).not.toHaveBeenCalled()
    const apply = updater.apply(tag)
    try {
      expect(await updater.apply(tag)).toEqual({ ok: false, error: 'update-in-flight' })
      await expect.poll(() => download.mock.calls.length).toBe(1)
      const firstChunk = bytes.subarray(0, 8)
      stream.enqueue(firstChunk)
      const partialZip = path.join(fixture, 'HermesLightUpdate', `${tag}.partial`, name)
      await expect.poll(async () => (await stat(partialZip)).size).toBe(firstChunk.length)
      expect(spawn).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(350)
      const percent = Math.floor(100 * firstChunk.length / bytes.length)
      expect(samples[0]).toMatchObject({ percent: 0, bytesPerSecond: 0 })
      const firstProgress = samples.find(sample => sample.percent === percent)!
      expect(firstProgress.at - samples[0].at).toBeGreaterThanOrEqual(350)
      expect(firstProgress.bytesPerSecond).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(1_750)
      expect(samples.at(-1)).toMatchObject({ percent, bytesPerSecond: 0 })
      expect(samples.every((sample, i) => i === 0 || sample.at - samples[i - 1].at >= 350)).toBe(true)

      stream.enqueue(bytes.subarray(firstChunk.length))
    } finally {
      stream.close()
      await apply
    }
    expect(await apply).toEqual({ ok: true, handedOff: true })
    expect(onStatus.mock.calls.slice(-2).map(([status]) => status.lightProgress?.stage)).toEqual(['prepare', 'restart'])
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0][1][3]).toContain('swap.ps1')
    const stage = path.join(fixture, 'HermesLightUpdate', tag)
    expect(await readFile(path.join(stage, name))).toEqual(bytes)
    expect((await stat(path.join(stage, 'payload', 'HermesLight', 'Hermes Light.exe'))).isFile()).toBe(true)
    expect(quitForHandoff).toHaveBeenCalledOnce()
  })

  it('surfaces a download failure, retries, and reuses a verified stage after relaunch', async () => {
    const { create, download, onStatus, quitForHandoff } = await fixtureUpdater()
    download.mockResolvedValueOnce(new Response(null, { status: 503 }))
    const updater = create()
    await updater.check({ force: true })
    const reason = 'Portable asset download: HTTP 503'
    expect(await updater.apply(tag)).toEqual({ ok: false, error: 'apply-failed', message: reason })
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ latestTag: tag, message: reason, lightProgress: undefined }))
    expect(spawn).not.toHaveBeenCalled()
    expect(quitForHandoff).not.toHaveBeenCalled()
    expect(await updater.apply(tag)).toEqual({ ok: true, handedOff: true })

    await writeFile(path.join(fixture, 'HermesLightUpdate', tag, 'swap.log'), 'T1 Waiting for 1 under X\nT2 Update failed: file in use')
    const relaunched = create()
    expect(await relaunched.check({ force: true })).toMatchObject({ latestTag: tag, message: 'file in use' })
    expect(await relaunched.apply(tag)).toEqual({ ok: true, handedOff: true })
    expect(download).toHaveBeenCalledTimes(2)
    expect(quitForHandoff).toHaveBeenCalledTimes(2)
  })
})
