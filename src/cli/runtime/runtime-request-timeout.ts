import { ORCHESTRATION_WORKER_START_DEFAULT_TIMEOUT_MS } from '../../shared/orchestration-worker-start-timeout'

export function isWaitingCheck(params: unknown): boolean {
  return (
    typeof params === 'object' &&
    params !== null &&
    'wait' in params &&
    (params as { wait: unknown }).wait === true
  )
}

export function getTimeoutMsParam(params: unknown): unknown {
  if (typeof params !== 'object' || params === null || !('timeoutMs' in params)) {
    return undefined
  }
  return (params as { timeoutMs?: unknown }).timeoutMs
}

const LONG_POLL_DEFAULT_TIMEOUT_MS: Record<string, number> = {
  'orchestration.workerStart': ORCHESTRATION_WORKER_START_DEFAULT_TIMEOUT_MS
}

// Why: the client socket must outlive the authoritative server-side waiter budget.
export function resolveLongPollInnerBudgetMs(method: string, params: unknown): number {
  const isLongPoll =
    method === 'terminal.wait' ||
    method === 'orchestration.workerStart' ||
    (method === 'orchestration.check' && isWaitingCheck(params))
  if (!isLongPoll) {
    return 0
  }
  const raw = Number(getTimeoutMsParam(params))
  if (Number.isFinite(raw) && raw > 0) {
    return raw
  }
  return LONG_POLL_DEFAULT_TIMEOUT_MS[method] ?? 0
}
