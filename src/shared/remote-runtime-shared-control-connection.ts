import type WebSocket from 'ws'
import type { PairingOffer } from './pairing'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { reconnectSharedControlNow } from './remote-runtime-shared-control-manual-reconnect'
import {
  openSharedControlTransport,
  handleIncomingSharedControlFrame,
  handleSharedControlSocketClosed,
  sendSharedControlOutgoingRequest,
  sendSharedControlActiveSubscription,
  replaySharedControlActiveSubscriptions,
  closeActiveSharedControlSubscription,
  createSharedControlSessionProbeInstance,
  teardownSharedControlSocket
} from './remote-runtime-shared-control-transport-lifecycle'
import * as sharedControlProtocol from './remote-runtime-shared-control-protocol'
import * as sharedControlReady from './remote-runtime-shared-control-ready'
import { isSharedControlSocketGone } from './remote-runtime-shared-control-ready'
import { SharedControlReconnectScheduler } from './remote-runtime-shared-control-reconnect'
import { requestSharedControl } from './remote-runtime-shared-control-requests'
import type { SharedControlSessionProbe } from './remote-runtime-shared-control-session-probe'
import { SharedControlRetiredRequestIds } from './remote-runtime-shared-control-retired-request-ids'
import { SharedControlReadyStableResetTimer } from './remote-runtime-shared-control-stability'
import * as sharedControlState from './remote-runtime-shared-control-state'
import { startSharedControlSubscription } from './remote-runtime-shared-control-subscription-start'
import { SharedControlSocketGeneration } from './remote-runtime-shared-control-socket-generation'
import type * as SharedControlTypes from './remote-runtime-shared-control-types'

type PendingRequest = SharedControlTypes.SharedControlPendingRequest<unknown>
type LogicalSubscription = SharedControlTypes.SharedControlLogicalSubscription<unknown>

export class RemoteRuntimeSharedControlConnection {
  private state: SharedControlTypes.SharedControlConnectionState = 'closed'
  private ws: WebSocket | null = null
  private sharedKey: Uint8Array | null = null
  private socketCleanup: (() => void) | null = null
  private readonly reconnect = new SharedControlReconnectScheduler()
  private readonly readyStableReset: SharedControlReadyStableResetTimer
  private readonly sessionProbe: SharedControlSessionProbe
  private intentionallyClosed = false
  private lastConnectedAt: number | null = null
  private lastClose: { code: number; reason: string } | null = null
  private lastError: string | null = null
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly subscriptions = new Map<string, LogicalSubscription>()
  private readonly retiredRequestIds = new SharedControlRetiredRequestIds()
  private readonly readyWaiters: SharedControlTypes.SharedControlReadyWaiter[] = []
  private everReady = false
  private readonly socketGeneration = new SharedControlSocketGeneration()

  constructor(
    private readonly pairing: PairingOffer,
    private readonly options: SharedControlTypes.RemoteRuntimeSharedControlConnectionOptions = {}
  ) {
    this.readyStableReset = new SharedControlReadyStableResetTimer(
      options.reconnectStableResetMs ?? 30_000
    )
    this.sessionProbe = createSharedControlSessionProbeInstance({
      options,
      isIntentionallyClosed: () => this.intentionallyClosed,
      hasSubscriptions: () => this.subscriptions.size > 0,
      isReady: () => this.isReady(),
      getSocket: () => this.ws,
      requestStatus: (timeoutMs, signal) =>
        this.request('status.get', undefined, timeoutMs, undefined, signal),
      forceClose: (error) =>
        this.handleSocketClosed(error, this.socketGeneration.currentGeneration())
    })
  }

