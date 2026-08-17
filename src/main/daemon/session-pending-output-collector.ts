import type { SessionOutputPlane } from './session-output-plane'
import type { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'

export function collectSessionPendingOutput(args: {
  disposed: boolean
  includeSnapshot: boolean
  teardownSnapshot?: boolean
  shellReady: SessionShellReadyBarrier
  startupIngress: PtyStartupIngress
  output: SessionOutputPlane
  getSnapshot: (opts?: { scrollbackRows?: number }) => TerminalSnapshot | null
}): TakePendingOutputResult | null {
  if (args.disposed) {
    return null
  }
  const releasedHeldBytes =
    args.includeSnapshot && args.teardownSnapshot === true
      ? prepareSessionForFinalSnapshot(args.shellReady, args.startupIngress)
      : ''
  return args.output.takePendingOutput(args.includeSnapshot, releasedHeldBytes, () =>
    args.getSnapshot()
  )
}

export function prepareSessionForFinalSnapshot(
  shellReady: SessionShellReadyBarrier,
  startupIngress: PtyStartupIngress
): string {
  const held = shellReady.releaseHeldBytes()
  startupIngress.snapshotBarrier()
  return held
}
