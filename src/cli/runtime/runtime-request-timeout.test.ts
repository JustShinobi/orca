import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_WORKER_START_DEFAULT_TIMEOUT_MS } from '../../shared/orchestration-worker-start-timeout'
import { resolveLongPollInnerBudgetMs } from './runtime-request-timeout'

describe('resolveLongPollInnerBudgetMs', () => {
  it('returns 0 for a short RPC', () => {
    expect(resolveLongPollInnerBudgetMs('status.get', {})).toBe(0)
    expect(resolveLongPollInnerBudgetMs('orchestration.send', { subject: 'x' })).toBe(0)
  })

  it('reads the explicit budget for terminal.wait and waiting check', () => {
    expect(resolveLongPollInnerBudgetMs('terminal.wait', { timeoutMs: 250 })).toBe(250)
    expect(resolveLongPollInnerBudgetMs('orchestration.check', { wait: true, timeoutMs: 90 })).toBe(
      90
    )
  })

  it('does not widen a non-waiting check', () => {
    expect(resolveLongPollInnerBudgetMs('orchestration.check', { timeoutMs: 90 })).toBe(0)
  })

  it('uses the explicit workerStart budget when provided', () => {
    expect(resolveLongPollInnerBudgetMs('orchestration.workerStart', { timeoutMs: 120_000 })).toBe(
      120_000
    )
  })

  it('falls back to the workerStart 60 s default when timeoutMs is omitted', () => {
    expect(resolveLongPollInnerBudgetMs('orchestration.workerStart', {})).toBe(
      ORCHESTRATION_WORKER_START_DEFAULT_TIMEOUT_MS
    )
    expect(resolveLongPollInnerBudgetMs('orchestration.workerStart', undefined)).toBe(
      ORCHESTRATION_WORKER_START_DEFAULT_TIMEOUT_MS
    )
  })
})
