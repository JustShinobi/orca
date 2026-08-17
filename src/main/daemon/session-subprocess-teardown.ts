import type { SessionOutputPlane } from './session-output-plane'
import type { SessionProducerPause } from './session-producer-pause'
import type { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { SessionTerminationController } from './session-termination-controller'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { PtyStartupIngress } from '../../shared/pty-startup-ingress'

export function teardownSessionSubprocess(args: {
  output: SessionOutputPlane
  producerPause: SessionProducerPause
  termination: SessionTerminationController
  shellReady: SessionShellReadyBarrier
}): void {
  args.output.markDisposed()
  args.producerPause.release({ resume: true })
  args.termination.cancelForceKillFallback()
  args.shellReady.dispose()
  args.termination.disposeSubprocessHandle()
}

export function handleSessionSubprocessExit(args: {
  code: number
  incarnationId: string
  output: SessionOutputPlane
  producerPause: SessionProducerPause
  termination: SessionTerminationController
  shellReady: SessionShellReadyBarrier
  startupIngress: PtyStartupIngress
  onSessionExit?: (code: number) => void
}): void {
  args.shellReady.releaseDeviceAttributes()
  args.shellReady.disposePromptReadinessProbe()
  args.shellReady.releaseHeldBytes()
  args.startupIngress.drainAndClose()
  args.termination.clearTerminating()
  args.producerPause.release({ resume: false })

  args.termination.cancelForceKillFallback()
  args.shellReady.clearReadyTimer()
  args.shellReady.reportUndeliveredStartupCommand()
  args.shellReady.clearFlushGate()
  args.termination.disposeSubprocessHandle()

  args.output.broadcastExit(args.code, args.incarnationId)
  args.onSessionExit?.(args.code)
}

export function disposeSession(args: {
  incarnationId: string
  state: string
  subprocess: SubprocessHandle
  output: SessionOutputPlane
  producerPause: SessionProducerPause
  termination: SessionTerminationController
  shellReady: SessionShellReadyBarrier
  startupIngress: PtyStartupIngress
  teardownSubprocess: () => void
}): { exitCode: number | null } {
  args.shellReady.releaseDeviceAttributes()
  args.shellReady.releaseHeldBytes()
  args.startupIngress.drainAndClose()
  const wasTerminating = args.termination.isTerminating && args.state !== 'exited'
  const clientsToNotify = wasTerminating ? args.output.snapshotClients() : []
  let exitCode: number | null = null
  if (wasTerminating) {
    try {
      args.subprocess.forceKill()
    } catch {
      /* child may already be gone */
    }
    exitCode = -1
    args.termination.clearTerminating()
  }

  args.teardownSubprocess()

  args.output.clearClients()
  args.shellReady.clearPendingWrites()
  args.output.disposeEmulator()

  for (const client of clientsToNotify) {
    client.onExit(-1, args.incarnationId)
  }

  return { exitCode }
}
