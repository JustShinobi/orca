import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import type { LocalhostWorktreeLabelRoute } from '../../../../shared/localhost-worktree-labels'
import { browserUrlForPort } from './workspace-port-urls'

export function shouldOpenWorkspacePortInOrcaBrowser(
  settings: { openLinksInApp?: boolean } | null | undefined
): boolean {
  return settings?.openLinksInApp === true
}

function isMacShortcutPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

export function getPortSystemBrowserHint(isMac: boolean = isMacShortcutPlatform()): string {
  return isMac ? '⇧⌘+click for system browser' : 'Shift+Ctrl+click for system browser'
}

export function getPortOpenBrowserTooltipLabel(openLabel: string, isMac?: boolean): string {
  return `${openLabel}. ${getPortSystemBrowserHint(isMac)}`
}

export type PortOpenClickEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>

export function resolvePortOpenInOrcaBrowser({
  settings,
  event,
  isMac
}: {
  settings: { openLinksInApp?: boolean } | null | undefined
  event?: PortOpenClickEvent | null
  isMac: boolean
}): boolean {
  // Shift+Cmd/Ctrl forces external browser; keyboard/context-menu opens without pointer events retain saved settings.
  if (event?.shiftKey && (isMac ? event.metaKey : event.ctrlKey)) {
    return false
  }
  return shouldOpenWorkspacePortInOrcaBrowser(settings)
}

/** The URL a port opens at: its labelled localhost name when one is set up locally, else its raw URL. */
export async function resolveWorkspacePortBrowserUrl(args: {
  port: WorkspacePort
  runtimeTarget: RuntimeClientTarget
  localhostLabelRoute?: LocalhostWorktreeLabelRoute | null
}): Promise<string> {
  const rawUrl = browserUrlForPort(args.port)
  if (args.runtimeTarget.kind !== 'local' || !args.localhostLabelRoute) {
    return rawUrl
  }
  try {
    return (await window.api.localhostWorktreeLabels.register(args.localhostLabelRoute)).url
  } catch {
    return rawUrl
  }
}
