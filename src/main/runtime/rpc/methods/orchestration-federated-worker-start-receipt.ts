import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrchestrationWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'

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
  if (!(error instanceof OrchestrationError)) {
    return undefined
  }
  const data = error.data as { recovery?: unknown } | undefined
  return typeof data?.recovery === 'string' ? data.recovery : undefined
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
