// Why: the Enter is a separate write from the paste, so callers need to know a turn
// really started — not just that bytes reached the PTY.
export type AgentPromptSubmitOutcome = 'confirmed' | 'unverified'

// Why: re-dispatching after a buffered body would create two user turns (#13439),
// so recovery advice must distinguish it from a dispatch that wrote nothing.
export type DispatchInputRecovery = 'nothing_written' | 'buffered_not_submitted'

export const AGENT_PROMPT_BUFFERED_NOT_SUBMITTED = 'agent_prompt_buffered_not_submitted'

export function buildBufferedNotSubmittedError(cause: string): Error {
  return new Error(`${cause} (${AGENT_PROMPT_BUFFERED_NOT_SUBMITTED})`)
}

export function classifyDispatchInputRecovery(error: unknown): DispatchInputRecovery {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(AGENT_PROMPT_BUFFERED_NOT_SUBMITTED)
    ? 'buffered_not_submitted'
    : 'nothing_written'
}
