import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockLaunchAgentBackgroundSession = vi.fn()
const mockLaunchWorktreeBackgroundTerminals = vi.fn()
const mockFindReusableAutomationSession = vi.fn()
const mockObserveExistingAutomationSession = vi.fn()
const mockSubmitPromptToAgentPty = vi.fn()
const mockCreateWorktree = vi.fn()
const mockMarkDispatchResult = vi.fn()
const mockOnDispatchRequested = vi.fn()
const mockRendererReady = vi.fn()
const mockFinalizeTerminalOwnership = vi.fn()
const mockReleaseTerminalOwnership = vi.fn()
const mockDisposeRunObservation = vi.fn()
const mockSshNeedsPassphrasePrompt = vi.fn()
const mockSshGetState = vi.fn()
const mockSshConnect = vi.fn()
const mockStoreSubscribe = vi.fn(() => () => {})

const setupLaunch = {
  runnerScriptPath: '/tmp/setup.sh',
  envVars: { ORCA_WORKTREE_PATH: '/repo/worktree' }
}

const createdWorktree = {
  id: 'wt-created',
  repoId: 'repo-1',
  displayName: 'Automation worktree',
  path: '/repo/worktree'
}
type TestWorktree = typeof createdWorktree
type TestRepo = {
  id: string
  connectionId: string | null
  executionHostId: string | null
  path: string
}

const state = {
  activeView: 'terminal' as const,
  activeWorktreeId: 'wt-active',
  activeTabId: 'tab-active',
  activeTabType: 'terminal' as const,
  repos: [{ id: 'repo-1', connectionId: null, executionHostId: null, path: '/repo' }] as TestRepo[],
  folderWorkspaces: [] as {
    id: string
    projectGroupId: string
    folderPath: string
    connectionId: string | null
  }[],
  projectGroups: [] as {
    id: string
    connectionId: string | null
    executionHostId?: string | null
  }[],
  worktreesByRepo: {} as Record<string, TestWorktree[]>,
  detectedWorktreesByRepo: {},
  agentStatusByPaneKey: {},
  allWorktrees: vi.fn<() => TestWorktree[]>(() => []),
  getKnownWorktreeById: vi.fn<(worktreeId: string) => TestWorktree | undefined>(() => undefined),
  createWorktree: mockCreateWorktree,
  subscribe: vi.fn(() => () => {}),
  setActiveView: vi.fn(),
  setActiveWorktree: vi.fn(),
  setActiveTab: vi.fn(),
  setActiveTabType: vi.fn()
}

function makeAutomation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'automation-1',
    projectId: 'repo-1',
    prompt: 'run this',
    precheck: null,
    agentId: 'claude',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    setupDecision: 'run',
    reuseSession: false,
    ...overrides
  }
}

function makeRun() {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    title: 'Nightly setup run',
    scheduledFor: Date.parse('2026-06-24T03:00:00Z'),
    trigger: 'scheduled',
    workspaceId: null,
    workspaceDisplayName: null
  }
}

async function registerAndDispatch(automation = makeAutomation()): Promise<void> {
  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof ReactModule>('react')
    return {
      ...actual,
      useEffect: (effect: () => void | (() => void)) => {
        effect()
      }
    }
  })
  const { useAutomationDispatchEvents: registerAutomationDispatchEvents } =
    await import('./useAutomationDispatchEvents')
  registerAutomationDispatchEvents()
  const handler = mockOnDispatchRequested.mock.calls[0]?.[0]
  if (!handler) {
    throw new Error('dispatch handler was not registered')
  }
  await handler({
    automation,
    run: makeRun(),
    dispatchToken: 'dispatch-token'
  })
}

vi.mock('@/lib/launch-agent-background-session', () => ({
  launchAgentBackgroundSession: mockLaunchAgentBackgroundSession
}))

vi.mock('@/lib/launch-worktree-background-terminals', () => ({
  launchWorktreeBackgroundTerminals: mockLaunchWorktreeBackgroundTerminals
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  submitPromptToAgentPty: mockSubmitPromptToAgentPty
}))

vi.mock('@/components/automations/automation-host-client', () => ({
  listAutomationRunsForTarget: vi.fn().mockResolvedValue([])
}))

vi.mock('@/lib/automation-session-reuse', () => ({
  findReusableAutomationSession: mockFindReusableAutomationSession
}))

vi.mock('@/lib/automation-session-observer', () => ({
  observeExistingAutomationSession: mockObserveExistingAutomationSession
}))

vi.mock('@/components/automations/automation-run-output-snapshot', () => ({
  createAutomationRunOutputSnapshotBuffer: () => ({
    append: vi.fn(),
    snapshot: () => null
  }),
  selectAutomationRunOutputSnapshot: (
    assistantMessage: string | null | undefined,
    terminalSnapshot: unknown
  ) =>
    assistantMessage
      ? {
          format: 'plain_text',
          content: assistantMessage,
          capturedAt: 1,
          truncated: false
        }
      : terminalSnapshot
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'create-request-id'
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state,
    subscribe: mockStoreSubscribe
  }
}))

