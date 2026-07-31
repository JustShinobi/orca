import type WebSocket from 'ws'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { toRemoteRuntimeClientError } from './remote-runtime-shared-control-protocol'
import type { RemoteRuntimeSharedControlConnectionOptions } from './remote-runtime-shared-control-types'

// Why: relay pongs cannot prove the server still owns the encrypted session and its subscriptions.
export const SHARED_CONTROL_SESSION_PROBE_INTERVAL_MS = 15_000
export const SHARED_CONTROL_SESSION_PROBE_TIMEOUT_MS = 10_000

export type SharedControlSessionProbeHooks = {
  intervalMs: number
  timeoutMs: number
  isIntentionallyClosed: () => boolean
  hasSubscriptions: () => boolean
  isReady: () => boolean
  getSocket: () => WebSocket | null
  probe: (timeoutMs: number) => Promise<unknown>
  // Why: the socket-closed path already owns reconnect and subscription replay.
  forceClose: (error: RemoteRuntimeClientError) => void
}

export class SharedControlSessionProbe {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly hooks: SharedControlSessionProbeHooks) {}

  schedule(): void {
    this.clear()
    if (
      this.hooks.isIntentionallyClosed() ||
      !this.hooks.hasSubscriptions() ||
      !this.hooks.isReady()
    ) {
      return
    }
    const timer = setTimeout(() => {
      this.timer = null
      void this.runProbe()
    }, this.hooks.intervalMs)
    // Why: mobile typechecks shared code with DOM timer types where unref is absent.
    const unrefable = timer as unknown as { unref?: () => void }
    if (typeof unrefable.unref === 'function') {
      unrefable.unref()
    }
    this.timer = timer
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async runProbe(): Promise<void> {
    if (
      this.hooks.isIntentionallyClosed() ||
      !this.hooks.hasSubscriptions() ||
      !this.hooks.isReady()
    ) {
      return
    }
    const probedSocket = this.hooks.getSocket()
    try {
      await this.hooks.probe(this.hooks.timeoutMs)
      // Why: a replacement socket owns its own probe schedule.
      if (this.hooks.getSocket() === probedSocket) {
        this.schedule()
      }
    } catch (error) {
      // Why: force-closing a replacement socket would kill a recovered session.
      if (
        this.hooks.getSocket() === probedSocket &&
        this.hooks.hasSubscriptions() &&
        !this.hooks.isIntentionallyClosed()
      ) {
        this.hooks.forceClose(toRemoteRuntimeClientError(error))
      }
    }
  }
}

export function createSharedControlSessionProbe(
  options: RemoteRuntimeSharedControlConnectionOptions,
  hooks: Omit<SharedControlSessionProbeHooks, 'intervalMs' | 'timeoutMs'>
): SharedControlSessionProbe {
  return new SharedControlSessionProbe({
    ...hooks,
    intervalMs: options.sessionProbeIntervalMs ?? SHARED_CONTROL_SESSION_PROBE_INTERVAL_MS,
    timeoutMs: options.sessionProbeTimeoutMs ?? SHARED_CONTROL_SESSION_PROBE_TIMEOUT_MS
  })
}
