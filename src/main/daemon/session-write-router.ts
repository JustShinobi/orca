import { extractOnlyCookedEchoSafeQueryReplies } from '../../shared/terminal-query-reply'
import type { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { SubprocessHandle } from './session-subprocess-handle'

export function writeSessionData(args: {
  data: string
  disposed: boolean
  state: string
  startupIngress: PtyStartupIngress
  shellReady: SessionShellReadyBarrier
  subprocess: SubprocessHandle
}): void {
  if (args.state === 'exited' || args.disposed) {
    return
  }
  if (
    extractOnlyCookedEchoSafeQueryReplies(args.data) &&
    args.startupIngress.answerLiveQueryReply(args.data)
  ) {
    return
  }
  if (args.shellReady.tryEnqueue(args.data)) {
    return
  }
  args.subprocess.write(args.data)
}

export function writeSessionStartupCommand(args: {
  data: string
  disposed: boolean
  state: string
  startupIngress: PtyStartupIngress
  shellReady: SessionShellReadyBarrier
  subprocess: SubprocessHandle
}): void {
  if (args.state === 'exited' || args.disposed) {
    return
  }
  if (args.shellReady.writeStartupCommand(args.data)) {
    return
  }
  writeSessionData(args)
}
