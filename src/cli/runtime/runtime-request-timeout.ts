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

// Why: handlers that block on an external event past the 30 s socket idle cap.
// When the caller omits timeoutMs, some still need a widened deadline — keyed by
// their server-side default wait. orchestration.workerStart waits up to 60 s for
// the spawned agent to reach tui-idle before responding.
const LONG_POLL_DEFAULT_TIMEOUT_MS: Record<string, number> = {
  'orchestration.workerStart': 60_000
}

// Why: returns the inner waiter budget the client socket deadline must outlive, or
// 0 when the method is not a long-poll. terminal.wait / check --wait require an
// explicit timeoutMs to widen (no implicit default); workerStart defaults to 60 s.
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
