import { describe, expect, it } from 'vitest'
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

  // Why: workerStart blocks server-side for up to the server default (60 s) even
  // when the caller omits --timeout-ms, so the client deadline must still widen.
  it('falls back to the workerStart 60 s default when timeoutMs is omitted', () => {
    expect(resolveLongPollInnerBudgetMs('orchestration.workerStart', {})).toBe(60_000)
    expect(resolveLongPollInnerBudgetMs('orchestration.workerStart', undefined)).toBe(60_000)
  })
})
