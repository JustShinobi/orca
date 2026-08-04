import { describe, expect, it } from 'vitest'
import type { RuntimeStatus } from './runtime-types'
import {
  isRuntimeEnvironmentWorkspaceWindowClosed,
  isRuntimeWorkspaceWindowClosed
} from './runtime-workspace-window-availability'

function makeStatus(overrides: Partial<RuntimeStatus>): RuntimeStatus {
  return {
    runtimeId: 'runtime-hub',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    liveTabCount: 0,
    liveLeafCount: 0,
    ...overrides
  }
}

describe('isRuntimeWorkspaceWindowClosed', () => {
  it('flags a reachable host whose graph is gone but whose desktop window can be opened', () => {
    expect(
      isRuntimeWorkspaceWindowClosed(
        makeStatus({
          graphStatus: 'unavailable',
          authoritativeWindowId: null,
          desktopWindowStatus: 'openable'
        })
      )
    ).toBe(true)
  })

  it('leaves graph-ready headless servers alone', () => {
    // Why: #6844 headless serve owns a graph without a desktop window — it must
    // never read as degraded just because a window could be opened.
    expect(
      isRuntimeWorkspaceWindowClosed(
        makeStatus({ graphStatus: 'ready', desktopWindowStatus: 'openable' })
      )
    ).toBe(false)
  })

  it('ignores a transient renderer reload', () => {
    expect(
      isRuntimeWorkspaceWindowClosed(
        makeStatus({ graphStatus: 'reloading', desktopWindowStatus: 'openable' })
      )
    ).toBe(false)
  })

  it('treats a missing desktop window claim as no claim', () => {
    expect(isRuntimeWorkspaceWindowClosed(makeStatus({ graphStatus: 'unavailable' }))).toBe(false)
    expect(
      isRuntimeWorkspaceWindowClosed(
        makeStatus({ graphStatus: 'unavailable', desktopWindowStatus: 'initializing' })
      )
    ).toBe(false)
    expect(
      isRuntimeWorkspaceWindowClosed(
        makeStatus({ graphStatus: 'unavailable', desktopWindowStatus: 'blocked' })
      )
    ).toBe(false)
  })

  it('is not a substitute for an unreachable host', () => {
    expect(isRuntimeWorkspaceWindowClosed(null)).toBe(false)
    expect(isRuntimeWorkspaceWindowClosed(undefined)).toBe(false)
  })
})

describe('isRuntimeEnvironmentWorkspaceWindowClosed', () => {
  const statuses = new Map([
    [
      'hub',
      {
        status: makeStatus({
          graphStatus: 'unavailable',
          authoritativeWindowId: null,
          desktopWindowStatus: 'openable'
        })
      }
    ],
    ['gpu', { status: null }]
  ])

  it('resolves the owning environment before deciding', () => {
    expect(isRuntimeEnvironmentWorkspaceWindowClosed(statuses, 'hub')).toBe(true)
    expect(isRuntimeEnvironmentWorkspaceWindowClosed(statuses, 'gpu')).toBe(false)
    expect(isRuntimeEnvironmentWorkspaceWindowClosed(statuses, 'unknown')).toBe(false)
    expect(isRuntimeEnvironmentWorkspaceWindowClosed(statuses, null)).toBe(false)
    expect(isRuntimeEnvironmentWorkspaceWindowClosed(undefined, 'hub')).toBe(false)
  })
})
