import type { AgentPromptSubmitOutcome } from '../../../shared/agent-prompt-submission'

// Why: 'input_accepted' keeps its old spelling for the unverified case so older
// readers still recognize the weaker signal; only a confirmed turn gets a new stage.
export const WORKER_PROMPT_SUBMITTED_STAGE = 'prompt_submitted'
export const WORKER_INPUT_ACCEPTED_STAGE = 'input_accepted'
export const REMOTE_WORKER_PROMPT_SUBMITTED_STAGE = 'remote_prompt_submitted'
export const REMOTE_WORKER_INPUT_ACCEPTED_STAGE = 'remote_input_accepted'

export function workerReadyStage(submitted: AgentPromptSubmitOutcome): string {
  return submitted === 'confirmed' ? WORKER_PROMPT_SUBMITTED_STAGE : WORKER_INPUT_ACCEPTED_STAGE
}

export function remoteWorkerReadyStage(submitted: AgentPromptSubmitOutcome): string {
  return submitted === 'confirmed'
    ? REMOTE_WORKER_PROMPT_SUBMITTED_STAGE
    : REMOTE_WORKER_INPUT_ACCEPTED_STAGE
}

export function dispatchInputEffectState(
  submitted: AgentPromptSubmitOutcome
): 'submitted' | 'accepted' {
  return submitted === 'confirmed' ? 'submitted' : 'accepted'
}
