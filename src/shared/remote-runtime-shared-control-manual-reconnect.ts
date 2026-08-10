import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'

export function reconnectSharedControlNow(
  unavailable: boolean,
  closeSocket: (error: RemoteRuntimeClientError) => void,
  open: () => void
): void {
  if (!unavailable) {
    return
  }
  // Why: replace even a stuck CONNECTING/awaiting-ready socket instead of waiting
  // behind stale backoff when the caller has proof the endpoint is reachable.
  closeSocket(remoteRuntimeUnavailableError('Refreshing remote runtime control transport.'))
  open()
}
