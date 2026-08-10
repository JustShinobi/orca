import {
  AGENT_PROMPT_BUFFERED_NOT_SUBMITTED,
  type AgentPromptSubmitOutcome
} from '../../shared/agent-prompt-submission'

export type AgentPromptReadiness = {
  isRunningAgent: boolean
  status: 'working' | 'permission' | 'idle' | null
  explicitUpdatedAt: number | null
}

export type AgentPromptSubmitDeps = {
  // Why: null means Orca has no status signal for this agent, not that it is unready.
  readReadiness: () => Promise<AgentPromptReadiness | null>
  writeSubmit: () => Promise<void>
  wait: (ms: number) => Promise<void>
}

export const AGENT_PROMPT_SUBMIT_ATTEMPTS = 3
export const AGENT_PROMPT_SUBMIT_CONFIRM_POLL_MS = 250
export const AGENT_PROMPT_SUBMIT_CONFIRM_POLLS = 4

export async function submitAgentPromptWithConfirmation(
  deps: AgentPromptSubmitDeps
): Promise<AgentPromptSubmitOutcome> {
  const baseline = await deps.readReadiness()
  if (!baseline) {
    return await writeUnverified(deps)
  }
  for (let attempt = 0; attempt < AGENT_PROMPT_SUBMIT_ATTEMPTS; attempt += 1) {
    const readiness = attempt === 0 ? baseline : await deps.readReadiness()
    if (!readiness) {
      return await writeUnverified(deps)
    }
    if (readiness.isRunningAgent && readiness.status !== 'permission') {
      await deps.writeSubmit()
      if (await confirmTurnStarted(deps, baseline)) {
        return 'confirmed'
      }
      continue
    }
    // Why: a permission prompt is not Enter-safe; wait it out instead of answering it.
    await deps.wait(AGENT_PROMPT_SUBMIT_CONFIRM_POLL_MS * AGENT_PROMPT_SUBMIT_CONFIRM_POLLS)
  }
  // Why: an agent already mid-turn cannot produce an idle->working transition, so
  // absence of one is not proof the Enter was swallowed.
  if (baseline.status === 'working') {
    return 'unverified'
  }
  throw new Error(AGENT_PROMPT_BUFFERED_NOT_SUBMITTED)
}

async function writeUnverified(deps: AgentPromptSubmitDeps): Promise<AgentPromptSubmitOutcome> {
  await deps.writeSubmit()
  return 'unverified'
}

async function confirmTurnStarted(
  deps: AgentPromptSubmitDeps,
  baseline: AgentPromptReadiness
): Promise<boolean> {
  for (let poll = 0; poll < AGENT_PROMPT_SUBMIT_CONFIRM_POLLS; poll += 1) {
    await deps.wait(AGENT_PROMPT_SUBMIT_CONFIRM_POLL_MS)
    const readiness = await deps.readReadiness()
    if (!readiness) {
      return false
    }
    if (readiness.status === 'working' && baseline.status !== 'working') {
      return true
    }
    // Why: a short turn can start and finish between two polls; a newer hook
    // timestamp still proves the Enter registered.
    if (
      readiness.explicitUpdatedAt !== null &&
      (baseline.explicitUpdatedAt === null ||
        readiness.explicitUpdatedAt > baseline.explicitUpdatedAt)
    ) {
      return true
    }
  }
  return false
}
