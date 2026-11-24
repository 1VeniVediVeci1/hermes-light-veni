import { describe, expect, it, vi } from 'vitest'
import { selectLightRelease } from './light-self-update'

vi.mock('electron', () => ({}))

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
