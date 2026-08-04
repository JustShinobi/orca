// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_VERSION,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { Project, ProjectHostSetup, Repo } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { RepositoryHostSetupsSection } from './RepositoryHostSetupsSection'

let container: HTMLDivElement
let root: Root

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'displayName' | 'path'>): Repo {
  return {
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    ...overrides
  }
}

function makeProject({ id, ...overrides }: Partial<Project> & Pick<Project, 'id'>): Project {
  return {
    id,
    displayName: 'Orca',
    badgeColor: '#737373',
    sourceRepoIds: ['remote-repo'],
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

function makeSetup(
  overrides: Partial<ProjectHostSetup> &
    Pick<ProjectHostSetup, 'id' | 'projectId' | 'repoId' | 'hostId' | 'path'>
): ProjectHostSetup {
  return {
    displayName: 'Orca',
    kind: 'git',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

function renderSection(repo: Repo): void {
  act(() => {
    root.render(
      React.createElement(RepositoryHostSetupsSection, {
        repo,
        forceVisible: true,
        searchQuery: '',
        searchEntries: []
      })
    )
  })
}

// Why: #12350 — a reachable remote server whose renderer graph is gone still
// answered status.get, so every setup it owned read "Ready".
describe('RepositoryHostSetupsSection workspace window availability', () => {
  it('flags a reachable runtime owner whose workspace window is closed instead of Ready', () => {
    const remoteRepo = makeRepo({
      id: 'remote-repo',
      displayName: 'Orca',
      path: '/srv/orca',
      executionHostId: 'runtime:hub'
    })
    useAppStore.setState({
      repos: [remoteRepo],
      projects: [makeProject({ id: 'github:stablyai/orca', sourceRepoIds: ['remote-repo'] })],
      projectHostSetups: [
        makeSetup({
          id: 'hub-setup',
          projectId: 'github:stablyai/orca',
          repoId: 'remote-repo',
          hostId: 'runtime:hub',
          runtimeOwnerEnvironmentId: 'hub',
          path: '/srv/orca'
        })
      ],
      runtimeStatusByEnvironmentId: new Map([
        [
          'hub',
          {
            checkedAt: 1,
            appVersion: '1.8.0',
            status: {
              runtimeId: 'runtime-hub',
              rendererGraphEpoch: 1,
              graphStatus: 'unavailable',
              authoritativeWindowId: null,
              desktopWindowStatus: 'openable',
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: 1,
              capabilities: [
                PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
                WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
              ]
            }
          }
        ]
      ])
    })

    renderSection(remoteRepo)

    const currentSetup = container.querySelector('[data-current="true"]')
    expect(currentSetup?.textContent).toContain('Workspace window closed')
    expect(currentSetup?.textContent).not.toContain('Ready')
    // The host is reachable — this must not be reported as a lost connection.
    expect(container.textContent).not.toContain('Disconnected')
    expect(container.textContent).toContain('Open Orca on')
  })

  it('keeps a graph-ready runtime owner Ready when it reports no desktop window', () => {
    // Why: headless `orca serve` (#6844) owns a ready graph with an openable
    // desktop window — the degraded check must not widen into a renderer requirement.
    const remoteRepo = makeRepo({
      id: 'remote-repo',
      displayName: 'Orca',
      path: '/srv/orca',
      executionHostId: 'runtime:hub'
    })
    useAppStore.setState({
      repos: [remoteRepo],
      projects: [makeProject({ id: 'github:stablyai/orca', sourceRepoIds: ['remote-repo'] })],
      projectHostSetups: [
        makeSetup({
          id: 'hub-setup',
          projectId: 'github:stablyai/orca',
          repoId: 'remote-repo',
          hostId: 'runtime:hub',
          runtimeOwnerEnvironmentId: 'hub',
          path: '/srv/orca'
        })
      ],
      runtimeStatusByEnvironmentId: new Map([
        [
          'hub',
          {
            checkedAt: 1,
            appVersion: '1.8.0',
            status: {
              runtimeId: 'runtime-hub',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: 0,
              desktopWindowStatus: 'openable',
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: 1,
              capabilities: [
                PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
                WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
              ]
            }
          }
        ]
      ])
    })

    renderSection(remoteRepo)

    expect(container.textContent).toContain('Ready')
    expect(container.textContent).not.toContain('Workspace window closed')
  })
})