  request<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
    envelope?: Parameters<typeof requestSharedControl>[0]['envelope'],
    signal?: AbortSignal
  ): ReturnType<typeof requestSharedControl<TResult>> {
    return requestSharedControl<TResult>({
      pendingRequests: this.pendingRequests,
      deviceToken: this.pairing.deviceToken,
      method,
      params,
      timeoutMs,
      envelope,
      ensureReady: () => this.ensureReadyWithTimeout(timeoutMs, signal),
      send: (requestId) => this.sendRequest(requestId),
      retireRequestId: (requestId) => this.retiredRequestIds.retire(requestId),
      signal
    })
  }

  async subscribe<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
    callbacks: SharedControlTypes.SharedControlSubscriptionCallbacks<TResult>
  ): Promise<SharedControlTypes.RemoteRuntimeSharedSubscription> {
    return startSharedControlSubscription({
      subscriptions: this.subscriptions,
      deviceToken: this.pairing.deviceToken,
      method,
      params,
      callbacks,
      ensureReady: () => this.ensureReadyWithTimeout(timeoutMs),
      sendSubscription: (subscription) => this.sendSubscription(subscription),
      closeSubscription: (requestId) => this.closeSubscription(requestId)
    })
  }

  close(error?: Error): void {
    this.intentionallyClosed = true
    this.socketGeneration.invalidate()
    this.reconnect.clear()
    Array.from(this.subscriptions.values()).forEach((s) => {
      this.closeSubscription(s.requestId)
    })
    this.closeSocket(error)
  }

  readonly retryNow = (): boolean => this.reconnect.retryNow()

  getDiagnostics(): SharedControlTypes.RemoteRuntimeSharedConnectionDiagnostics {
    return sharedControlState.buildSharedControlDiagnostics({
      state: this.state,
      reconnecting: this.reconnect.isScheduled,
      pendingRequestCount: this.pendingRequests.size,
      subscriptionCount: this.subscriptions.size,
      reconnectAttempt: this.reconnect.attemptCount,
      lastConnectedAt: this.lastConnectedAt,
      lastClose: this.lastClose,
      lastError: this.lastError
    })
  }

  reconnectNow(): void {
    reconnectSharedControlNow(
      !this.intentionallyClosed && !this.isReady(),
      (error) => this.closeSocket(error, true),
      () => this.open()
    )
  }

  private ensureReadyWithTimeout(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.isReady()) {
      return Promise.resolve()
    }
    return sharedControlReady.waitForSharedControlReadyWithTimeout({
      readyWaiters: this.readyWaiters,
      timeoutMs,
      signal,
      open: () => {
        if (isSharedControlSocketGone(this.ws)) {
          this.open()
        }
      }
    })
  }

  private isReady(): boolean {
    return sharedControlReady.isSharedControlReady({
      state: this.state,
      ws: this.ws,
      sharedKey: this.sharedKey
    })
  }

  private open(): void {
    if (this.intentionallyClosed) {
      sharedControlState.rejectSharedControlReadyWaiters(this.readyWaiters)
      return
    }
    this.reconnect.clear()
    const { socketGeneration, result } = openSharedControlTransport({
      pairing: this.pairing,
      options: this.options,
      socketGeneration: this.socketGeneration,
      getCurrentSocket: () => this.ws,
      onClose: (close, gen, error) => {
        if (this.socketGeneration.isCurrent(gen)) {
          this.lastClose = close
        }
        this.handleSocketClosed(error, gen)
      },
      onError: (error, gen) => this.handleSocketClosed(error, gen),
      onTextFrame: (frame, gen) => this.handleTextFrame(frame, gen),
      onDead: (error, gen) => this.handleSocketClosed(error, gen)
    })
    if (!result.ok) {
      this.handleSocketClosed(result.error, socketGeneration)
      return
    }
    ;({ ws: this.ws, sharedKey: this.sharedKey, cleanup: this.socketCleanup } = result.socket)
    this.state = 'awaiting_ready'
  }

  private handleTextFrame(frame: string, socketGeneration: number): void {
    handleIncomingSharedControlFrame({
      frame,
      socketGeneration: this.socketGeneration,
      generation: socketGeneration,
      getState: () => this.state,
      sharedKey: this.sharedKey,
      options: this.options,
      pairing: this.pairing,
      pendingRequests: this.pendingRequests,
      subscriptions: this.subscriptions,
      retiredRequestIds: this.retiredRequestIds,
      readyWaiters: this.readyWaiters,
      setState: (state) => {
        this.state = state
      },
      handleSocketClosed: (error, gen) => {
        this.handleSocketClosed(error, gen)
      },
      sendEncrypted: (payload) => this.sendEncrypted(payload),
      readyStableReset: this.readyStableReset,
      sessionProbe: this.sessionProbe,
      reconnect: this.reconnect,
      getSocket: () => this.ws,
      setLastConnectedAt: (ts) => {
        this.lastConnectedAt = ts
      },
      replaySubscriptions: () => {
        this.replaySubscriptions()
      },
      reconcileSubscriptionLifecycle: () => {
        this.reconcileSubscriptionLifecycle()
      }
    })
  }

  private sendRequest(requestId: string): void {
    sendSharedControlOutgoingRequest({
      pendingRequests: this.pendingRequests,
      requestId,
      state: this.state,
      ws: this.ws,
      sharedKey: this.sharedKey
    })
  }

  private sendSubscription(subscription: LogicalSubscription): void {
    sendSharedControlActiveSubscription({
      subscriptions: this.subscriptions,
      subscription,
      deviceToken: this.pairing.deviceToken,
      sendEncrypted: (payload) => this.sendEncrypted(payload),
      sessionProbe: this.sessionProbe
    })
  }

  private replaySubscriptions(): void {
    replaySharedControlActiveSubscriptions({
      subscriptions: this.subscriptions,
      sendSubscription: (s) => this.sendSubscription(s),
      tagReplayedResponses: this.everReady
    })
    this.everReady = true
  }

  private closeSubscription(requestId: string): void {
    closeActiveSharedControlSubscription({
      subscriptions: this.subscriptions,
      retiredRequestIds: this.retiredRequestIds,
      requestId,
      deviceToken: this.pairing.deviceToken,
      sendEncrypted: (payload) => this.sendEncrypted(payload),
      onReconcile: () => this.reconcileSubscriptionLifecycle()
    })
  }

  private reconcileSubscriptionLifecycle(): void {
    this.sessionProbe.schedule()
    this.reconnect.clearWhenIdle(this.subscriptions.size === 0 && this.state === 'closed')
  }

  private sendEncrypted(payload: unknown): boolean {
    return sharedControlProtocol.sendSharedControlEncrypted({
      state: this.state,
      ws: this.ws,
      sharedKey: this.sharedKey,
      payload
    })
  }

  private handleSocketClosed(error: RemoteRuntimeClientError, socketGeneration: number): void {
    const lastError = handleSharedControlSocketClosed({
      error,
      socketGeneration: this.socketGeneration,
      generation: socketGeneration,
      everReady: this.everReady,
      subscriptions: this.subscriptions,
      intentionallyClosed: this.intentionallyClosed,
      reconnect: this.reconnect,
      closeSocket: (err) => this.closeSocket(err),
      open: () => this.open()
    })
    if (lastError !== null) {
      this.lastError = lastError
    }
  }

  private closeSocket(error?: Error, preserveReadyWaitersAndPendingRequests = false): void {
    teardownSharedControlSocket({
      environmentId: this.options.environmentId,
      state: this.state,
      pendingRequests: this.pendingRequests,
      subscriptions: this.subscriptions,
      readyWaiters: this.readyWaiters,
      lastClose: this.lastClose,
      socketCleanup: this.socketCleanup,
      ws: this.ws,
      error,
      preserveReadyWaitersAndPendingRequests,
      readyStableReset: this.readyStableReset,
      sessionProbe: this.sessionProbe
    })
    this.ws = this.sharedKey = this.socketCleanup = null
    this.state = 'closed'
  }
}
