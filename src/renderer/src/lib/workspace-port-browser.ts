import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { useAppStore } from '@/store'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { WorkspacePort } from '../../../shared/workspace-ports'
import type { LocalhostWorktreeLabelRoute } from '../../../shared/localhost-worktree-labels'
import { browserUrlForPort, previewBrowserUrlForPort } from './workspace-port-urls'
import { createBrowserUuid } from './browser-uuid'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { RUNTIME_BROWSER_UNAVAILABLE_MESSAGE } from './client-creation-action-policy'

const WORKSPACE_PORT_TARGET_UNAVAILABLE_REASON =
  'Workspace ports are unavailable for this execution host.'

export type BrowserTabCreator = ReturnType<typeof useAppStore.getState>['createBrowserTab']
export type RemoteBrowserPageHandleSetter = ReturnType<
  typeof useAppStore.getState
>['setRemoteBrowserPageHandle']

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

export async function openWorkspacePortInBrowser(args: {
  port: WorkspacePort
  activeWorktreeId?: string | null
  runtimeTarget: RuntimeClientTarget | null
  createBrowserTab: BrowserTabCreator
  setRemoteBrowserPageHandle: RemoteBrowserPageHandleSetter
  openInOrcaBrowser?: boolean
  localhostLabelRoute?: LocalhostWorktreeLabelRoute | null
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!args.runtimeTarget) {
    return { ok: false, reason: WORKSPACE_PORT_TARGET_UNAVAILABLE_REASON }
  }
  const url = await resolveWorkspacePortBrowserUrl({
    port: args.port,
    runtimeTarget: args.runtimeTarget,
    localhostLabelRoute: args.localhostLabelRoute
  })
  if (args.openInOrcaBrowser === false) {
    const externalUrl =
      args.runtimeTarget.kind === 'local' ? url : previewBrowserUrlForPort(args.port)
    if (externalUrl) {
      try {
        await window.api.shell.openUrl(externalUrl)
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const fallback =
          args.runtimeTarget.kind === 'local'
            ? 'Failed to open system browser.'
            : 'Failed to open preview URL.'
        return { ok: false, reason: message || fallback }
      }
    }
  }

  const worktreeId =
    args.port.kind === 'workspace' ? args.port.owner.worktreeId : args.activeWorktreeId
  if (!worktreeId) {
    return { ok: false, reason: 'No workspace selected for the browser.' }
  }
  activateAndRevealWorktree(worktreeId, { providesInitialSurface: true })
  if (args.runtimeTarget.kind === 'environment') {
    try {
      await assertRuntimeEnvironmentCapability(
        args.runtimeTarget.environmentId,
        BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
        RUNTIME_BROWSER_UNAVAILABLE_MESSAGE
      )
      const remotePage = await callRuntimeRpc<{ browserPageId: string }>(
        args.runtimeTarget,
        'browser.tabCreate',
        { worktree: toRuntimeWorktreeSelector(worktreeId), url },
        { timeoutMs: 30_000 }
      )
      const browserPageId = createBrowserUuid()
      args.createBrowserTab(worktreeId, url, {
        activate: true,
        browserRuntimeEnvironmentId: args.runtimeTarget.environmentId,
        browserPageId
      })
      args.setRemoteBrowserPageHandle(browserPageId, {
        environmentId: args.runtimeTarget.environmentId,
        remotePageId: remotePage.browserPageId
      })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: message || 'Failed to open remote browser.' }
    }
  }
  try {
    args.createBrowserTab(worktreeId, url, { activate: true })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: message || 'Failed to open browser.' }
  }
}
