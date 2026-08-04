import { describe, expect, it } from 'vitest'
import {
  isConnectedRuntimeHostState,
  runtimeHostConnectionState,
  runtimeStatusForOverall
} from './remote-host-connection-status'

describe('remote host connection status', () => {
  it('counts connected remote servers as connected hosts', () => {
    // Why: "connected" = attached/reachable (active-agnostic), matching Settings.
    // There is no separate "available" state — a reachable host is just Connected.
    expect(runtimeStatusForOverall('connected')).toBe('connected')
    expect(isConnectedRuntimeHostState('connected')).toBe(true)
  })

  it('keeps reconnecting and disconnected remote servers out of the connected count', () => {
    expect(runtimeStatusForOverall('reconnecting')).toBe('connecting')
    expect(runtimeStatusForOverall('disconnected')).toBe('disconnected')
    expect(isConnectedRuntimeHostState('reconnecting')).toBe(false)
    expect(isConnectedRuntimeHostState('disconnected')).toBe(false)
  })

  it('still counts a workspace-window-closed remote server as a connected host', () => {
    // Why: the transport is healthy, so demoting it to disconnected would be a lie
    // in the other direction — only the row wording changes (#12350).
    expect(runtimeStatusForOverall('workspace-window-closed')).toBe('connected')
    expect(isConnectedRuntimeHostState('workspace-window-closed')).toBe(true)
  })

  it('distinguishes a reachable host whose workspace window is closed', () => {
    expect(
      runtimeHostConnectionState({ hasStatus: true, online: true, workspaceWindowClosed: true })
    ).toBe('workspace-window-closed')
    expect(
      runtimeHostConnectionState({ hasStatus: true, online: true, workspaceWindowClosed: false })
    ).toBe('connected')
  })

  it('keeps transport failures ahead of a closed workspace window', () => {
    expect(
      runtimeHostConnectionState({ hasStatus: false, online: false, workspaceWindowClosed: true })
    ).toBe('checking')
    expect(
      runtimeHostConnectionState({ hasStatus: true, online: false, workspaceWindowClosed: true })
    ).toBe('disconnected')
    expect(
      runtimeHostConnectionState({
        hasStatus: true,
        online: true,
        workspaceWindowClosed: true,
        remoteControl: {
          state: 'reconnecting',
          pendingRequestCount: 0,
          subscriptionCount: 0,
          reconnectAttempt: 0,
          lastConnectedAt: null,
          lastClose: null,
          lastError: null
        }
      })
    ).toBe('reconnecting')
  })
})
