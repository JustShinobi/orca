import type WebSocket from 'ws'
import type { PairingOffer } from './pairing'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { remoteRuntimeClientCapabilities } from './remote-runtime-client-capabilities'
import { openSharedControlSocket } from './remote-runtime-shared-control-open'
import { handleSharedControlTextFrame } from './remote-runtime-shared-control-frame-handler'
import {
  sendSharedControlRequest,
  sendSharedControlSubscription
} from './remote-runtime-shared-control-send'
import { sendSharedControlEncryptedSerialized } from './remote-runtime-shared-control-protocol'
import { rejectSharedControlPendingRequest } from './remote-runtime-shared-control-state'
import { closeSharedControlConnectionSubscription } from './remote-runtime-shared-control-subscription-close'
import { replaySharedControlSubscriptions } from './remote-runtime-shared-control-subscriptions'
import { closeSharedControlSocket } from './remote-runtime-shared-control-socket-close'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import {
  createSharedControlSessionProbe,
  requireSessionProbeSuccess,
  type SharedControlSessionProbe
} from './remote-runtime-shared-control-session-probe'
import type { SharedControlReconnectScheduler } from './remote-runtime-shared-control-reconnect'
import type { SharedControlSocketGeneration } from './remote-runtime-shared-control-socket-generation'
import type { SharedControlReadyStableResetTimer } from './remote-runtime-shared-control-stability'
import type { SharedControlRetiredRequestIds } from './remote-runtime-shared-control-retired-request-ids'
import type {
  RemoteRuntimeSharedControlConnectionOptions,
  SharedControlConnectionState,
  SharedControlLogicalSubscription,
  SharedControlPendingRequest,
  SharedControlReadyWaiter
} from './remote-runtime-shared-control-types'

export function openSharedControlTransport(args: {
  pairing: PairingOffer
  options: RemoteRuntimeSharedControlConnectionOptions
  socketGeneration: SharedControlSocketGeneration
  getCurrentSocket: () => WebSocket | null
  onClose: (
    close: { code: number; reason: string },
    socketGeneration: number,
    error: RemoteRuntimeClientError
  ) => void
  onError: (error: RemoteRuntimeClientError, socketGeneration: number) => void
  onTextFrame: (frame: string, socketGeneration: number) => void
  onDead: (error: RemoteRuntimeClientError, socketGeneration: number) => void
}): {
  socketGeneration: number
  result: ReturnType<typeof openSharedControlSocket>
} {
  const socketGeneration = args.socketGeneration.begin()
  const result = openSharedControlSocket(args.pairing, {
    getCurrentSocket: args.getCurrentSocket,
    onClose: (close, error) => args.onClose(close, socketGeneration, error),
    onError: (error) => args.onError(error, socketGeneration),
    onTextFrame: (frame) => args.onTextFrame(frame, socketGeneration),
    liveness: {
      options: args.options.liveness,
      onDead: (error) => args.onDead(error, socketGeneration)
    }
  })
  return { socketGeneration, result }
}

export function handleIncomingSharedControlFrame(args: {
  frame: string
  socketGeneration: SharedControlSocketGeneration
  generation: number
  getState: () => SharedControlConnectionState
  sharedKey: Uint8Array | null
  options: RemoteRuntimeSharedControlConnectionOptions
  pairing: PairingOffer
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  retiredRequestIds: SharedControlRetiredRequestIds
  readyWaiters: SharedControlReadyWaiter[]
  setState: (state: SharedControlConnectionState) => void
  handleSocketClosed: (error: RemoteRuntimeClientError, generation: number) => void
  sendEncrypted: (payload: unknown) => boolean
  readyStableReset: SharedControlReadyStableResetTimer
  sessionProbe: SharedControlSessionProbe
  reconnect: SharedControlReconnectScheduler
  getSocket: () => WebSocket | null
  setLastConnectedAt: (timestamp: number) => void
  replaySubscriptions: () => void
  reconcileSubscriptionLifecycle: () => void
}): void {
  if (!args.socketGeneration.isCurrent(args.generation)) {
    return
  }
  handleSharedControlTextFrame({
    frame: args.frame,
    state: args.getState(),
    sharedKey: args.sharedKey,
    environmentId: args.options.environmentId,
    deviceToken: args.pairing.deviceToken,
    clientCapabilities: remoteRuntimeClientCapabilities(args.options.clientCapabilities),
    pendingRequests: args.pendingRequests,
    subscriptions: args.subscriptions,
    retiredRequestIds: args.retiredRequestIds,
    readyWaiters: args.readyWaiters,
    setState: args.setState,
    handleSocketClosed: (error) => {
      args.handleSocketClosed(error, args.generation)
    },
    sendEncrypted: args.sendEncrypted,
    markReady: () => {
      args.setLastConnectedAt(Date.now())
      args.readyStableReset.schedule({
        getState: args.getState,
        getSocket: args.getSocket,
        reset: () => args.reconnect.resetAttempt()
      })
      args.sessionProbe.schedule()
    },
    replaySubscriptions: args.replaySubscriptions,
    reconcileSubscriptionLifecycle: args.reconcileSubscriptionLifecycle
  })
}