describe('useAutomationDispatchEvents persistence cleanup', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    state.activeView = 'terminal'
    state.activeWorktreeId = 'wt-active'
    state.activeTabId = 'tab-active'
    state.activeTabType = 'terminal'
    state.repos = [{ id: 'repo-1', connectionId: null, executionHostId: null, path: '/repo' }]
    state.folderWorkspaces = []
    state.projectGroups = []
    state.worktreesByRepo = {}
    state.agentStatusByPaneKey = {}
    state.allWorktrees.mockReturnValue([])
    state.getKnownWorktreeById.mockReturnValue(undefined)
    mockCreateWorktree.mockResolvedValue({ worktree: createdWorktree, setup: setupLaunch })
    mockLaunchWorktreeBackgroundTerminals.mockResolvedValue(undefined)
    mockLaunchAgentBackgroundSession.mockResolvedValue({
      tabId: 'agent-tab',
      paneKey: 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d',
      ptyId: 'agent-pty',
      startupPlan: {},
      disposeRunObservation: mockDisposeRunObservation,
      terminalOwnership: {
        finalize: mockFinalizeTerminalOwnership,
        release: mockReleaseTerminalOwnership
      }
    })
    mockOnDispatchRequested.mockReturnValue(() => {})
    mockSshNeedsPassphrasePrompt.mockResolvedValue(false)
    mockSshGetState.mockResolvedValue({ status: 'connected' })
    mockSshConnect.mockResolvedValue({ status: 'connected' })
    mockSubmitPromptToAgentPty.mockResolvedValue(true)
    vi.stubGlobal('window', {
      api: {
        automations: {
          onDispatchRequested: mockOnDispatchRequested,
          rendererReady: mockRendererReady,
          markDispatchResult: mockMarkDispatchResult,
          runPrecheck: vi.fn()
        },
        ssh: {
          needsPassphrasePrompt: mockSshNeedsPassphrasePrompt,
          getState: mockSshGetState,
          connect: mockSshConnect
        }
      }
    })
  })

  it('releases ownership when dispatched result persistence rejects', async () => {
    mockMarkDispatchResult.mockRejectedValueOnce(new Error('persistence unavailable'))

    await registerAndDispatch()

    expect(mockReleaseTerminalOwnership).toHaveBeenCalledOnce()
    expect(mockFinalizeTerminalOwnership).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'dispatch_failed' })
    )
  })

  it('releases ownership when completed result persistence rejects', async () => {
    mockMarkDispatchResult
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('completion persistence unavailable'))
      .mockResolvedValueOnce(undefined)
    mockLaunchAgentBackgroundSession.mockImplementation(async (args) => {
      args.onAgentStatus?.({ state: 'done' })
      return {
        tabId: 'agent-tab',
        paneKey: 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d',
        ptyId: 'agent-pty',
        startupPlan: {},
        disposeRunObservation: mockDisposeRunObservation,
        terminalOwnership: {
          finalize: mockFinalizeTerminalOwnership,
          release: mockReleaseTerminalOwnership
        }
      }
    })

    await registerAndDispatch()

    expect(mockReleaseTerminalOwnership).toHaveBeenCalledOnce()
    expect(mockFinalizeTerminalOwnership).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'dispatch_failed' })
    )
  })

  it('diagnoses a late completed-persistence rejection once without terminal cleanup', async () => {
    let onAgentStatus: ((payload: { state: string }) => void) | undefined
    const persistenceError = new Error('late completion persistence unavailable')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockMarkDispatchResult.mockResolvedValueOnce(undefined).mockRejectedValueOnce(persistenceError)
    mockLaunchAgentBackgroundSession.mockImplementation(async (args) => {
      onAgentStatus = args.onAgentStatus
      return {
        tabId: 'agent-tab',
        paneKey: 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d',
        ptyId: 'agent-pty',
        startupPlan: {},
        disposeRunObservation: mockDisposeRunObservation,
        terminalOwnership: {
          finalize: mockFinalizeTerminalOwnership,
          release: mockReleaseTerminalOwnership
        }
      }
    })

    await registerAndDispatch()
    onAgentStatus?.({ state: 'done' })
    onAgentStatus?.({ state: 'done' })
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledOnce())

    expect(errorSpy).toHaveBeenCalledWith(
      '[automations] Failed to persist late automation result:',
      persistenceError
    )
    expect(mockReleaseTerminalOwnership).toHaveBeenCalledOnce()
    expect(mockFinalizeTerminalOwnership).not.toHaveBeenCalled()
    expect(
      mockMarkDispatchResult.mock.calls.filter(
        ([result]) => result.status === 'completed' && result.terminalPaneKey !== null
      )
    ).toHaveLength(1)
    errorSpy.mockRestore()
  })
})
