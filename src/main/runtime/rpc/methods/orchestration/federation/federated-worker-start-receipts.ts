import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrchestrationWorkerLaunchReceipt } from '../worker/worker-launch-preferences'

export function isKnownRemoteStartFailure(code: string): boolean {
  return [
    'invalid_argument',
    'agent_unconfigured',
    'worktree_not_found_on_server',
    'terminal_worktree_mismatch',
    'capability_unsupported'
  ].includes(code)
}

// Why: a thrown transport error carries no dispatch_input receipt, but a future host
// may still attach the hint to `data`; relay it if present, never infer it otherwise.
export function recoveryFromError(error: unknown): string | undefined {
  if (
    error instanceof OrchestrationError &&
    typeof error.data === 'object' &&
    error.data !== null &&
    'recovery' in error.data &&
    typeof error.data.recovery === 'string'
  ) {
    return error.data.recovery
  }
  return undefined
}

type FederatedStartWorker = {
  dispatch_id: string
  state: string
  stage: string
  last_error: string | null
}

export function federatedFailedReceipt(
  worker: FederatedStartWorker,
  ids: { runId: string; taskId: string },
  server: { environmentId: string; name: string },
  outcome: {
    launch: OrchestrationWorkerLaunchReceipt
    setup?: { state: string } | unknown
    effects?: unknown[]
    residualResources?: unknown[]
    recovery?: string
  }
): unknown {
  const { recovery, ...rest } = outcome
  return {
    ...ids,
    dispatchId: worker.dispatch_id,
    state: worker.state,
    stage: worker.stage,
    server: { environmentId: server.environmentId, name: server.name },
    failedStage: worker.stage,
    lastError: worker.last_error,
    ...rest,
    effects: outcome.effects ?? [],
    residualResources: outcome.residualResources ?? [],
    ...(recovery ? { recovery } : {})
  }
}

export function federatedUnknownReceipt(
  worker: FederatedStartWorker,
  taskId: string,
  serverName: string,
  launch: OrchestrationWorkerLaunchReceipt,
  recovery?: string
): unknown {
  return {
    taskId,
    dispatchId: worker.dispatch_id,
    state: 'outcome_unknown',
    stage: worker.stage,
    server: { name: serverName },
    launch,
    failedStage: worker.stage,
    lastError: worker.last_error,
    effects: [],
    residualResources: [],
    ...(recovery ? { recovery } : {}),
    nextCommands: [
      `orca orchestration worker-show --dispatch ${worker.dispatch_id} --json`,
      `orca orchestration worker-abandon --dispatch ${worker.dispatch_id} --json`
    ]
  }
}
