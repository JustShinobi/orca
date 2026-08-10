import { afterEach, describe, expect, it, vi } from 'vitest'
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

// Why: pins that submit confirmation survives the federated host<->client wire
// boundary (issue #13439 follow-up) in both directions of version skew.
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

  it('marks the remote attachment submitted when the host confirms the terminal turn started', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
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
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_remote_worker',
      accepted: true,
      bytesWritten: 1,
      submitted: 'confirmed'
    })
    const method = attachStartMethod()

    const result = (await method.handler(
      method.params!.parse({
        dispatchId: 'ctx_remote_confirmed',
        taskId: 'task_remote_confirmed',
        taskSpec: 'remote confirmed worker',
        protocolVersion: 1,
        worktree: 'id:repo::remote-worktree',
        agent: 'codex'
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'home_peer',
          requestId: 'request_remote_confirmed',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'remote_payload'
        }
      }
    )) as { state: string; stage: string; effects: { kind?: string; state?: string }[] }

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

  it('carries a confirmed remote stage into the client-visible worker stage', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Confirmed remote worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'confirmed remote work', runId: run.id })
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
          return {
            dispatchId: (params as { dispatchId: string }).dispatchId,
            state: 'ready',
            runtimeEpoch: 'windows_epoch',
            worktreeId: 'repo::windows-worktree',
            terminalHandle: 'term_windows_worker',
            stage: WORKER_PROMPT_SUBMITTED_STAGE
          }
        }
        throw new Error(`Unexpected call: ${method}`)
      }
    )

    const receipt = (await startFederatedWorker({
      params: {
        task: task.id,
        from: 'term_coord',
        on: 'windows',
        worktree: 'new-top-level',
        repo: 'id:windows-repo',
        name: 'confirmed-worker',
        agent: 'codex'
      },
      runtime,
      db,
      runId: run.id,
      task,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: 'confirmed_request',
        method: 'orchestration.workerStart',
        payloadHash: 'payload'
      }
    })) as { state: string; stage: string }

    expect(receipt).toMatchObject({ state: 'ready', stage: WORKER_PROMPT_SUBMITTED_STAGE })
    const dispatch = db.getDispatchContext(task.id)!
    expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({
      stage: WORKER_PROMPT_SUBMITTED_STAGE
    })
  })

  it('keeps a remote worker unverified when the host predates submit confirmation', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Legacy host',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work on an older host', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_legacy',
      name: 'legacy-host',
      peerFingerprint: 'legacy_peer'
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
          // Why: an older host's receipt type has no `stage` field at all — not
          // just an empty value — pinning that a missing field means unverified.
          return {
            dispatchId: (params as { dispatchId: string }).dispatchId,
            state: 'ready',
            runtimeEpoch: 'legacy_host_epoch',
            worktreeId: 'repo::legacy-worktree',
            terminalHandle: 'term_legacy_worker'
          }
        }
        throw new Error(`Unexpected call: ${method}`)
      }
    )

    const receipt = (await startFederatedWorker({
      params: {
        task: task.id,
        from: 'term_coord',
        on: 'legacy-host',
        worktree: 'new-top-level',
        repo: 'id:legacy-repo',
        name: 'legacy-worker',
        agent: 'codex'
      },
      runtime,
      db,
      runId: run.id,
      task,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: 'legacy_host_request',
        method: 'orchestration.workerStart',
        payloadHash: 'payload'
      }
    })) as { state: string; stage: string }

    expect(receipt).toMatchObject({ state: 'ready', stage: WORKER_INPUT_ACCEPTED_STAGE })
    const dispatch = db.getDispatchContext(task.id)!
    expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({ stage: WORKER_INPUT_ACCEPTED_STAGE })
  })
})
