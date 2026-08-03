import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { acceptOutputExitMock, muxRequestMock } = vi.hoisted(() => ({
  acceptOutputExitMock: vi.fn().mockResolvedValue(undefined),
  muxRequestMock: vi.fn()
}))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: vi.fn(async (_mux, options) => ({
    clientInstanceId: options.clientInstanceId,
    clientGeneration: 1,
    ownerGeneration: 1,
    ownerLease: 'test-owner-lease'
  }))
}))
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: vi.fn().mockResolvedValue(undefined),
  acceptSshPtyOutputExit: acceptOutputExitMock,
  allocateSshPtyProviderGeneration: vi.fn(() => 31),
  beginSshPtyOutputGenerationMigration: vi.fn(() => ({
    byPty: new Map(),
    completion: Promise.resolve()
  })),
  closeSshPtyOutputGeneration: vi.fn(),
  getSshPtyAcceptedSourceCheckpoints: vi.fn(() => []),
  applySshPtySourceCancellationProof: vi.fn(() => true),
  applySshPtySourceRecoveryCancellationProof: vi.fn(() => true),
  installSshPtySourceAckPublisher: vi.fn(() => () => {}),
  installSshPtySourceCancellationPublisher: vi.fn(() => () => {})
}))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    notify = vi.fn()
    notifyWithSettlement = vi.fn()
    request = muxRequestMock
    onNotification = vi.fn().mockReturnValue(() => {})
    onNotificationByMethod = vi.fn().mockReturnValue(() => {})
    onRequest = vi.fn().mockReturnValue(() => {})
    onDispose = vi.fn().mockReturnValue(() => {})
    dispose = vi.fn()
    isDisposed = vi.fn().mockReturnValue(false)
  }
}))
vi.mock('../agent-hooks/remote-managed-hook-installers', () => ({
  installRemoteManagedAgentHooks: vi.fn().mockResolvedValue([])
}))
vi.mock('../providers/ssh-pty-provider', () => ({
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
    attachForReconnect = vi.fn().mockResolvedValue({})
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-git-provider', () => ({
  SshGitProvider: class MockSshGitProvider {}
}))
vi.mock('../ipc/pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn(),
  setPtyOwnership: vi.fn(),
  restorePtyIncarnation: vi.fn(),
  isCurrentPtyExit: vi.fn(() => true),
  answerStartupTerminalColorQueriesForPty: vi.fn((_id: string, data: string) => data)
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: vi.fn(),
  unregisterSshFilesystemProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn().mockReturnValue({ dispose: vi.fn() })
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))

const { getPtyIdsForConnection } = await import('../ipc/pty')

describe('SSH relay orphaned PTY reaping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
  })

  it('reaps orphaned remote PTYs on connect and clears the flag once the relay accepts', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockShutdown = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('relay unreachable'))
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue(undefined),
      shutdown: mockShutdown,
      hasPty: vi.fn().mockReturnValue(false),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    vi.mocked(mockStore.claimSshRemotePtyLeasesToReap).mockReturnValue(['pty-dead', 'pty-stuck'])

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockShutdown).toHaveBeenCalledWith('ssh:target-1@@pty-dead', {
      immediate: true,
      keepHistory: false
    })
    expect(mockStore.clearSshRemotePtyLeaseReapFlag).toHaveBeenCalledWith('target-1', 'pty-dead')
    // Why: a failed kill keeps its flag, so the next connect retries it.
    expect(mockStore.clearSshRemotePtyLeaseReapFlag).not.toHaveBeenCalledWith(
      'target-1',
      'pty-stuck'
    )
  })

  it('spares a flagged id this connection is live on, since a reset relay reuses pty-N', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const { getSshPtyProvider } = await import('../ipc/pty')
    const mockShutdown = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue(undefined),
      shutdown: mockShutdown,
      hasPty: vi.fn().mockImplementation((id: string) => id === 'ssh:target-1@@pty-1'),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    vi.mocked(mockStore.claimSshRemotePtyLeasesToReap).mockReturnValue(['pty-1'])

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockShutdown).not.toHaveBeenCalled()
    expect(mockStore.clearSshRemotePtyLeaseReapFlag).toHaveBeenCalledWith('target-1', 'pty-1')
  })

  it('treats an already-gone remote PTY as a successful reap', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const { getSshPtyProvider } = await import('../ipc/pty')
    const notFound = new Error('PTY "pty-gone" not found')
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockRejectedValue(notFound),
      hasPty: vi.fn().mockReturnValue(false),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    vi.mocked(mockStore.claimSshRemotePtyLeasesToReap).mockReturnValue(['pty-gone'])

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(mockStore.clearSshRemotePtyLeaseReapFlag).toHaveBeenCalledWith('target-1', 'pty-gone')
  })
})
