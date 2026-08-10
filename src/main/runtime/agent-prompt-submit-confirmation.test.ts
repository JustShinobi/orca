import { describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BUFFERED_NOT_SUBMITTED } from '../../shared/agent-prompt-submission'
import {
  AGENT_PROMPT_SUBMIT_ATTEMPTS,
  submitAgentPromptWithConfirmation,
  type AgentPromptReadiness
} from './agent-prompt-submit-confirmation'

function makeDeps(readings: (AgentPromptReadiness | null)[]) {
  const submits = vi.fn(async () => {})
  let index = 0
  return {
    submits,
    deps: {
      readReadiness: async () => readings[Math.min(index++, readings.length - 1)] ?? null,
      writeSubmit: submits,
      wait: async () => {}
    }
  }
}

const idle: AgentPromptReadiness = {
  isRunningAgent: true,
  status: 'idle',
  explicitUpdatedAt: null
}
const working: AgentPromptReadiness = {
  isRunningAgent: true,
  status: 'working',
  explicitUpdatedAt: null
}

describe('submitAgentPromptWithConfirmation', () => {
  it('confirms when the agent leaves idle after the submit', async () => {
    const { deps, submits } = makeDeps([idle, working])
    await expect(submitAgentPromptWithConfirmation(deps)).resolves.toBe('confirmed')
    expect(submits).toHaveBeenCalledTimes(1)
  })

  it('confirms from a fresh hook timestamp when the turn finishes between polls', async () => {
    const { deps, submits } = makeDeps([
      { isRunningAgent: true, status: 'idle', explicitUpdatedAt: 100 },
      { isRunningAgent: true, status: 'idle', explicitUpdatedAt: 400 }
    ])
    await expect(submitAgentPromptWithConfirmation(deps)).resolves.toBe('confirmed')
    expect(submits).toHaveBeenCalledTimes(1)
  })

  it('retries only the submit when the agent stays idle, and never re-sends the body', async () => {
    const { deps, submits } = makeDeps([idle])
    await expect(submitAgentPromptWithConfirmation(deps)).rejects.toThrow(
      AGENT_PROMPT_BUFFERED_NOT_SUBMITTED
    )
    expect(submits).toHaveBeenCalledTimes(AGENT_PROMPT_SUBMIT_ATTEMPTS)
    expect(submits.mock.calls.every((call) => call.length === 0)).toBe(true)
  })

  it('degrades to a single blind write when no status signal exists', async () => {
    const { deps, submits } = makeDeps([null])
    await expect(submitAgentPromptWithConfirmation(deps)).resolves.toBe('unverified')
    expect(submits).toHaveBeenCalledTimes(1)
  })

  it('does not fail a dispatch to an agent that was already working', async () => {
    const { deps } = makeDeps([working])
    await expect(submitAgentPromptWithConfirmation(deps)).resolves.toBe('unverified')
  })

  it('waits out a permission prompt instead of answering it with Enter', async () => {
    const { deps, submits } = makeDeps([
      { isRunningAgent: true, status: 'permission', explicitUpdatedAt: null },
      { isRunningAgent: true, status: 'permission', explicitUpdatedAt: null },
      idle,
      working
    ])
    await expect(submitAgentPromptWithConfirmation(deps)).resolves.toBe('confirmed')
    expect(submits).toHaveBeenCalledTimes(1)
  })
})
