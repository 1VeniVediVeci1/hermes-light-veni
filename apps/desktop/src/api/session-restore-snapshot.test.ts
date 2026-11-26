// @vitest-environment node
import { expect, it } from 'vitest'

import { HermesGateway } from './client'
import { RESTORE_SNAPSHOT } from './session-restore-snapshot'

it.each([true, false])('recent restore is scoped to the owner and socket (canonical: %s)', async canonical => {
  const wsPackage = 'ws'
  const { WebSocketServer } = await import(wsPackage)
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const sends: Array<{ method: string; params: Record<string, unknown> }> = []
  server.on('connection', (socket: any) => {
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: {
      type: 'gateway.ready', payload: { session_authority: canonical }
    } }))
    socket.on('message', (bytes: Buffer) => {
      const request = JSON.parse(bytes.toString())
      const { id, method, params } = request
      sends.push({ method, params })

      const response = method === 'session.control.read'
        ? { error: { code: 4001, message: 'session not found' } }
        : { result: {
            session_id: canonical ? params.session_id : 'runtime',
            info: { profile_name: params.profile },
            revision: 1,
            execution_generation: 1,
            messages: []
          } }

      socket.send(JSON.stringify({ jsonrpc: '2.0', id, ...response }))
    })
  })
  const gateway = new HermesGateway()
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/ws`
  const params = { [RESTORE_SNAPSHOT]: true, cols: 96, omit_messages: true, profile: 'alpha', session_id: 'saved' }
  const resumes = () => sends.filter(send => send.method === 'session.resume')

  try {
    await gateway.connect(url)
    const attached = await gateway.request('session.resume', params)
    // A later route activation is not an in-flight join. It names the runtime
    // id, which differs from the stored id on a legacy gateway.
    await expect(gateway.request('session.activate', { ...params, session_id: canonical ? 'saved' : 'runtime' }))
      .resolves.toEqual(attached)
    expect(sends.filter(send => ['session.resume', 'session.activate'].includes(send.method))).toEqual([
      { method: 'session.resume', params: expect.objectContaining({ omit_messages: true, profile: 'alpha', session_id: 'saved' }) }
    ])

    await gateway.request('session.resume', { ...params, profile: 'beta' })
    await gateway.request('session.resume', params)
    expect(resumes().map(send => send.params.profile)).toEqual(['alpha', 'beta'])

    await expect(gateway.request('session.control.read', { session_id: 'saved', profile: 'alpha' })).rejects.toThrow()
    await gateway.request('session.resume', params)
    expect(resumes()).toHaveLength(3)

    await gateway.request('session.resume', { ...params, omit_messages: false })
    expect(resumes()).toHaveLength(4)
    expect(resumes().at(-1)?.params.omit_messages).toBe(false)
    await gateway.request('session.resume', params)

    const closed = new Promise<void>(resolve => {
      gateway.onState(state => { if (state === 'closed') { resolve() } })
    })

    for (const socket of server.clients) { socket.terminate() }
    await closed

    await gateway.connect(url)
    await gateway.request('session.resume', params)
    expect(resumes()).toHaveLength(6)
  } finally {
    gateway.close()

    for (const socket of server.clients) { socket.terminate() }
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
