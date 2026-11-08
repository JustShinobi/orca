import type { FederatedWorkerStartRequest } from './federated-worker-start-request'
import { ORCHESTRATION_WORKER_TURN_STOP_REPORTS_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { resolveFederatedWorkerLaunchReceipt } from '../worker/worker-launch-preferences'
import { resolveDispatchCreator } from '../runs/dispatch-creator'
import {
  isReadyRemoteFederatedWorkerStartReceipt,
  parseRemoteFederatedWorkerStartReceipt
} from './federated-attach-receipt'
import {
  federatedFailedReceipt,
  federatedUnknownReceipt,
  isKnownRemoteStartFailure,
  recoveryFromError
} from './federated-worker-start-receipts'
import {
  remoteWorkerReadyStage,
  WORKER_PROMPT_SUBMITTED_STAGE
} from '../../../../orchestration/worker-dispatch-stages'
import { releaseRetriedWorkerTerminal } from '../worker/retried-worker-terminal-release'
import { withWorkerStartNext } from '../receipt-next'
import { prepareWorkerStartCard } from '../../../../orchestration/workers/launch/worker-start-card'
import {
  recordWorkerLaunchObservation,
  workerLaunchAgent
} from '../../../../orchestration/workers/launch/worker-launch-observation'
import { preflightFederatedWorkerStart } from './federated-worker-start-preflight'

export async function startFederatedWorker(args: FederatedWorkerStartRequest): Promise<unknown> {
  const { params, runtime, db, task, orchestrationMutation } = args
  const recordStart = prepareWorkerStartCard(runtime, args.callerSession)
  const {
    worktree,
    createsWorktree,
    requestedLaunch,
    server,
    pairingFence,
    budgets,
    childParent,
    federationProtocolVersion,
    status,
    mutation
  } = await preflightFederatedWorkerStart(
    params,
    runtime,
    orchestrationMutation,
    args.callerSession
  )

  const setupDecision = createsWorktree ? (params.setup ?? 'run') : 'not_applicable'
  const runId = args.bindRunId()
  const started = db.createStartingWorkerDispatch({
    creator: resolveDispatchCreator(runtime, params.from, args.callerSession),
    maxDepth: runtime.getNestedWorkerMaxDepth(),
    taskId: task?.id,
    taskSpec: params.spec,
    taskTitle: params.taskTitle,
    taskDeps: args.taskDeps,
    taskParentId: params.parent,
    taskRunId: runId,
    retryOf: params.retryOf,
    startOptions: {
      on: server.environmentId,
      serverName: server.name,
      worktree,
      name: params.name ?? null,
      repo: params.repo ?? null,
      baseBranch: params.baseBranch ?? null,
      terminal: params.terminal ?? null,
      agent: params.agent ?? null,
      launch: requestedLaunch,
      timeoutMs: budgets.readinessTimeoutMs,
      setup: setupDecision,
      setupSource: createsWorktree
        ? params.setup
          ? 'explicit_request'
          : 'orchestration_default'
        : 'existing_worktree'
    },
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: mutation,
    federation: {
      environmentId: server.environmentId,
      environmentName: server.name,
      peerFingerprint: server.peerFingerprint,
      protocolVersion: federationProtocolVersion
    }
  })
  // A remote retry can replace a failed local attempt whose terminal is still live here.
  releaseRetriedWorkerTerminal(runtime, db, { retryOf: params.retryOf })
  const createdTask = started.task
  const taskForRemote = task ?? createdTask
  db.recordWorkerStage({ dispatchId: started.dispatch.id, stage: 'remote_attach_requested' })
  let readyResult: unknown
  let launch = requestedLaunch
  try {
    const remote = parseRemoteFederatedWorkerStartReceipt(
      await runtime.callOrchestrationWorkerServer(
        server.environmentId,
        'orchestration.federationAttachStart',
        {
          runId,
          dispatchId: started.dispatch.id,
          taskId: taskForRemote.id,
          taskSpec: taskForRemote.spec,
          // Carry home dispatch depth so remote workers cannot re-enter as roots when nesting.
          depth: started.dispatch.depth,
          protocolVersion: federationProtocolVersion,
          // A server creates new-child as top-level plus this parent, so older servers parse it too.
          worktree: createsWorktree ? 'new-top-level' : worktree,
          ...(childParent && 'crossStoreParent' in childParent
            ? { crossStoreParent: childParent.crossStoreParent }
            : {}),
          name: params.name,
          repo: params.repo,
          baseBranch: params.baseBranch,
          displayName: params.displayName,
          ...(params.displayName !== undefined ? { displayNameKind: 'user' as const } : {}),
          comment: params.comment,
          setup: createsWorktree ? (params.setup ?? 'run') : undefined,
          setupSource: createsWorktree
            ? params.setup
              ? 'explicit_request'
              : 'orchestration_default'
            : undefined,
          terminal: params.terminal,
          agent: params.agent,
          model: params.model,
          effort: params.effort,
          timeoutMs: budgets.readinessTimeoutMs,
          devMode: params.devMode
        },
        budgets.attachDeadlineMs,
        { orchestrationRequestId: mutation.requestId },
        { contractVerified: true, ...pairingFence }
      )
    )
    if (remote.dispatchId !== started.dispatch.id) {
      throw new OrchestrationError(
        'resource_server_mismatch',
        'The worker server returned a different Dispatch attachment.'
      )
    }
    recordWorkerLaunchObservation(db, started.dispatch.id, remote.launch)
    launch = resolveFederatedWorkerLaunchReceipt(
      remote.launch,
      requestedLaunch,
      remote.state === 'ready'
    )
    if (isReadyRemoteFederatedWorkerStartReceipt(remote)) {
      db.updateFederatedDispatchResources({
        dispatchId: started.dispatch.id,
        remoteRuntimeEpoch: remote.runtimeEpoch,
        worktreeId: remote.worktreeId,
        terminalHandle: remote.terminalHandle
      })
      // Why: an older host has no submit confirmation and reports the old stage,
      // so an unrecognized stage means unverified — never failed.
      const remoteSubmitted =
        remote.stage === WORKER_PROMPT_SUBMITTED_STAGE ? 'confirmed' : 'unverified'
      db.recordWorkerStage({
        dispatchId: started.dispatch.id,
        stage: remoteWorkerReadyStage(remoteSubmitted),
        worktreeId: remote.worktreeId,
        terminalHandle: remote.terminalHandle,
        setupState: remote.setup?.state,
        effects: remote.effects,
        residualResources: remote.residualResources
      })
      const readyWorker = db.markWorkerDispatchReady(
        started.dispatch.id,
        undefined,
        remoteSubmitted
      )
      runtime.ensureOrchestrationFederationRelay(runId)
      const reportsTurnStops = status.capabilities?.includes(
        ORCHESTRATION_WORKER_TURN_STOP_REPORTS_RUNTIME_CAPABILITY
      )
      readyResult = withWorkerStartNext(
        {
          runId,
          taskId: taskForRemote.id,
          dispatchId: started.dispatch.id,
          state: 'ready',
          stage: readyWorker.stage,
          server: { environmentId: server.environmentId, name: server.name },
          setup: remote.setup,
          launch,
          timeoutMs: budgets.readinessTimeoutMs,
          effects: remote.effects ?? [],
          residualResources: remote.residualResources ?? [],
          ...(childParent && 'warning' in childParent ? { warning: childParent.warning } : {})
        },
        reportsTurnStops
          ? undefined
          : {
              name: server.name,
              dispatchId: started.dispatch.id,
              cli: params.from ? runtime.getTerminalOrchestrationCliCommand(params.from) : 'orca'
            }
      )
    } else if (remote.state === 'outcome_unknown') {
      const worker = db.markWorkerStartUnknown(
        started.dispatch.id,
        remote.failedStage ?? 'remote_attach',
        remote.lastError ?? 'The worker server reported an unknown start outcome.'
      )
      return federatedUnknownReceipt(worker, taskForRemote.id, server.name, launch, remote.recovery)
    } else {
      const worker = db.failWorkerStart(
        started.dispatch.id,
        remote.failedStage ?? 'remote_attach',
        remote.lastError ?? `The worker server returned ${remote.state}.`
      )
      return federatedFailedReceipt(worker, { runId, taskId: taskForRemote.id }, server, {
        setup: remote.setup,
        launch,
        effects: remote.effects,
        residualResources: remote.residualResources,
        recovery: remote.recovery
      })
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const recovery = recoveryFromError(error)
    if (error instanceof OrchestrationError && isKnownRemoteStartFailure(error.code)) {
      const worker = db.failWorkerStart(started.dispatch.id, 'remote_attach', reason)
      return federatedFailedReceipt(worker, { runId, taskId: taskForRemote.id }, server, {
        launch: requestedLaunch,
        recovery
      })
    }
    const worker = db.markWorkerStartUnknown(started.dispatch.id, 'remote_attach', reason)
    return federatedUnknownReceipt(worker, taskForRemote.id, server.name, requestedLaunch, recovery)
  }
  if (!params.terminal) {
    recordStart({
      dispatchId: started.dispatch.id,
      workerAddress: `dispatch:${started.dispatch.id}`,
      task: taskForRemote.spec,
      agent: workerLaunchAgent(launch) ?? workerLaunchAgent(requestedLaunch)
    })
  }
  return readyResult
}
