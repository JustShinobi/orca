import { translate } from '@/i18n/i18n'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime-shared-control-types'
import type { RuntimeHostConnectionState } from './RuntimeHostStatusRow'

export type HostStatus = 'connected' | 'disconnected' | 'connecting'

function isConnecting(status: SshConnectionStatus): boolean {
  return ['connecting', 'deploying-relay', 'reconnecting'].includes(status)
}

export function overallStatus(
  statuses: HostStatus[]
): 'connected' | 'partial' | 'disconnected' | 'connecting' {
  if (statuses.length === 0) {
    return 'disconnected'
  }
  if (statuses.every((s) => s === 'connected')) {
    return 'connected'
  }
  if (statuses.some((s) => s === 'connecting')) {
    return 'connecting'
  }
  if (statuses.some((s) => s === 'connected')) {
    return 'partial'
  }
  return 'disconnected'
}

export function overallDotColor(
  status: 'connected' | 'partial' | 'disconnected' | 'connecting',
  connectedCount: number
): string {
  switch (status) {
    case 'connected':
      return 'bg-emerald-500'
    case 'partial':
      return connectedCount > 0 ? 'bg-emerald-500' : 'bg-muted-foreground/40'
    case 'connecting':
      return 'bg-yellow-500'
    case 'disconnected':
      return 'bg-muted-foreground/40'
  }
}

export function sshStatusForOverall(status: SshConnectionStatus): HostStatus {
  if (status === 'connected') {
    return 'connected'
  }
  return isConnecting(status) ? 'connecting' : 'disconnected'
}

export function runtimeHostConnectionState({
  hasStatus,
  online,
  workspaceWindowClosed,
  remoteControl
}: {
  hasStatus: boolean
  online: boolean
  workspaceWindowClosed: boolean
  remoteControl?: RemoteRuntimeSharedConnectionDiagnostics | null
}): RuntimeHostConnectionState {
  if (!hasStatus) {
    return 'checking'
  }
  if (remoteControl?.state === 'reconnecting') {
    return 'reconnecting'
  }
  if (!online) {
    return 'disconnected'
  }
  if (remoteControl?.state === 'closed' && remoteControl.lastError) {
    return 'disconnected'
  }
  // Why: reachable but graph-less — the transport is fine, so this is not a
  // network disconnect, but calling it "Connected" hides that nothing will run.
  if (workspaceWindowClosed) {
    return 'workspace-window-closed'
  }
  // Why: "connected" means attached/reachable, NOT "is the active default host".
  // Both surfaces (this status bar and Settings > Remote Orca Servers) must agree
  // on that single definition, or a reachable-but-not-active host reads
  // "Connected" in one place and "Available" in the other. Active/default is a
  // separate concept (surfaced elsewhere), so it must not change this state.
  return 'connected'
}

export function runtimeHostConnectionDetail(
  remoteControl?: RemoteRuntimeSharedConnectionDiagnostics | null
): string | undefined {
  if (!remoteControl) {
    return undefined
  }
  if (remoteControl.lastError) {
    return remoteControl.lastError
  }
  if (remoteControl.lastClose?.reason) {
    return translate(
      'auto.components.status.bar.SshStatusSegment.runtime_last_close_reason',
      'Closed: {{value0}}',
      { value0: remoteControl.lastClose.reason }
    )
  }
  if (remoteControl.state === 'reconnecting') {
    return translate(
      'auto.components.status.bar.SshStatusSegment.runtime_reconnect_attempt',
      'Attempt {{value0}}',
      { value0: String(remoteControl.reconnectAttempt + 1) }
    )
  }
  // Why: pending-request / subscription counts are internal RPC plumbing (e.g. a
  // live browser screencast shows as "N streams"). They're noise in a user-facing
  // status row and make the line truncate — only surface actionable detail
  // (errors, close reasons, reconnect attempts) above.
  return undefined
}

export function runtimeStatusForOverall(state: RuntimeHostConnectionState): HostStatus {
  switch (state) {
    // Why: a closed workspace window is a degraded host, not a lost connection —
    // it must keep counting toward the connected-host total.
    case 'connected':
    case 'workspace-window-closed':
      return 'connected'
    case 'checking':
    case 'reconnecting':
      return 'connecting'
    case 'disconnected':
      return 'disconnected'
  }
}

export function isConnectedRuntimeHostState(state: RuntimeHostConnectionState): boolean {
  return state === 'connected' || state === 'workspace-window-closed'
}
