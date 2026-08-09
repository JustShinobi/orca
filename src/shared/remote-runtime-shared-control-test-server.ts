import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './e2ee-crypto'
import { encodePairingOffer, parsePairingCode, type PairingOffer } from './pairing'

export type SharedControlTestServer = {
  pairing: PairingOffer
  requests: { id: string; method: string; params?: unknown }[]
  auths: unknown[]
  connectionCount: () => number
  endActiveSubscriptions: () => void
  flushDelayedResponses: () => void
}

export type SharedControlTestServerOptions = {
  delaySubscriptionReady?: boolean
  sendKeepaliveBeforeResponse?: boolean
  keepaliveDelayMs?: number
  responseDelayMs?: number
  sendBinaryAfterAuth?: boolean
  sendUnknownResponseBeforeResponse?: boolean
  closeAfterFirstStreamingResponse?: boolean
  closeBeforeResponse?: boolean
  suppressReadyFrame?: boolean
  suppressReadyFrameCount?: number
  disableAutoPong?: boolean
  delayedMethods?: string[]
  silentMethods?: string[]
  failMethods?: string[]
  goSilentOnFirstConnectionAfterFirstStreamingResponse?: boolean
  endStreamingResponseAfterReady?: boolean
}

const servers: WebSocketServer[] = []

export async function closeSharedControlTestServers(): Promise<void> {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) {
            client.close()
          }
          server.close(() => resolve())
        })
    )
  )
}

export async function createSharedControlTestServer(
  options: SharedControlTestServerOptions = {}
): Promise<SharedControlTestServer> {
  const serverKeyPair = generateKeyPair()
  const requests: SharedControlTestServer['requests'] = []
  const auths: unknown[] = []
  const delayedResponses: (() => void)[] = []
  const subscriptionEnds: (() => void)[] = []
  let connectionCount = 0
  let closedAfterFirstStreamingResponse = false
  // Why: bind loopback-specific, not wildcard — on macOS another process binding
  // 127.0.0.1 on the same ephemeral port would shadow a wildcard listener and
  // hijack the tests' connections (observed with a running Orca app's browser bridge).
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    autoPong: options.disableAutoPong !== true
  })
  servers.push(wss)

  wss.on('connection', (ws) => {
    connectionCount += 1
    // Why: captured per connection — the outer count keeps moving, so reading it
    // at hello time would mis-suppress a first socket that raced a second connect.
    const connectionIndex = connectionCount
    const isFirstConnection = connectionIndex === 1
    let goneSilent = false
    let sharedKey: Uint8Array | null = null
    let authenticated = false
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        return
      }
      const frame = data.toString()
      if (!sharedKey) {
        const hello = JSON.parse(frame) as { publicKeyB64: string }
        sharedKey = deriveSharedKey(
          serverKeyPair.secretKey,
          publicKeyFromBase64(hello.publicKeyB64)
        )
        if (
          options.suppressReadyFrame ||
          connectionIndex <= (options.suppressReadyFrameCount ?? 0)
        ) {
          return
        }
        ws.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }
      const plaintext = decrypt(frame, sharedKey)
      if (!plaintext) {
        return
      }
      if (!authenticated) {
        auths.push(JSON.parse(plaintext))
        authenticated = true
        sendEncrypted(ws, sharedKey, { type: 'e2ee_authenticated' })
        if (options.sendBinaryAfterAuth) {
          ws.send(Buffer.from([1, 2, 3]), { binary: true })
        }
        return
      }
      const request = JSON.parse(plaintext) as { id: string; method: string; params?: unknown }
      if (goneSilent) {
        requests.push(request)
        return
      }
      if (
        options.goSilentOnFirstConnectionAfterFirstStreamingResponse &&
        isFirstConnection &&
        isStreamingMethod(request.method)
      ) {
        goneSilent = true
      }
      handleRequest(
        ws,
        sharedKey,
        requests,
        request,
        {
          ...options,
          closeAfterStreamingResponse: () => {
            if (!options.closeAfterFirstStreamingResponse || closedAfterFirstStreamingResponse) {
              return false
            }
            closedAfterFirstStreamingResponse = true
            return true
          }
        },
        delayedResponses,
        subscriptionEnds
      )
    })
  })

  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address() as AddressInfo
  const pairing = parsePairingCode(
    encodePairingOffer({
      v: 2,
      endpoint: `ws://127.0.0.1:${address.port}`,
      deviceToken: 'device-token',
      publicKeyB64: publicKeyToBase64(serverKeyPair.publicKey)
    })
  )
  if (!pairing) {
    throw new Error('Failed to create test pairing')
  }
  return {
    pairing,
    requests,
    auths,
    connectionCount: () => connectionCount,
    endActiveSubscriptions: () => subscriptionEnds.splice(0).forEach((send) => send()),
    flushDelayedResponses: () => delayedResponses.splice(0).forEach((send) => send())
  }
}

