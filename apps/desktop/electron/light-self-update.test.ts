import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLightSelfUpdater, lastSwapFailure, selectLightRelease } from './light-self-update'

const { fetch, getPath } = vi.hoisted(() => ({ fetch: vi.fn(), getPath: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: true, getPath }, net: { fetch } }))
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  // Fake only the extraction subprocess; exercise actual streaming, hashing and staging.
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
    if (fixture) await rm(fixture, { recursive: true, force: true })
  })

  it('offers only verified stages and refreshes the offer without duplicate downloads', async () => {
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

    const newer = 'light-20261124-060000'
    const bytes = 'test portable archive'
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const download = vi.fn<(url: string) => Promise<Response>>().mockImplementation(async () => new Response(bytes))
    let finishDownload!: (response: Response) => void
    download.mockImplementationOnce(() => new Promise(resolve => { finishDownload = resolve }))
    let latest = tag
    const metadata = vi.fn(() => Response.json(release({
      tag_name: latest, assets: [{ ...asset, browser_download_url: url.replace(tag, latest), size: bytes.length, digest }]
    })))
    fetch.mockImplementation(async (url: string) => url.endsWith('/latest') ? metadata() : download(url))

    const onStatus = vi.fn()
    const log = vi.fn()
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    const updater = createLightSelfUpdater({
      light: true, primary: true, isQuitting: () => false, quitForHandoff: vi.fn(), onStatus, log
    })!
    expect(updater).toBeDefined()
    updater.start()
    updater.start()
    await vi.advanceTimersByTimeAsync(3_999)
    expect(metadata).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(onStatus).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(sixHours)
    expect(metadata).toHaveBeenCalledTimes(1)
    const firstCheck = updater.check({ force: true })
    finishDownload(new Response(bytes))
    expect(await firstCheck).toMatchObject({ updateAvailable: true, latestTag: tag })
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ updateAvailable: true, latestTag: tag }))

    await vi.advanceTimersByTimeAsync(sixHours)
    await vi.waitFor(() => expect(metadata).toHaveBeenCalledTimes(2))
    expect(download).toHaveBeenCalledTimes(1)
    expect(onStatus).toHaveBeenCalledTimes(1)

    latest = newer
    metadata.mockImplementationOnce(() => { throw new Error('offline') })
    await vi.advanceTimersByTimeAsync(sixHours)
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('offline')))
    expect(onStatus).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(sixHours)
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledTimes(2))
    expect(download.mock.calls.map(([url]) => url)).toEqual([url, url.replace(tag, newer)])
    expect(await updater.check()).toMatchObject({ mechanism: 'light-portable', updateAvailable: true, latestTag: newer })
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ updateAvailable: true, latestTag: newer }))
  })
})
