/** What a Claude account switch does to Claude sessions still on the old account. */
export type ClaudeAccountSwitchRunningSessions = 'ask' | 'restart' | 'keep'

export type ClaudeAccountSwitchSettings = {
  /** Absent means 'ask'. */
  claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions
  /** When enabled, Orca exits a rate-limited managed Claude/Codex session,
   *  switches to another managed account with available quota, resumes the
   *  same provider session, then sends "continue". */
  autoSwitchRateLimitedAccounts?: boolean
}
