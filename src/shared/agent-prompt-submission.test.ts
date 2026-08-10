import { describe, expect, it } from 'vitest'
import {
  AGENT_PROMPT_BUFFERED_NOT_SUBMITTED,
  buildBufferedNotSubmittedError,
  classifyDispatchInputRecovery
} from './agent-prompt-submission'

describe('agent prompt submission outcome', () => {
  it('keeps the original cause searchable so existing error assertions still match', () => {
    const error = buildBufferedNotSubmittedError('terminal_not_writable')
    expect(error.message).toContain('terminal_not_writable')
    expect(error.message).toContain(AGENT_PROMPT_BUFFERED_NOT_SUBMITTED)
  })

  it('classifies a buffered body as unsafe to re-dispatch', () => {
    expect(classifyDispatchInputRecovery(buildBufferedNotSubmittedError('boom'))).toBe(
      'buffered_not_submitted'
    )
  })

  it('classifies every other dispatch failure as nothing written', () => {
    expect(classifyDispatchInputRecovery(new Error('terminal_not_writable'))).toBe('nothing_written')
    expect(classifyDispatchInputRecovery('terminal_gone')).toBe('nothing_written')
  })

  it('never emits words the federated unknown-outcome classifier reacts to', () => {
    expect(AGENT_PROMPT_BUFFERED_NOT_SUBMITTED).not.toMatch(
      /connection|disconnect|timed?\s*out|runtime changed|outcome unknown/i
    )
  })
})