export function handleSharedControlSocketClosed(args: {
  error: RemoteRuntimeClientError
  socketGeneration: SharedControlSocketGeneration
  generation: number
  everReady: boolean
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  intentionallyClosed: boolean
  reconnect: SharedControlReconnectScheduler
  closeSocket: (error: Error) => void
  open: () => void
}): string | null {
  if (
    !args.socketGeneration.acceptClose({
      generation: args.generation,
      error: args.error,
      everReady: args.everReady,
      subscriptions: args.subscriptions,
      closeSocket: () => {
        args.closeSocket(args.error)
      }
    })
  ) {
    return null
  }
  if (args.subscriptions.size > 0 && !args.intentionallyClosed) {
    args.reconnect.scheduleWithDefaultBackoff(args.intentionallyClosed, () => {
      args.open()
    })
  }
  return args.error.message
}

export function sendSharedControlOutgoingRequest(args: {
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  requestId: string
  state: SharedControlConnectionState
  ws: WebSocket | null
  sharedKey: Uint8Array | null
}): void {
  sendSharedControlRequest({
    pendingRequests: args.pendingRequests,
    requestId: args.requestId,
    send: (serialized) =>
      sendSharedControlEncryptedSerialized({
        state: args.state,
        ws: args.ws,
        sharedKey: args.sharedKey,
        serialized
      }),
    reject: (id, error) => rejectSharedControlPendingRequest(args.pendingRequests, id, error)
  })
}

export function sendSharedControlActiveSubscription(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  subscription: SharedControlLogicalSubscription<unknown>
  deviceToken: string
  sendEncrypted: (payload: unknown) => boolean
  sessionProbe: SharedControlSessionProbe
}): void {
  sendSharedControlSubscription({
    subscriptions: args.subscriptions,
    subscription: args.subscription,
    deviceToken: args.deviceToken,
    send: args.sendEncrypted
  })
  args.sessionProbe.schedule()
}

export function replaySharedControlActiveSubscriptions(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  sendSubscription: (subscription: SharedControlLogicalSubscription<unknown>) => void
  tagReplayedResponses: boolean
}): void {
  replaySharedControlSubscriptions({
    subscriptions: args.subscriptions,
    send: args.sendSubscription,
    tagReplayedResponses: args.tagReplayedResponses
  })
}

export function closeActiveSharedControlSubscription(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  retiredRequestIds: SharedControlRetiredRequestIds
  requestId: string
  deviceToken: string
  sendEncrypted: (payload: unknown) => boolean
  onReconcile: () => void
}): void {
  closeSharedControlConnectionSubscription({
    subscriptions: args.subscriptions,
    retiredRequestIds: args.retiredRequestIds,
    requestId: args.requestId,
    deviceToken: args.deviceToken,
    send: args.sendEncrypted
  })
  args.onReconcile()
}

export function createSharedControlSessionProbeInstance(args: {
  options: RemoteRuntimeSharedControlConnectionOptions
  isIntentionallyClosed: () => boolean
  hasSubscriptions: () => boolean
  isReady: () => boolean
  getSocket: () => WebSocket | null
  requestStatus: (timeoutMs: number, signal?: AbortSignal) => Promise<RuntimeRpcResponse<unknown>>
  forceClose: (error: RemoteRuntimeClientError) => void
}): SharedControlSessionProbe {
  return createSharedControlSessionProbe(args.options, {
    isIntentionallyClosed: args.isIntentionallyClosed,
    hasSubscriptions: args.hasSubscriptions,
    isReady: args.isReady,
    getSocket: args.getSocket,
    probe: async (timeoutMs, signal) =>
      requireSessionProbeSuccess(await args.requestStatus(timeoutMs, signal)),
    forceClose: args.forceClose
  })
}

export function teardownSharedControlSocket(args: {
  environmentId?: string
  state: SharedControlConnectionState
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  readyWaiters: SharedControlReadyWaiter[]
  lastClose: { code: number; reason: string } | null
  socketCleanup: (() => void) | null
  ws: WebSocket | null
  error?: Error
  preserveReadyWaitersAndPendingRequests?: boolean
  readyStableReset: SharedControlReadyStableResetTimer
  sessionProbe: SharedControlSessionProbe
}): void {
  closeSharedControlSocket({
    environmentId: args.environmentId,
    state: args.state,
    pendingRequests: args.pendingRequests,
    subscriptions: args.subscriptions,
    readyWaiters: args.readyWaiters,
    lastClose: args.lastClose,
    socketCleanup: args.socketCleanup,
    ws: args.ws,
    error: args.error,
    preserveReadyWaitersAndPendingRequests: args.preserveReadyWaitersAndPendingRequests,
    clearReadyStableTimer: () => args.readyStableReset.clear()
  })
  args.sessionProbe.clear()
}
