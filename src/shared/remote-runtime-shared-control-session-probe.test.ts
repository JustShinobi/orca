import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import {
  createSharedControlSessionProbe,
  SharedControlSessionProbe
} from './remote-runtime-shared-control-session-probe'

type ProbeState = {
  intentionallyClosed: boolean
  hasSubscriptions: boolean
  ready: boolean
  socket: WebSocket | null
}

afterEach(() => {
  vi.useRealTimers()
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
