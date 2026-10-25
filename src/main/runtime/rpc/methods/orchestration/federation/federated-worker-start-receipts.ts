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

export function federatedFailedReceipt(args: {
  runId: string
  taskId: string
  dispatchId: string
  worker: { state: string; stage: string; last_error: string | null }
  server: { environmentId: string; name: string }
  launch: OrchestrationWorkerLaunchReceipt
  setup?: unknown
  includeSetup?: boolean
  effects?: unknown[]
  residualResources?: unknown[]
  recovery?: string
}): unknown {
  return {
    runId: args.runId,
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    state: args.worker.state,
    stage: args.worker.stage,
    server: { environmentId: args.server.environmentId, name: args.server.name },
    failedStage: args.worker.stage,
    lastError: args.worker.last_error,
    ...(args.includeSetup ? { setup: args.setup } : {}),
    launch: args.launch,
    effects: args.effects ?? [],
    residualResources: args.residualResources ?? [],
    ...(args.recovery ? { recovery: args.recovery } : {})
  }
}

export function federatedUnknownReceipt(
  worker: { dispatch_id: string; state: string; stage: string; last_error: string | null },
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
