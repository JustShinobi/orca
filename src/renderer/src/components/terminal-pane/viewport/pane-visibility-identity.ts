import type { PtyTransport } from '../pty-transport/pty-transport-types'

export type TerminalPaneVisibilitySnapshot = {
  tabId: string
  cwd: string | null | undefined
  isVisible: boolean
}

export function isTerminalPaneVisibilityResume(args: {
  previousIsVisible: boolean | null
  isVisible: boolean
}): boolean {
  return args.previousIsVisible === false && args.isVisible
}

export function getPreviousVisibleForTerminalPane(args: {
  previous: TerminalPaneVisibilitySnapshot | null
  tabId: string
  cwd: string | null | undefined
}): boolean | null {
  if (args.previous?.tabId !== args.tabId || args.previous.cwd !== args.cwd) {
    return null
  }
  return args.previous.isVisible
}

export function retryTerminalPaneRecoveriesOnVisibilityResume(
  transports: Iterable<Pick<PtyTransport, 'retryRecovery'>>,
  resumedFromHidden: boolean
): number {
  if (!resumedFromHidden) {
    return 0
  }
  let retried = 0
  for (const transport of transports) {
    if (transport.retryRecovery?.()) {
      retried += 1
    }
  }
  return retried
}