function handleRequest(
  ws: WebSocket,
  sharedKey: Uint8Array,
  requests: SharedControlTestServer['requests'],
  request: { id: string; method: string; params?: unknown },
  options: SharedControlTestServerOptions & { closeAfterStreamingResponse: () => boolean },
  delayedResponses: (() => void)[],
  subscriptionEnds: (() => void)[]
): void {
  requests.push(request)
  if (options.sendKeepaliveBeforeResponse && options.keepaliveDelayMs !== undefined) {
    const timer = setInterval(
      () => sendEncrypted(ws, sharedKey, { _keepalive: true }),
      options.keepaliveDelayMs
    )
    ws.once('close', () => clearInterval(timer))
  }
  if (options.silentMethods?.includes(request.method)) {
    return
  }
  if (options.failMethods?.includes(request.method)) {
    sendEncrypted(ws, sharedKey, {
      id: request.id,
      ok: false,
      error: { code: 'session_authority_lost', message: 'test failure response' },
      _meta: { runtimeId: 'runtime-test' }
    })
    return
  }
  if (options.closeBeforeResponse) {
    ws.close(4001, 'test close')
    return
  }
  const streaming = isStreamingMethod(request.method)
  const result = streaming
    ? { type: 'ready', subscriptionId: `${request.method}:subscription` }
    : { method: request.method }
  const sendResponse = (): void => {
    if (options.sendUnknownResponseBeforeResponse) {
      sendEncrypted(ws, sharedKey, {
        id: 'unknown-response-id',
        ok: true,
        result: { method: 'unknown' },
        _meta: { runtimeId: 'runtime-test' }
      })
    }
    sendEncrypted(ws, sharedKey, {
      id: request.id,
      ok: true,
      result,
      streaming: streaming ? true : undefined,
      _meta: { runtimeId: 'runtime-test' }
    })
    const sendEnd = (): void => {
      sendEncrypted(ws, sharedKey, {
        id: request.id,
        ok: true,
        result: { type: 'end' },
        streaming: true,
        _meta: { runtimeId: 'runtime-test' }
      })
    }
    if (streaming && options.endStreamingResponseAfterReady) {
      sendEnd()
    } else if (streaming) {
      subscriptionEnds.push(sendEnd)
    }
    // Why: consume the one-shot close flag only when a streaming response is
    // actually sent, so delayed/flushed responses still observe the close.
    if (streaming && options.closeAfterStreamingResponse()) {
      setTimeout(() => ws.close(), 0)
    }
  }
  if (options.sendKeepaliveBeforeResponse && options.keepaliveDelayMs === undefined) {
    sendEncrypted(ws, sharedKey, { _keepalive: true })
  }
  if (options.delaySubscriptionReady && streaming) {
    delayedResponses.push(sendResponse)
    return
  }
  if (options.delayedMethods?.includes(request.method)) {
    delayedResponses.push(sendResponse)
    return
  }
  if (options.responseDelayMs !== undefined) {
    setTimeout(sendResponse, options.responseDelayMs)
    return
  }
  sendResponse()
}

function isStreamingMethod(method: string): boolean {
  return (
    method.endsWith('.subscribe') ||
    method === 'session.tabs.subscribeAll' ||
    method === 'files.watch'
  )
}

function sendEncrypted(ws: WebSocket, sharedKey: Uint8Array, message: unknown): void {
  ws.send(encrypt(JSON.stringify(message), sharedKey))
}
