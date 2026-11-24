import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  composerImageBufferFromIpc,
  composerPasteTextFromIpc
} from './hardening'

const codeOf = (code: string) => (error: unknown) => (error as { code?: string })?.code === code

test('composerImageBufferFromIpc accepts the byte shapes the renderer sends', () => {
  const bytes = Uint8Array.from([137, 80, 78, 71])

  assert.deepEqual([...composerImageBufferFromIpc(bytes)], [137, 80, 78, 71])
  assert.deepEqual([...composerImageBufferFromIpc(Buffer.from(bytes))], [137, 80, 78, 71])
  assert.deepEqual([...composerImageBufferFromIpc(bytes.buffer)], [137, 80, 78, 71])
})

test('composerImageBufferFromIpc rejects missing, empty and non-byte payloads', () => {
  for (const data of [undefined, null, new Uint8Array(0), 'not bytes', { length: 1e12 }]) {
    assert.throws(() => composerImageBufferFromIpc(data), codeOf('invalid-image-data'))
  }
})

test('composerPasteTextFromIpc accepts non-empty text and rejects invalid payloads', () => {
  assert.equal(composerPasteTextFromIpc('hello'), 'hello')
  assert.throws(() => composerPasteTextFromIpc(''), codeOf('invalid-text'))
  assert.throws(() => composerPasteTextFromIpc(42), codeOf('invalid-text'))
})
