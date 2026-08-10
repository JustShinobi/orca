import { randomUUID } from 'node:crypto'
import { serializeRemoteRuntimeRpcRequest } from './remote-runtime-memory-limits'
import {
  prepareRemoteRuntimeRequest,
  type RemoteRuntimePreparedRequest
} from './remote-runtime-prepared-request-admission'
import { remoteRuntimeTimeoutError } from './remote-runtime-request-frames'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import { toRemoteRuntimeClientError } from './remote-runtime-shared-control-protocol'
import { rejectSharedControlPendingRequest } from './remote-runtime-shared-control-state'
import type { SharedControlPendingRequest } from './remote-runtime-shared-control-types'

const MAX_RETAINED_METHOD_CHARS = 256

export function requestSharedControl<TResult>(args: {
  pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
  deviceToken: string
  method: string
  params: unknown
  timeoutMs: number
  ensureReady: () => Promise<void>
  send: (requestId: string) => void
  retireRequestId?: (requestId: string) => void
  signal?: AbortSignal
  // Why: default off — ordinary short RPCs keep an absolute deadline. Only
  // long-polls routed through this path opt in so keepalives extend them.
  refreshTimeoutOnKeepalive?: boolean
}): Promise<RuntimeRpcResponse<TResult>> {
  const { ensureReady, pendingRequests, send } = args
  const requestId = randomUUID()
  if (args.signal?.aborted) {
    return Promise.reject(createSharedControlRequestAbortError())
  }
  let preparedRequest: RemoteRuntimePreparedRequest
  try {
    preparedRequest = prepareRemoteRuntimeRequest(pendingRequests, () =>
      serializeRemoteRuntimeRpcRequest({
        requestId,
        deviceToken: args.deviceToken,
        method: args.method,
        params: args.params
      })
    )
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise<RuntimeRpcResponse<TResult>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!pendingRequests.has(requestId)) {
        return
      }
      args.retireRequestId?.(requestId)
      // Why: one stalled method does not prove the shared socket is dead;
      // socket liveness owns connection-wide teardown so other RPCs survive.
      rejectSharedControlPendingRequest(pendingRequests, requestId, remoteRuntimeTimeoutError())
    }, args.timeoutMs)
    const pending: SharedControlPendingRequest<unknown> = {
      method: args.method.slice(0, MAX_RETAINED_METHOD_CHARS),
      resolve: resolve as (response: RuntimeRpcResponse<unknown>) => void,
      reject,
      timeout,
      preparedRequest,
      refreshTimeoutOnKeepalive: args.refreshTimeoutOnKeepalive ?? false
    }
    pendingRequests.set(requestId, pending)
    if (args.signal) {
      const signal = args.signal
      const abort = (): void => {
        if (!pendingRequests.has(requestId)) {
          return
        }
        args.retireRequestId?.(requestId)
        rejectSharedControlPendingRequest(
          pendingRequests,
          requestId,
          createSharedControlRequestAbortError()
        )
      }
      pending.releaseCancellation = () => signal.removeEventListener('abort', abort)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
      }
    }
    if (pendingRequests.has(requestId)) {
      void ensureReady().then(
        () => send(requestId),
        (error) =>
          rejectSharedControlPendingRequest(
            pendingRequests,
            requestId,
            toRemoteRuntimeClientError(error)
          )
      )
    }
  })
}

function createSharedControlRequestAbortError(): Error {
  const error = new Error('Remote runtime request was cancelled.')
  error.name = 'AbortError'
  return error
}
