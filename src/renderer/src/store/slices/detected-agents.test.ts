import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { createDetectedAgentsSlice } from './detected-agents'
import { createRuntimeDetectedAgentsSlice } from './runtime-detected-agents'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

const detectAgents = vi.fn()
const refreshAgents = vi.fn()
const detectRemoteAgents = vi.fn()
const runtimeEnvironmentCall = vi.fn()

globalThis.window = {
  api: {
    preflight: {
      detectAgents,
      refreshAgents,
      detectRemoteAgents
    },
    runtimeEnvironments: {
      call: runtimeEnvironmentCall
    },
    platform: {
      get: () => ({ platform: 'win32' })
    }
  } as unknown as Window['api']
} as Window & typeof globalThis

function createTestStore(initial?: Partial<AppState>) {
  const store = create<AppState>()(
    (...a) =>
      ({
        ...createDetectedAgentsSlice(...a),
        ...createRuntimeDetectedAgentsSlice(...a)
      }) as AppState
  )
  store.setState({
    repos: [],
    worktreesByRepo: {},
    activeRepoId: null,
    activeWorktreeId: null,
    ...initial
  } as Partial<AppState>)
  return store
}

function makeRepo(overrides: Partial<Repo> & { id: string; path: string }): Repo {
  return {
    displayName: 'Repo',
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}

function makeWorktree(
  overrides: Partial<Worktree> & { id: string; repoId: string; path: string }
): Worktree {
  return {
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('createDetectedAgentsSlice WSL context', () => {
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    detectAgents.mockReset().mockResolvedValue(['claude'])
    refreshAgents.mockReset().mockResolvedValue({
      agents: ['codex'],
      addedPathSegments: [],
      shellHydrationOk: true,
      pathSource: 'shell_hydrate',
      pathFailureReason: 'none'
    })
    detectRemoteAgents.mockReset().mockResolvedValue([])
    runtimeEnvironmentCall.mockReset().mockResolvedValue({
      id: 'default',
      ok: true,
      result: [],
      _meta: { runtimeId: 'runtime' }
    })
  })

  it('detects local agents inside the active WSL worktree distro', async () => {
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({
            id: 'wt-1',
            repoId: 'repo-1',
            path: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
          })
        ]
      },
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1'
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])

    expect(detectAgents).toHaveBeenCalledWith({
      wslDistro: 'Ubuntu',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Ubuntu',
          reason: 'project-override',
          cacheKey: 'repo-1:wsl:Ubuntu'
        }
      }
    })
  })

  it('publishes a Floating-first host probe to a later ordinary local caller', async () => {
    let resolveDetection: (agents: string[]) => void = () => {}
    detectAgents.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveDetection = resolve
      })
    )
    const store = createTestStore()

    const floating = store.getState().ensureDetectedAgents(FLOATING_TERMINAL_WORKTREE_ID)
    const ordinary = store.getState().ensureDetectedAgents()

    expect(detectAgents).toHaveBeenCalledTimes(1)
    expect(store.getState().isDetectingAgents).toBe(true)
    resolveDetection(['codex'])
    await expect(Promise.all([floating, ordinary])).resolves.toEqual([['codex'], ['codex']])
    expect(store.getState().detectedAgentIds).toEqual(['codex'])
    expect(store.getState().isDetectingAgents).toBe(false)
  })

  it('restores the legacy inventory when returning to a cached local context', async () => {
    detectAgents.mockImplementation(async (context) =>
      context?.projectRuntime?.runtime.kind === 'wsl' ? ['claude'] : ['codex']
    )
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await store.getState().ensureDetectedAgents()
    store.setState({ activeRepoId: null })
    await store.getState().ensureDetectedAgents()
    store.setState({ activeRepoId: 'repo-1' })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])
    expect(detectAgents).toHaveBeenCalledTimes(2)
    expect(store.getState().detectedAgentIds).toEqual(['claude'])
  })

  it('retries a local context after a transient detection failure', async () => {
    detectAgents
      .mockRejectedValueOnce(new Error('cold-start timeout'))
      .mockResolvedValueOnce(['codex'])
    const store = createTestStore()

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual([])
    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['codex'])

    expect(detectAgents).toHaveBeenCalledTimes(2)
    expect(store.getState().detectedAgentIds).toEqual(['codex'])
  })

  it('refreshes local agents inside the active WSL repo distro when no worktree is selected', async () => {
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: '\\\\wsl$\\Debian\\home\\alice\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().refreshDetectedAgents()).resolves.toEqual(['codex'])

    expect(refreshAgents).toHaveBeenCalledWith({
      wslDistro: 'Debian',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Debian',
          reason: 'project-override',
          cacheKey: 'repo-1:wsl:Debian'
        }
      }
    })
  })

  it('clears local agents when the project runtime requires repair before detection', async () => {
    detectAgents.mockImplementation(async (context) => {
      if (context?.projectRuntime?.status === 'repair-required') {
        throw new Error('Project runtime requires repair before agent detection')
      }
      return ['claude']
    })
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])
    expect(store.getState().detectedAgentIds).toEqual(['claude'])

    store.setState({
      settings: {
        terminalWindowsShell: 'wsl.exe'
      } as AppState['settings']
    } as Partial<AppState>)

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual([])
    expect(store.getState().detectedAgentIds).toEqual([])

    expect(detectAgents).toHaveBeenCalledWith({
      projectRuntime: {
        status: 'repair-required',
        repair: {
          projectId: 'repo-1',
          preferredRuntime: { kind: 'wsl', distro: null },
          reason: 'wsl-distro-required',
          source: 'global-default',
          cacheKey: 'repo-1:repair:wsl-distro-required:default'
        }
      }
    })
  })

  it('detects local agents in the selected WSL distro when the default Windows shell is WSL', async () => {
    const store = createTestStore({
      settings: {
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian'
      } as AppState['settings'],
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])

    expect(detectAgents).toHaveBeenCalledWith({
      wslDistro: 'Debian',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Debian',
          reason: 'global-default',
          cacheKey: 'repo-1:wsl:Debian'
        }
      }
    })
  })

  it('detects Windows agents when explicit agent location is Windows', async () => {
    const store = createTestStore({
      settings: {
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian',
        localAgentRuntime: 'host'
      } as AppState['settings'],
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])

    expect(detectAgents).toHaveBeenCalledWith({
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'repo-1',
          reason: 'global-default',
          cacheKey: 'repo-1:windows-host'
        }
      }
    })
  })

  it('detects WSL agents when explicit agent location is WSL', async () => {
    const store = createTestStore({
      settings: {
        terminalWindowsShell: 'powershell.exe',
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Fedora'
      } as AppState['settings'],
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])

    expect(detectAgents).toHaveBeenCalledWith({
      wslDistro: 'Fedora',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Fedora',
          reason: 'global-default',
          cacheKey: 'repo-1:wsl:Fedora'
        }
      }
    })
  })

  it('detects agents in the global WSL runtime when no project is active', async () => {
    const store = createTestStore({
      settings: {
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      } as AppState['settings'],
      activeRepoId: null,
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])

    expect(detectAgents).toHaveBeenCalledWith({
      wslDistro: 'Ubuntu',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'local-project',
          distro: 'Ubuntu',
          reason: 'global-default',
          cacheKey: 'local-project:wsl:Ubuntu'
        }
      }
    })
  })

  it('detects agents in the project override runtime instead of legacy agent location', async () => {
    const store = createTestStore({
      settings: {
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Ubuntu'
      } as AppState['settings'],
      projects: [
        {
          id: 'repo-1',
          displayName: 'repo-1',
          badgeColor: 'blue',
          createdAt: 1,
          updatedAt: 1,
          sourceRepoIds: ['repo-1'],
          localWindowsRuntimePreference: { kind: 'windows-host' }
        }
      ],
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    } as Partial<AppState>)

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])

    expect(detectAgents).toHaveBeenCalledWith({
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'repo-1',
          reason: 'project-override',
          cacheKey: 'repo-1:windows-host'
        }
      }
    })
  })

  it('does not keep previous context agents when detection fails after a context switch', async () => {
    detectAgents
      .mockReset()
      .mockResolvedValueOnce(['claude'])
      .mockRejectedValueOnce(new Error('probe failed'))
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])
    expect(store.getState().detectedAgentIds).toEqual(['claude'])

    store.setState({
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    } as Partial<AppState>)
    const detected = store.getState().ensureDetectedAgents()

    expect(store.getState().detectedAgentIds).toBeNull()
    await expect(detected).resolves.toEqual([])
    expect(store.getState().detectedAgentIds).toEqual([])
  })

  it('clears local detection cache explicitly after a project runtime switch', async () => {
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])
    expect(store.getState().detectedAgentIds).toEqual(['claude'])

    store.getState().clearLocalDetectedAgents()

    expect(store.getState().detectedAgentIds).toBeNull()
    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])
    expect(detectAgents).toHaveBeenCalledTimes(2)
  })

  it('ignores in-flight local detection results after a project runtime switch', async () => {
    let resolveDetection: (agents: string[]) => void = () => {}
    detectAgents.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveDetection = resolve
      })
    )
    const store = createTestStore({
      repos: [makeRepo({ id: 'repo-1', path: 'C:\\repo' })],
      activeRepoId: 'repo-1',
      activeWorktreeId: null
    })

    const pending = store.getState().ensureDetectedAgents()
    store.getState().clearLocalDetectedAgents()
    resolveDetection(['claude'])

    await expect(pending).resolves.toEqual(['claude'])
    expect(store.getState().detectedAgentIds).toBeNull()
    expect(store.getState().isDetectingAgents).toBe(false)
  })
})
