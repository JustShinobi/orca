import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { REMOTE_RUNTIME_MAX_PENDING_REQUESTS } from '../../remote-runtime-memory-limits'
import { getRemoteRuntimeRequestAdmissionEvidence } from '../requests/remote-runtime-prepared-request-admission'
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import {
  createSharedControlSessionProbe,
  SharedControlSessionProbe
} from './remote-runtime-shared-control-session-probe'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer as createServer
} from './remote-runtime-shared-control-test-server'

type ProbeState = {
  intentionallyClosed: boolean
  hasSubscriptions: boolean
  ready: boolean
  socket: WebSocket | null
}

afterEach(async () => {
  vi.useRealTimers()
  await closeSharedControlTestServers()
})

describe('SharedControlSessionProbe', () => {
  it('rejects non-positive or non-finite probe timing overrides', () => {
    const hooks = {
      isIntentionallyClosed: () => false,
      hasSubscriptions: () => false,
      isReady: () => false,
      getSocket: () => null,
      probe: () => Promise.resolve(),
      forceClose: () => {}
    }
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createSharedControlSessionProbe({ sessionProbeIntervalMs: value }, hooks)
      ).toThrow(RangeError)
      expect(() =>
        createSharedControlSessionProbe({ sessionProbeTimeoutMs: value }, hooks)
      ).toThrow(RangeError)
    }
  })

  it('does not retain a timer without an active subscription', () => {
    vi.useFakeTimers()
    const { probe, run } = createProbe()

    probe.schedule()

    expect(vi.getTimerCount()).toBe(0)
    expect(run).not.toHaveBeenCalled()
  })

  it('probes while ready and subscribed', async () => {
    vi.useFakeTimers()
    const { probe, run, state } = createProbe()
    state.hasSubscriptions = true

    probe.schedule()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(100)

    expect(run).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('keeps a hard probe cadence through continuous lifecycle reconciliation', async () => {
    vi.useFakeTimers()
    const { probe, run, state } = createProbe()
    state.hasSubscriptions = true

    probe.schedule()
    for (let elapsed = 90; elapsed <= 990; elapsed += 90) {
      await vi.advanceTimersByTimeAsync(90)
      probe.schedule()
    }

    expect(run).toHaveBeenCalledTimes(9)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('does not re-arm after the last subscription closes during a probe', async () => {
    vi.useFakeTimers()
    let resolveProbe: () => void = () => undefined
    const pendingProbe = new Promise<void>((resolve) => {
      resolveProbe = resolve
    })
    const { probe, run, state } = createProbe(() => pendingProbe)
    state.hasSubscriptions = true

    probe.schedule()
    await vi.advanceTimersByTimeAsync(100)
    state.hasSubscriptions = false
    probe.clear()
    resolveProbe()
    await pendingProbe
    await Promise.resolve()

    expect(run).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not recover an idle connection when its final probe fails', async () => {
    vi.useFakeTimers()
    let rejectProbe: (error: Error) => void = () => undefined
    const pendingProbe = new Promise<void>((_resolve, reject) => {
      rejectProbe = reject
    })
    const { forceClose, probe, state } = createProbe(() => pendingProbe)
    state.hasSubscriptions = true

    probe.schedule()
    await vi.advanceTimersByTimeAsync(100)
    state.hasSubscriptions = false
    probe.clear()
    rejectProbe(new Error('session lost'))
    await Promise.resolve()
    await Promise.resolve()

    expect(forceClose).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('detects a dead E2EE session via the session probe when the relay still answers pings', async () => {
    // Why: relay pongs survive after the server-side encrypted session disappears.
    const server = await createServer({
      goSilentOnFirstConnectionAfterFirstStreamingResponse: true
    })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      sessionProbeIntervalMs: 40,
      sessionProbeTimeoutMs: 80
    })
    const onClose = vi.fn()

    try {
      await connection.subscribe('runtime.clientEvents.subscribe', null, 1000, {
        onResponse: vi.fn(),
        onError: vi.fn(),
        onClose
      })

      await vi.waitFor(() => expect(server.connectionCount()).toBe(2), { timeout: 5000 })
      await vi.waitFor(
        () =>
          expect(
            server.requests.filter((request) => request.method === 'runtime.clientEvents.subscribe')
          ).toHaveLength(2),
        { timeout: 5000 }
      )
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      connection.close()
    }
  })

  it('reschedules a locally admission-blocked probe without closing a healthy socket', async () => {
    const server = await createServer({ silentMethods: ['worktree.hang'] })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      sessionProbeIntervalMs: 60_000,
      sessionProbeTimeoutMs: 1000
    })
    const onClose = vi.fn()
    const onError = vi.fn()
    await connection.subscribe('runtime.clientEvents.subscribe', null, 1000, {
      onResponse: vi.fn(),
      onError,
      onClose
    })
    const pending = Array.from({ length: REMOTE_RUNTIME_MAX_PENDING_REQUESTS }, () =>
      connection.request('worktree.hang', undefined, 60_000).catch(() => undefined)
    )
    try {
      await vi.waitFor(
        () =>
          expect(
            server.requests.filter((request) => request.method === 'worktree.hang')
          ).toHaveLength(REMOTE_RUNTIME_MAX_PENDING_REQUESTS),
        { timeout: 5000 }
      )
      const unsafe = connection as unknown as {
        sessionProbe: {
          runProbe: () => Promise<void>
          timer: ReturnType<typeof setTimeout> | null
        }
      }

      await unsafe.sessionProbe.runProbe()

      expect(server.requests.map((request) => request.method)).not.toContain('status.get')
      expect(unsafe.sessionProbe.timer).not.toBeNull()
      expect(server.connectionCount()).toBe(1)
      expect(connection.getDiagnostics()).toMatchObject({
        state: 'ready',
        pendingRequestCount: REMOTE_RUNTIME_MAX_PENDING_REQUESTS,
        subscriptionCount: 1
      })
      expect(onError).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      connection.close()
      await Promise.all(pending)
    }
  })

  it('clears the session probe when the server ends the final subscription', async () => {
    const server = await createServer({ endStreamingResponseAfterReady: true })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      sessionProbeIntervalMs: 15_000
    })
    const onResponse = vi.fn()

    try {
      await connection.subscribe('runtime.clientEvents.subscribe', null, 1000, {
        onResponse,
        onError: vi.fn()
      })
      await vi.waitFor(() => expect(onResponse).toHaveBeenCalledTimes(2))
      const unsafe = connection as unknown as {
        sessionProbe: { timer: ReturnType<typeof setTimeout> | null }
      }

      expect(connection.getDiagnostics().subscriptionCount).toBe(0)
      expect(unsafe.sessionProbe.timer).toBeNull()
      expect(server.requests.map((request) => request.method)).not.toContain('status.get')
    } finally {
      connection.close()
    }
  })

  it('retires an in-flight probe when the server ends the final subscription', async () => {
    const server = await createServer({ silentMethods: ['status.get'] })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      sessionProbeIntervalMs: 20,
      sessionProbeTimeoutMs: 10_000
    })
    const onClose = vi.fn()
    const onResponse = vi.fn()

    try {
      await connection.subscribe('runtime.clientEvents.subscribe', null, 1000, {
        onResponse,
        onError: vi.fn(),
        onClose
      })
      await vi.waitFor(() =>
        expect(server.requests.map((request) => request.method)).toContain('status.get')
      )
      expect(connection.getDiagnostics()).toMatchObject({
        state: 'ready',
        pendingRequestCount: 1,
        subscriptionCount: 1
      })
      expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(1)
      const probeRequestId = server.requests.find((request) => request.method === 'status.get')!.id

      server.endActiveSubscriptions()

      await vi.waitFor(() => expect(onResponse).toHaveBeenCalledTimes(2))
      const unsafe = connection as unknown as {
        retiredRequestIds: { has: (requestId: string) => boolean }
        sessionProbe: {
          probeAbortController: AbortController | null
          timer: ReturnType<typeof setTimeout> | null
        }
      }
      expect(connection.getDiagnostics()).toMatchObject({
        state: 'ready',
        pendingRequestCount: 0,
        subscriptionCount: 0
      })
      expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
        pendingRequestCount: 0,
        retainedBytes: 0
      })
      expect(unsafe.sessionProbe.probeAbortController).toBeNull()
      expect(unsafe.sessionProbe.timer).toBeNull()
      expect(unsafe.retiredRequestIds.has(probeRequestId)).toBe(true)
      expect(server.connectionCount()).toBe(1)
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      connection.close()
    }
  })

  it('recovers when a session probe resolves with a failure response', async () => {
    const server = await createServer({ failMethods: ['status.get'] })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      sessionProbeIntervalMs: 40,
      sessionProbeTimeoutMs: 500
    })

    try {
      await connection.subscribe('runtime.clientEvents.subscribe', null, 1000, {
        onResponse: vi.fn(),
        onError: vi.fn()
      })

      // Why: an ok:false status.get must count as lost session authority and
      // force a replacement connection, not a quiet reschedule.
      await vi.waitFor(() => expect(server.connectionCount()).toBe(2), { timeout: 5000 })
    } finally {
      connection.close()
    }
  })

  it('keeps a responsive connection on one socket while session probes succeed', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      sessionProbeIntervalMs: 20,
      sessionProbeTimeoutMs: 500
    })

    try {
      await connection.subscribe('runtime.clientEvents.subscribe', null, 1000, {
        onResponse: vi.fn(),
        onError: vi.fn()
      })

      await vi.waitFor(() =>
        expect(server.requests.map((request) => request.method)).toContain('status.get')
      )
      expect(server.connectionCount()).toBe(1)
    } finally {
      connection.close()
    }
  })

  it('does not run session probes when no subscriptions are active', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      sessionProbeIntervalMs: 10,
      sessionProbeTimeoutMs: 50
    })

    try {
      await connection.request('worktree.ps', undefined, 1000)
      await new Promise((resolve) => setTimeout(resolve, 60))

      expect(server.requests.map((request) => request.method)).not.toContain('status.get')
    } finally {
      connection.close()
    }
  })
})

function createProbe(runProbe: () => Promise<unknown> = async () => undefined): {
  probe: SharedControlSessionProbe
  run: ReturnType<typeof vi.fn<() => Promise<unknown>>>
  forceClose: ReturnType<typeof vi.fn>
  state: ProbeState
} {
  const state: ProbeState = {
    intentionallyClosed: false,
    hasSubscriptions: false,
    ready: true,
    socket: {} as WebSocket
  }
  const run = vi.fn(runProbe)
  const forceClose = vi.fn()
  const probe = new SharedControlSessionProbe({
    intervalMs: 100,
    timeoutMs: 50,
    isIntentionallyClosed: () => state.intentionallyClosed,
    hasSubscriptions: () => state.hasSubscriptions,
    isReady: () => state.ready,
    getSocket: () => state.socket,
    probe: run,
    forceClose
  })
  return { forceClose, probe, run, state }
}
