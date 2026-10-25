import * as sharedControlProtocol from './remote-runtime-shared-control-protocol'
import * as sharedControlState from './remote-runtime-shared-control-state'

import { requestSharedControl } from '../requests/remote-runtime-shared-control-requests'
import type { SharedControlRetiredRequestIds } from '../requests/remote-runtime-shared-control-retired-request-ids'
import { closeSharedControlConnectionSubscription } from '../requests/remote-runtime-shared-control-subscription-close'
import { startSharedControlSubscription } from '../requests/remote-runtime-shared-control-subscription-start'
import * as sharedControlSubscriptions from '../requests/remote-runtime-shared-control-subscriptions'
import * as sharedControlSend from './remote-runtime-shared-control-send'
import type {
  RemoteRuntimeSharedSubscription,
  SharedControlLogicalSubscription,
  SharedControlPendingRequest,
  SharedControlSubscriptionCallbacks
} from './remote-runtime-shared-control-types'

export type SharedControlRequestEnvelope = Parameters<typeof requestSharedControl>[0]['envelope']

export type SharedControlTransportSnapshot = {
  state: Parameters<typeof sharedControlProtocol.sendSharedControlEncryptedSerialized>[0]['state']
  ws: Parameters<typeof sharedControlProtocol.sendSharedControlEncryptedSerialized>[0]['ws']
  handshake: Parameters<
    typeof sharedControlProtocol.sendSharedControlEncryptedSerialized
  >[0]['handshake']
}

export function requestRuntimeControl<TResult>(args: {
  beforeSend?: () => void
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  deviceToken: string
  method: string
  params: unknown
  timeoutMs: number
  envelope?: SharedControlRequestEnvelope
  ensureReady: () => Promise<void>
  getTransport: () => SharedControlTransportSnapshot
  retireRequestId: (requestId: string) => void
  signal?: AbortSignal
}): ReturnType<typeof requestSharedControl<TResult>> {
  return requestSharedControl<TResult>({
    beforeSend: args.beforeSend,
    pendingRequests: args.pendingRequests,
    deviceToken: args.deviceToken,
    method: args.method,
    params: args.params,
    timeoutMs: args.timeoutMs,
    envelope: args.envelope,
    ensureReady: args.ensureReady,
    send: (requestId) =>
      sendSharedControlRequest({
        pendingRequests: args.pendingRequests,
        requestId,
        ...args.getTransport()
      }),
    retireRequestId: args.retireRequestId,
    signal: args.signal
  })
}

export function sendSharedControlRequest(args: {
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  requestId: string
  state: Parameters<typeof sharedControlProtocol.sendSharedControlEncryptedSerialized>[0]['state']
  ws: Parameters<typeof sharedControlProtocol.sendSharedControlEncryptedSerialized>[0]['ws']
  handshake: Parameters<
    typeof sharedControlProtocol.sendSharedControlEncryptedSerialized
  >[0]['handshake']
}): void {
  sharedControlSend.sendSharedControlRequest({
    pendingRequests: args.pendingRequests,
    requestId: args.requestId,
    send: (serialized) =>
      sharedControlProtocol.sendSharedControlEncryptedSerialized({
        state: args.state,
        ws: args.ws,
        handshake: args.handshake,
        serialized
      }),
    reject: (id, error) =>
      sharedControlState.rejectSharedControlPendingRequest(args.pendingRequests, id, error)
  })
}

export function startRuntimeControlSubscription<TResult>(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  deviceToken: string
  method: string
  params: unknown
  callbacks: SharedControlSubscriptionCallbacks<TResult>
  signal?: AbortSignal
  ensureReady: () => Promise<void>
  send: (payload: unknown) => boolean
  onSent: () => void
  closeSubscription: (requestId: string) => void
}): Promise<RemoteRuntimeSharedSubscription> {
  return startSharedControlSubscription({
    subscriptions: args.subscriptions,
    deviceToken: args.deviceToken,
    method: args.method,
    params: args.params,
    callbacks: args.callbacks,
    signal: args.signal,
    ensureReady: args.ensureReady,
    sendSubscription: (subscription) => {
      sharedControlSend.sendSharedControlSubscription({
        subscriptions: args.subscriptions,
        subscription,
        deviceToken: args.deviceToken,
        send: args.send
      })
      args.onSent()
    },
    closeSubscription: args.closeSubscription
  })
}

export function closeRuntimeControlSubscription(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  retiredRequestIds: SharedControlRetiredRequestIds
  requestId: string
  deviceToken: string
  send: (payload: unknown) => boolean
  onClosed: () => void
}): void {
  closeSharedControlConnectionSubscription(args)
  args.onClosed()
}

export function replaySharedControlSubscriptions(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  send: (subscription: SharedControlLogicalSubscription<unknown>) => void
  tagReplayedResponses: boolean
}): boolean {
  sharedControlSubscriptions.replaySharedControlSubscriptions(args)
  return true
}

export function replayRuntimeControlSubscriptions(args: {
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  deviceToken: string
  send: (payload: unknown) => boolean
  tagReplayedResponses: boolean
  onReplayed?: () => void
}): boolean {
  const replayed = replaySharedControlSubscriptions({
    subscriptions: args.subscriptions,
    send: (subscription) =>
      sharedControlSend.sendSharedControlSubscription({
        subscriptions: args.subscriptions,
        subscription,
        deviceToken: args.deviceToken,
        send: args.send
      }),
    tagReplayedResponses: args.tagReplayedResponses
  })
  args.onReplayed?.()
  return replayed
}
