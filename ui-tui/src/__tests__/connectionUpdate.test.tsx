import { PassThrough } from 'node:stream'

import { renderSync } from '@hermes/ink'
import type { ConnectionOperationTarget } from '@hermes/shared/gateway-events'
import { stripAnsi } from '@hermes/shared/ansi'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ input: null as null | ((text: string, key: object) => void), request: vi.fn() }))

vi.mock('@hermes/ink', async importOriginal => {
  const ink = await importOriginal<typeof import('@hermes/ink')>()

  return {
    ...ink,
    useInput: (input: (text: string, key: object) => void) => { harness.input = input }
  }
})
vi.mock('../app/gatewayContext.js', () => ({ useGateway: () => ({ gw: { request: harness.request } }) }))

import { applyConnectionRequest, resetConnectionOperationsForTests } from '../app/connectionOperationStore.js'
import { patchUiState } from '../app/uiStore.js'
import { ConnectionSetupOverlay } from '../components/connectionSetupOverlay.js'
import { DEFAULT_THEME } from '../theme.js'

const instances: ReturnType<typeof renderSync>[] = []

function show(state: ConnectionOperationTarget['state']): string {
  patchUiState({ sid: 'update-session' })
  applyConnectionRequest({
    deadline_at: 1_800_000_000,
    op_id: 'update-op',
    seq: 1,
    targets: [{ action: 'update', instructions: 'command: [redacted]', kind: 'mcp', name: 'ghidra', state }],
    timeout_seconds: 120,
    tool_call_id: 'update-call'
  })
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const stderr = new PassThrough()
  let output = ''
  Object.assign(stdout, { columns: 100, isTTY: false, rows: 40 })
  Object.assign(stdin, { isTTY: false })
  Object.assign(stderr, { isTTY: false })
  stdout.on('data', chunk => { output += chunk.toString() })
  instances.push(renderSync(React.createElement(ConnectionSetupOverlay, { cols: 100, t: DEFAULT_THEME }), {
    patchConsole: false,
    stderr: stderr as NodeJS.WriteStream,
    stdin: stdin as NodeJS.ReadStream,
    stdout: stdout as NodeJS.WriteStream
  }))
  return stripAnsi(output)
}

afterEach(() => {
  for (const instance of instances.splice(0)) { instance.unmount(); instance.cleanup() }
  resetConnectionOperationsForTests()
  patchUiState({ sid: null })
  harness.input = null
  harness.request.mockReset()
})

describe('MCP update overlay', () => {
  it('shows the update summary and waits for normal approval without sending credentials', async () => {
    harness.request.mockResolvedValue({ status: 'ok', settled: false })
    const output = show('pending')
    expect(output).toContain('Update ghidra')
    expect(output).toContain('command: [redacted]')
    expect(output).toContain('Skip')
    expect(harness.request).not.toHaveBeenCalled()
    harness.input?.('', { return: true })
    await vi.waitFor(() => expect(harness.request).toHaveBeenCalledWith('connection.respond', {
      op_id: 'update-op',
      owner: { session_id: 'update-session', type: 'session' },
      result: { targets: [{ name: 'ghidra', status: 'approved' }] }
    }))
  })

  it('skips a pending update through the normal response', async () => {
    harness.request.mockResolvedValue({ status: 'ok', settled: false })
    show('pending')
    harness.input?.('', { escape: true })
    await vi.waitFor(() => expect(harness.request).toHaveBeenCalledWith('connection.respond', {
      op_id: 'update-op',
      owner: { session_id: 'update-session', type: 'session' },
      result: { targets: [{ name: 'ghidra', status: 'skipped' }] }
    }))
  })

  it('retries a failed update and leaves an updated row without retry or skip', async () => {
    harness.request.mockResolvedValue({ targets: [] })
    expect(show('failed')).toContain('Try again')
    harness.input?.('', { return: true })
    await vi.waitFor(() => expect(harness.request).toHaveBeenCalledWith('connectors.connect', {
      connectors: ['ghidra'], owner: { session_id: 'update-session', type: 'session' }, reconnect: true
    }))
    for (const instance of instances.splice(0)) { instance.unmount(); instance.cleanup() }
    resetConnectionOperationsForTests()
    harness.request.mockClear()
    const output = show('updated')
    expect(output).not.toContain('Try again')
    expect(output).not.toContain('Skip')
    harness.input?.('', { return: true })
    harness.input?.('', { escape: true })
    expect(harness.request).not.toHaveBeenCalled()
  })
})
