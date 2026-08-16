import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { sendRequest, openFramedSession, sleep, waitFor } from './runtime-rpc-test-harness'
import type { AccountsSnapshot } from './orca-runtime'

describe('OrcaRuntimeRpcServer keepalive and admission', () => {
  it('emits keepalive frames while orchestration.workerStart blocks for agent readiness', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const coordinatorPaneKey = 'runtime_test:term_coord:0'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handle === 'term_worker'
          ? 'runtime_test:term_worker:1'
          : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::worktree',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worktree',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'repo',
      kind: 'git'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      title: 'worker'
    } as never)
    vi.spyOn(runtime, 'waitForSetupTerminalCompletion').mockReturnValue(
      new Promise(() => undefined)
    )
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [{ handle: 'term_worker', title: 'Codex' }],
      totalCount: 1,
      truncated: false
    } as never)
    let waitSignal: AbortSignal | undefined
    vi.spyOn(runtime, 'waitForTerminal').mockImplementation(async (_handle, options) => {
      waitSignal = options?.signal
      await sleep(300)
      return {
        handle: 'term_worker',
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      } as never
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    } as never)
    const run = db.createRun({
      objective: 'workerStart keepalive',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    })
    const task = db.createTask({ spec: 'spawn a worker', runId: run.id })
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      keepaliveIntervalMs: 50
    })
    await server.start()

    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const session = openFramedSession(metadata!.transports[0]!.endpoint, {
        id: 'req_worker_start',
        authToken: metadata!.authToken,
        method: 'orchestration.workerStart',
        params: {
          task: task.id,
          from: 'term_coord',
          agent: 'codex',
          timeoutMs: 5000
        }
      })
      await session.done

      const keepalives = session.frames.filter((f) => f._keepalive === true)
      const terminals = session.frames.filter((f) => f.ok !== undefined)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]).toMatchObject({ id: 'req_worker_start', ok: true })
      expect(keepalives.length).toBeGreaterThanOrEqual(3)
      expect(waitSignal).toBeInstanceOf(AbortSignal)
    } finally {
      db.close()
      await server.stop()
    }
  })

  it('arms keepalive for accounts.list without consuming a long-poll slot, leaving terminal.wait admission unaffected', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      keepaliveIntervalMs: 30,
      longPollCap: 1
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Terminal 1',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.onPtyData('pty-1', 'Starting MCP servers...\n', 123)

    let resolveRefresh: () => void = () => {}
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })
    const refreshSpy = vi
      .spyOn(runtime, 'refreshAccountsForMobile')
      .mockImplementation(() => refreshPromise)
    const snapshot = { claude: null, codex: null } as unknown as AccountsSnapshot
    vi.spyOn(runtime, 'getAccountsSnapshot').mockReturnValue(snapshot)

    await server.start()
    const listSessions: ReturnType<typeof openFramedSession>[] = []
    const waits: ReturnType<typeof openFramedSession>[] = []
    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const endpoint = metadata!.transports[0]!.endpoint
      const listResponse = await sendRequest(endpoint, {
        id: 'req_terminal_list',
        authToken: metadata!.authToken,
        method: 'terminal.list'
      })
      const handle = (listResponse.result as { terminals: { handle: string }[] }).terminals[0]!
        .handle

      // Two concurrent accounts.list calls exceed the longPollCap of 1.
      listSessions.push(
        openFramedSession(endpoint, {
          id: 'req_list_a',
          authToken: metadata!.authToken,
          method: 'accounts.list',
          params: { refreshUsage: true }
        }),
        openFramedSession(endpoint, {
          id: 'req_list_b',
          authToken: metadata!.authToken,
          method: 'accounts.list',
          params: { refreshUsage: true }
        })
      )
      await waitFor(() => refreshSpy.mock.calls.length === 2)
      await sleep(100)

      // Neither accounts.list call admitted itself as a long-poll.
      expect(server['activeLongPolls']).toBe(0)

      // terminal.wait admission is unaffected by the two pending accounts.list calls.
      waits.push(
        openFramedSession(endpoint, {
          id: 'req_wait_a',
          authToken: metadata!.authToken,
          method: 'terminal.wait',
          params: { terminal: handle, for: 'tui-idle', timeoutMs: 5_000 }
        })
      )
      await waitFor(() => server['activeLongPolls'] === 1)

      const waitOverflow = await sendRequest(endpoint, {
        id: 'req_wait_overflow',
        authToken: metadata!.authToken,
        method: 'terminal.wait',
        params: { terminal: handle, for: 'tui-idle', timeoutMs: 5_000 }
      })
      expect(waitOverflow).toMatchObject({
        id: 'req_wait_overflow',
        ok: false,
        error: { code: 'runtime_busy' }
      })

      resolveRefresh()
      await Promise.all(listSessions.map((session) => session.done))

      for (const session of listSessions) {
        const terminalFrame = session.frames.find((f) => f.ok !== undefined)
        expect(terminalFrame).toMatchObject({ ok: true, result: snapshot })
        expect(session.frames.some((f) => f._keepalive === true)).toBe(true)
      }
    } finally {
      for (const wait of waits) {
        wait.socket.destroy()
      }
      await Promise.all(waits.map((wait) => wait.done))
      await server.stop()
    }
  })
})
