import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'

function makeSummary(
  handle: string,
  opts: Partial<RuntimeTerminalSummary> = {}
): RuntimeTerminalSummary {
  return {
    handle,
    ptyId: opts.ptyId ?? handle,
    worktreeId: opts.worktreeId ?? 'wt_default',
    worktreePath: opts.worktreePath ?? '/tmp/wt',
    branch: opts.branch ?? 'main',
    tabId: opts.tabId ?? 'tab_1',
    leafId: opts.leafId ?? handle,
    title: opts.title ?? null,
    connected: opts.connected ?? true,
    writable: opts.writable ?? true,
    lastOutputAt: opts.lastOutputAt ?? null,
    preview: opts.preview ?? ''
  }
}

describe('orchestration RPC send target warnings', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = h
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string | undefined

  function setup(withBoundRun = true): void {
    ;({ db, runtime, ctx, activeRunId } = h.setup(withBoundRun))
  }

  function setupWithTerminals(terminals: RuntimeTerminalSummary[]): void {
    setup(true)
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals,
      totalCount: terminals.length,
      truncated: false
    })
  }

  afterEach(() => {
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  it('refuses a bare terminal handle no reader holds', async () => {
    setup()
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(null)

    await expect(
      call('orchestration.send', {
        from: 'term_coord',
        to: 'term_ghost',
        subject: 'unreachable'
      })
    ).rejects.toThrow('Terminal term_ghost was not found.')
  })

  it('accepts an active Dispatch assignee without a pane and warns that nothing is live', async () => {
    setup(false)
    const task = db.createTask({ spec: 'work with no resolvable pane' })
    db.createDispatchContext(task.id, 'term_worker')
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to: 'term_worker',
      subject: 'how is it going?',
      type: 'status'
    })) as { message: { to_handle: string }; warnings: { code: string; recipient: string }[] }

    expect(result.message.to_handle).toBe('term_worker')
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'no_live_terminal', recipient: 'term_worker' })
    ])
    expect(db.getUnreadMessages('term_worker')).toHaveLength(1)
  })

  it('warns that a live worker reads its Dispatch mailbox, not its handle', async () => {
    setup()
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker', 'tab_worker:leaf_worker')
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : 'tab_worker:leaf_worker'
    )
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

    const result = (await call('orchestration.send', {
      from: 'term_coord',
      to: 'term_worker',
      subject: 'status ping'
    })) as { warnings: { code: string; message: string }[] }

    expect(result.warnings[0].code).toBe('recipient_reads_other_mailbox')
    expect(result.warnings[0].message).toContain(`dispatch:${dispatch.id}`)

    const workerCheck = (await call('orchestration.check', {
      terminal: 'term_worker'
    })) as { count: number; dispatchId?: string }
    expect(workerCheck).toMatchObject({ count: 1, dispatchId: dispatch.id })
  })

  it('warns that a coordinator reads its Run mailbox, not its handle', async () => {
    setup()
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

    const result = (await call('orchestration.send', {
      from: 'term_worker',
      to: 'term_coord',
      subject: 'status ping'
    })) as { warnings: { code: string; message: string }[] }

    expect(result.warnings[0].code).toBe('recipient_reads_other_mailbox')
    expect(result.warnings[0].message).toContain(`run:${activeRunId}`)
  })

  it('warns when a coordinator handle that run-use replaced is addressed', async () => {
    setup()
    const newPane = 'tab_new:22222222-2222-4222-9222-222222222222'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : newPane
    )
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
    db.bindRun({
      runId: activeRunId as string,
      coordinatorHandle: 'term_new',
      coordinatorPaneKey: newPane
    })

    const result = (await call('orchestration.send', {
      from: 'term_new',
      to: 'term_coord',
      subject: 'handover mail'
    })) as { warnings: { code: string; recipient: string }[] }

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'recipient_outside_run', recipient: 'term_coord' })
    ])
    // The routed message lands in the Run mailbox.
    const runMailbox = (await call('orchestration.check', {
      terminal: 'term_new',
      all: true
    })) as { count: number }
    expect(runMailbox.count).toBe(1)
  })

  it('reports no warnings for a live terminal outside any Run', async () => {
    setup(false)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_plain' ? 'tab_plain:33333333-3333-4333-8333-333333333333' : null
    )
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

    const result = (await call('orchestration.send', {
      from: 'term_sender',
      to: 'term_plain',
      subject: 'plain mail'
    })) as Record<string, unknown>

    expect(result.warnings).toBeUndefined()
    expect(db.getUnreadMessages('term_plain')).toHaveLength(1)
  })

  it('names the fan-out recipients whose check will not return the row', async () => {
    setupWithTerminals([
      makeSummary('term_sender', { tabId: 'tab_sender', leafId: 'leaf_sender' }),
      makeSummary('term_coord', { tabId: 'tab_coord', leafId: 'leaf_coord' }),
      makeSummary('term_worker', { tabId: 'tab_worker', leafId: 'leaf_worker' })
    ])
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker', 'tab_worker:leaf_worker')
    const panes: Record<string, string> = {
      term_coord: coordinatorPaneKey,
      term_worker: 'tab_worker:leaf_worker',
      term_sender: 'tab_sender:leaf_sender'
    }
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => panes[handle] ?? null)

    const result = (await call('orchestration.send', {
      from: 'term_sender',
      to: '@all',
      subject: 'broadcast'
    })) as {
      recipients: number
      warnings: { code: string; recipient: string; message: string }[]
    }

    expect(result.recipients).toBe(2)
    expect(result.warnings.map((warning) => warning.recipient).sort()).toEqual([
      'term_coord',
      'term_worker'
    ])
    expect(
      result.warnings.every((warning) => warning.code === 'recipient_reads_other_mailbox')
    ).toBe(true)

    const coordCheck = (await call('orchestration.check', {
      terminal: 'term_coord',
      all: true
    })) as { count: number }
    const workerCheck = (await call('orchestration.check', {
      terminal: 'term_worker',
      all: true
    })) as { count: number; dispatchId: string }
    expect(coordCheck.count).toBe(1)
    expect(workerCheck).toMatchObject({ count: 1, dispatchId: dispatch.id })
  })
})
