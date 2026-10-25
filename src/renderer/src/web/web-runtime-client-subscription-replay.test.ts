import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import type { PairedE2EEClientHandshake } from '../../../shared/paired-e2ee-client-handshake'
import { createFixedKeyLegacyHandshakeForTest } from '../../../shared/paired-e2ee-fixed-key-test-fixture'
import { WebRuntimeClient } from './web-runtime-client'

const fakeSockets: FakeWebSocket[] = []

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readyState = FakeWebSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  send = vi.fn()

  constructor(readonly _url: string) {
    fakeSockets.push(this)
  }
}

type ClientInternals = {
  ws: FakeWebSocket | null
  handshake: PairedE2EEClientHandshake | null
  state: string
  subscriptions: Map<string, { needsReplay: boolean; pendingReplayTag: boolean }>
  handleSocketClosed(socket: FakeWebSocket): void
  handleSocketMessage(rawData: unknown, sourceWs?: unknown): Promise<void>
  setState(next: string): void
  subscribeOnCurrentConnection(
    method: string,
    params: unknown,
    callbacks: unknown
  ): Promise<{ unsubscribe: () => void }>
}

function createConnectedClient(): {
  client: WebRuntimeClient
  internals: ClientInternals
  sharedKey: Uint8Array
  initialSocket: FakeWebSocket
} {
  const client = new WebRuntimeClient({
    endpoint: 'ws://127.0.0.1:6768',
    hostPublicKeyB64: Buffer.alloc(32).toString('base64'),
    credential: { kind: 'token', deviceToken: 'token' }
  })
  const initialSocket = fakeSockets[0]!
  initialSocket.readyState = FakeWebSocket.OPEN
  const sharedKey = new Uint8Array(32)
  const internals = client as unknown as ClientInternals
  internals.handshake = createFixedKeyLegacyHandshakeForTest(sharedKey)
  internals.setState('connected')
  return { client, internals, sharedKey, initialSocket }
}

function reconnect(internals: ClientInternals, sharedKey: Uint8Array): FakeWebSocket {
  const replacementSocket = new FakeWebSocket('ws://127.0.0.1:6768')
  replacementSocket.readyState = FakeWebSocket.OPEN
  internals.ws = replacementSocket
  internals.handshake = createFixedKeyLegacyHandshakeForTest(sharedKey)
  internals.setState('connected')
  return replacementSocket
}

describe('WebRuntimeClient retained subscription replay', () => {
  beforeEach(() => {
    fakeSockets.length = 0
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['session.tabs.subscribeAll', 'notifications.subscribe'])(
    'replays retained %s subscriptions and tags the first snapshot',
    async (method) => {
      const { client, internals, sharedKey, initialSocket } = createConnectedClient()
      const onResponse = vi.fn()
      const onClose = vi.fn()
      const onTransportInterrupted = vi.fn()
      const onTransportReplayed = vi.fn()
      const handle = await internals.subscribeOnCurrentConnection(
        method,
        {},
        { onResponse, onClose, onTransportInterrupted, onTransportReplayed }
      )
      const initialId = Array.from(internals.subscriptions.keys())[0]!

      internals.handleSocketClosed(initialSocket)

      expect(onClose).not.toHaveBeenCalled()
      expect(onTransportInterrupted).toHaveBeenCalledOnce()
      expect(internals.subscriptions.get(initialId)?.needsReplay).toBe(true)

      const replacementSocket = reconnect(internals, sharedKey)
      const replacementId = Array.from(internals.subscriptions.keys())[0]!
      expect(replacementId).not.toBe(initialId)
      expect(onTransportReplayed).toHaveBeenCalledOnce()
      expect(internals.subscriptions.get(replacementId)?.pendingReplayTag).toBe(true)

      await internals.handleSocketMessage(
        internals.handshake!.channel.sealText(
          JSON.stringify({
            id: replacementId,
            ok: true,
            streaming: true,
            result: { type: 'snapshots', snapshots: [] },
            _meta: { runtimeId: 'runtime-after-serve-restart' }
          })
        ),
        replacementSocket
      )

      expect(onResponse).toHaveBeenCalledOnce()
      expect(isRuntimeSubscriptionReplayResponse(onResponse.mock.calls[0]?.[0])).toBe(true)
      expect(internals.subscriptions.get(replacementId)?.pendingReplayTag).toBe(false)

      handle.unsubscribe()
      client.close()
    }
  )

  it('closes a retained subscription when replay setup fails', async () => {
    const { client, internals, sharedKey, initialSocket } = createConnectedClient()
    const onResponse = vi.fn()
    const onClose = vi.fn()
    await internals.subscribeOnCurrentConnection(
      'session.tabs.subscribeAll',
      {},
      { onResponse, onClose }
    )
    internals.handleSocketClosed(initialSocket)

    const replacementSocket = reconnect(internals, sharedKey)
    const replacementId = Array.from(internals.subscriptions.keys())[0]!
    await internals.handleSocketMessage(
      internals.handshake!.channel.sealText(
        JSON.stringify({
          id: replacementId,
          ok: false,
          error: { code: 'method_not_found', message: 'subscription unavailable' },
          _meta: { runtimeId: 'runtime-after-serve-restart' }
        })
      ),
      replacementSocket
    )

    expect(onResponse).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    expect(internals.subscriptions.size).toBe(0)
    client.close()
  })
})
