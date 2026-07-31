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
  closeSocket(remoteRuntimeUnavailableError('Refreshing remote runtime control transport.'))
  open()
}
