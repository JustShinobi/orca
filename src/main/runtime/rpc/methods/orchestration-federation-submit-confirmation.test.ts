import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalSend } from '../../../../shared/runtime-types'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import {
  WORKER_INPUT_ACCEPTED_STAGE,
  WORKER_PROMPT_SUBMITTED_STAGE
} from '../../orchestration/worker-dispatch-stages'
import { ORCHESTRATION_METHODS } from './orchestration'
import { startFederatedWorker } from './orchestration-federated-worker-start'

type AttachStartResponse = Record<string, unknown>

// Why: pins that submit confirmation, and the recovery hint it can produce on
// failure, both survive the federated host<->client wire boundary (issue #13439
// follow-up) in both directions of version skew.
describe('federated worker submit confirmation', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  function attachStartMethod() {
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )
    if (!method) {
      throw new Error('federationAttachStart method is not registered')
    }
    return method
  }

  // Why: shared by the confirmed and unverified host-side cases — only the
  // sendTerminalAgentPrompt resolution differs between them.
  function setupHostRuntime(send: RuntimeTerminalSend): {
    db: OrchestrationDb
    runtime: OrcaRuntimeService
  } {
    const hostDb = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(hostDb)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::remote-worktree'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      worktreeId: 'repo::remote-worktree',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_remote_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_remote:leaf_remote')
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(
      'runtime_test:term_remote_worker:1'
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue(send)
    return { db: hostDb, runtime }
  }

  async function attachStart(runtime: OrcaRuntimeService, dispatchId: string, taskId: string) {
    return attachStartMethod().handler(
      attachStartMethod().params!.parse({
        dispatchId,
        taskId,
        taskSpec: 'remote worker',
        protocolVersion: 1,
        worktree: 'id:repo::remote-worktree',
        agent: 'codex'
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'home_peer',
          requestId: `request_${dispatchId}`,
          method: 'orchestration.federationAttachStart',
          payloadHash: 'remote_payload'
        }
      }
    ) as Promise<{ state: string; stage: string; effects: { kind?: string; state?: string }[] }>
  }

  // Why: shared by every client-side case — only the mocked federationAttachStart
  // response and the request identifiers differ between them.
  function setupClientRuntime(response: AttachStartResponse): {
    db: OrchestrationDb
    runtime: OrcaRuntimeService
    runId: string
    task: { id: string; spec: string; status: string }
  } {
    const clientDb = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(clientDb)
    const run = clientDb.createRun({
      objective: 'Federated submit confirmation',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = clientDb.createTask({ spec: 'federated worker', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_windows',
      name: 'windows',
      peerFingerprint: 'windows_peer'
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_selector, method, params) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
            ]
          }
        }
        if (method === 'orchestration.federationAttachStart') {
          return { dispatchId: (params as { dispatchId: string }).dispatchId, ...response }
        }
        throw new Error(`Unexpected call: ${method}`)
      }
    )
    return { db: clientDb, runtime, runId: run.id, task }
  }

  async function startWorker(created: ReturnType<typeof setupClientRuntime>, requestId: string) {
    return startFederatedWorker({
      params: {
        task: created.task.id,
        from: 'term_coord',
        on: 'windows',
        worktree: 'new-top-level',
        repo: 'id:windows-repo',
        name: requestId,
        agent: 'codex'
      },
      runtime: created.runtime,
      db: created.db,
      runId: created.runId,
      task: created.task,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId,
        method: 'orchestration.workerStart',
        payloadHash: 'payload'
      }
    }) as Promise<Record<string, unknown>>
  }

  it('marks the remote attachment submitted when the host confirms the terminal turn started', async () => {
    const created = setupHostRuntime({
      handle: 'term_remote_worker',
      accepted: true,
      bytesWritten: 1,
      submitted: 'confirmed'
    })
    db = created.db

    const result = await attachStart(
      created.runtime,
      'ctx_remote_confirmed',
      'task_remote_confirmed'
    )

    expect(result).toMatchObject({ state: 'ready', stage: WORKER_PROMPT_SUBMITTED_STAGE })
    expect(
      result.effects.some(
        (effect) => effect.kind === 'dispatch_input' && effect.state === 'submitted'
      )
    ).toBe(true)
    expect(db.getRemoteDispatchAttachment('ctx_remote_confirmed')).toMatchObject({
      state: 'ready',
      stage: WORKER_PROMPT_SUBMITTED_STAGE
    })
  })

  it('keeps the remote attachment unverified when the host runtime omits submitted', async () => {
    // Why: Finding 2 — a relayed terminal on an older provider returns no `submitted`;
    // inverting the `?? 'unverified'` default would mislabel it confirmed.
    const created = setupHostRuntime({
      handle: 'term_remote_worker',
      accepted: true,
      bytesWritten: 1
    })
    db = created.db

    const result = await attachStart(
      created.runtime,
      'ctx_remote_unverified',
      'task_remote_unverified'
    )

    expect(result).toMatchObject({ state: 'ready', stage: WORKER_INPUT_ACCEPTED_STAGE })
    expect(
      result.effects.some(
        (effect) => effect.kind === 'dispatch_input' && effect.state === 'accepted'
      )
    ).toBe(true)
    expect(db.getRemoteDispatchAttachment('ctx_remote_unverified')).toMatchObject({
      state: 'ready',
      stage: WORKER_INPUT_ACCEPTED_STAGE
    })
  })

  it('carries a confirmed remote stage into the client-visible worker stage', async () => {
    const created = setupClientRuntime({
      state: 'ready',
      runtimeEpoch: 'windows_epoch',
      worktreeId: 'repo::windows-worktree',
      terminalHandle: 'term_windows_worker',
      stage: WORKER_PROMPT_SUBMITTED_STAGE
    })
    db = created.db

    const receipt = await startWorker(created, 'confirmed_request')

    expect(receipt).toMatchObject({ state: 'ready', stage: WORKER_PROMPT_SUBMITTED_STAGE })
    const dispatch = db.getDispatchContext(created.task.id)!
    expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({
      stage: WORKER_PROMPT_SUBMITTED_STAGE
    })
  })

  it('keeps a remote worker unverified when the host predates submit confirmation', async () => {
    // Why: an older host's receipt type has no `stage` field at all — not just an
    // empty value — pinning that a missing field means unverified.
    const created = setupClientRuntime({
      state: 'ready',
      runtimeEpoch: 'legacy_host_epoch',
      worktreeId: 'repo::legacy-worktree',
      terminalHandle: 'term_legacy_worker'
    })
    db = created.db

    const receipt = await startWorker(created, 'legacy_host_request')

    expect(receipt).toMatchObject({ state: 'ready', stage: WORKER_INPUT_ACCEPTED_STAGE })
    const dispatch = db.getDispatchContext(created.task.id)!
    expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({ stage: WORKER_INPUT_ACCEPTED_STAGE })
  })

  it('relays the host dispatch_input recovery hint across the client boundary', async () => {
    // Why: Finding 1 — without this, a coordinator reading "no recovery field" as
    // "nothing was written" would re-dispatch and duplicate the user's prompt.
    const created = setupClientRuntime({
      state: 'failed',
      runtimeEpoch: 'windows_epoch',
      failedStage: 'dispatch_input',
      lastError: 'Enter never registered (agent_prompt_buffered_not_submitted)',
      recovery: 'buffered_not_submitted'
    })
    db = created.db

    const receipt = await startWorker(created, 'buffered_request')

    expect(receipt).toMatchObject({ state: 'failed', recovery: 'buffered_not_submitted' })
  })

  it('never invents a recovery hint the host did not send', async () => {
    const created = setupClientRuntime({
      state: 'failed',
      runtimeEpoch: 'windows_epoch',
      failedStage: 'setup_wait',
      lastError: 'Setup hook failed.'
    })
    db = created.db

    const receipt = await startWorker(created, 'setup_failed_request')

    expect(receipt).toMatchObject({ state: 'failed' })
    expect(receipt).not.toHaveProperty('recovery')
  })
})
