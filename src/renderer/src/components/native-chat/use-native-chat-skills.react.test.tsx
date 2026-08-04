// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatSkillDiscovery } from './use-native-chat-skills'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  state: {} as Record<string, unknown>,
  snapshots: [] as NativeChatSkillDiscovery[]
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => mocks.callRuntimeRpc(...args)
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatSkillDiscovery: vi.fn() }))

import {
  resetNativeChatSkillDiscoveryCacheForTests,
  useNativeChatSkills
} from './use-native-chat-skills'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

function stateForHost(hostId: string) {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'worktree-1',
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        connectionId: null,
        executionHostId: hostId
      }
    ],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    settings: { activeRuntimeEnvironmentId: null },
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] },
    worktreesByRepo: {
      'repo-1': [{ id: 'worktree-1', repoId: 'repo-1', path: '/repo/worktree', hostId }]
    }
  }
}

function connectedSshState() {
  return {
    ...stateForHost('ssh:target-1'),
    sshConnectionStates: new Map([
      [
        'target-1',
        {
          targetId: 'target-1',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          connectionGeneration: 3
        }
      ]
    ])
  }
}

function Probe({ enabled }: { enabled: boolean }): null {
  mocks.snapshots.push(useNativeChatSkills('codex', 'tab-1', enabled))
  return null
}

const DISCOVERY_RESULT = {
  skills: [
    {
      id: 'browser',
      name: 'browser',
      description: null,
      providers: ['agent-skills'],
      sourceKind: 'home',
      sourceLabel: 'Agent skills home',
      rootPath: '/home/test/.agents/skills',
      directoryPath: '/home/test/.agents/skills/browser',
      skillFilePath: '/home/test/.agents/skills/browser/SKILL.md',
      installed: true,
      fileCount: 1,
      updatedAt: null
    }
  ],
  sources: [
    {
      id: 'home-agents',
      label: 'Agent skills home',
      path: '/home/test/.agents/skills',
      sourceKind: 'home',
      providers: ['agent-skills'],
      owner: null,
      exists: true
    }
  ],
  scannedAt: 1
}

describe('useNativeChatSkills', () => {
  beforeEach(() => {
    mocks.state = stateForHost('local')
    mocks.snapshots = []
    mocks.callRuntimeRpc.mockReset()
    mocks.callRuntimeRpc.mockResolvedValue(DISCOVERY_RESULT)
    resetNativeChatSkillDiscoveryCacheForTests()
  })

  afterEach(() => cleanup())

  it('starts lazily and exposes loading separately from ready results', async () => {
    const view = render(<Probe enabled={false} />)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.snapshots.at(-1)?.status).toBe('idle')

    view.rerender(<Probe enabled />)
    expect(mocks.snapshots.at(-1)?.status).toBe('loading')
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    expect(mocks.snapshots.at(-1)?.skills.map((skill) => skill.name)).toEqual(['browser'])
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'skills.discover',
      { cwd: '/repo/worktree', worktreeId: 'worktree-1' },
      { timeoutMs: 10_000 }
    )
  })

  it('shares one in-flight request between sibling panes', async () => {
    render(
      <>
        <Probe enabled />
        <Probe enabled />
      </>
    )
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('discovers SSH pane skills through the identity-only pane method', async () => {
    mocks.state = connectedSshState()
    mocks.callRuntimeRpc.mockResolvedValue({ status: 'ok', result: DISCOVERY_RESULT })
    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    expect(mocks.snapshots.at(-1)?.skills.map((skill) => skill.name)).toEqual(['browser'])
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'skills.discoverForPane',
      { worktreeId: 'worktree-1', terminalTabId: 'tab-1' },
      { timeoutMs: 10_000 }
    )
  })

  it('maps an old relay to relay-upgrade-required with Retry intact', async () => {
    mocks.state = connectedSshState()
    mocks.callRuntimeRpc.mockResolvedValue({ status: 'relay-upgrade-required' })
    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.errorKind).toBe('relay-upgrade-required'))
    expect(mocks.snapshots.at(-1)?.status).toBe('error')
    expect(typeof mocks.snapshots.at(-1)?.retry).toBe('function')
  })

  it('maps an old paired runtime (method_not_found) to runtime-upgrade-required', async () => {
    mocks.state = connectedSshState()
    mocks.callRuntimeRpc.mockRejectedValue(
      new RuntimeRpcCallError({
        error: { code: 'method_not_found', message: 'Unknown method: skills.discoverForPane' }
      } as never)
    )
    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.errorKind).toBe('runtime-upgrade-required'))
  })

  it('shows a host error for a disconnected SSH host without issuing the RPC', async () => {
    mocks.state = stateForHost('ssh:target-1')
    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.errorKind).toBe('host'))
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('routes runtime-owned panes through their saved environment', async () => {
    mocks.state = stateForHost('runtime:env-1')
    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'skills.discover',
      { cwd: '/repo/worktree', worktreeId: 'worktree-1' },
      { timeoutMs: 10_000 }
    )
  })
})
