import type WebSocket from 'ws'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { toRemoteRuntimeClientError } from './remote-runtime-shared-control-protocol'

// Why: the socket-level liveness monitor (remote-runtime-socket-liveness.ts,
// #7827) pings at the RFC 6455 control-frame layer, but a WS-terminating
// relay answers those pings itself — so pongs prove only that the relay is
// reachable. When `orca serve` restarts behind such a relay, the client's
// E2EE session and the server's in-memory subscription registry are gone
// while the socket still looks alive, and worktrees created after the
// restart never reach the sidebar until an app reload. This probe sends an
// encrypted RPC on a cadence: only the server holding this connection's
// session keys can answer, so a failed probe proves the session is dead and
// routes into the existing close → reconnect → replay machinery.
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
  // Why: routes through the socket-closed path so probe failure reuses the
  // existing reconnect + subscription-replay machinery.
  forceClose: (error: RemoteRuntimeClientError) => void
}

export class SharedControlSessionProbe {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly hooks: SharedControlSessionProbeHooks) {}

  schedule(): void {
    this.clear()
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
    if (this.hooks.isIntentionallyClosed()) {
      return
    }
    // Why: every path back to ready runs markReady, which restarts probing;
    // rescheduling here would keep an idle timer loop alive on a dead socket.
    if (!this.hooks.isReady()) {
      return
    }
    // Why: only subscriptions need silent-staleness detection; one-shot
    // requests already surface their own failures. Reconnects gate on
    // subscriptions the same way.
    if (!this.hooks.hasSubscriptions()) {
      this.schedule()
      return
    }
    const probedSocket = this.hooks.getSocket()
    try {
      await this.hooks.probe(this.hooks.timeoutMs)
      // Why: same stale-socket guard as the failure branch — a reconnect that
      // replaced the socket mid-probe owns the probe schedule for it.
      if (this.hooks.getSocket() === probedSocket) {
        this.schedule()
      }
    } catch (error) {
      // Why: if the socket already changed, a reconnect handled recovery and
      // scheduled its own probe; force-closing here would kill the new socket.
      if (this.hooks.getSocket() === probedSocket && !this.hooks.isIntentionallyClosed()) {
        this.hooks.forceClose(toRemoteRuntimeClientError(error))
      }
    }
  }
}
