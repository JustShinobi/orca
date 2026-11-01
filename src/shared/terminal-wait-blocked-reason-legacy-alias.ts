// Why both spellings: the codex-* members were published by every host before the agent-neutral
// rename, so they are permanent — a client still has to read them off an older host. This build
// keeps a codex-* reason only where the matched wording is plausibly Codex's own; every matcher
// that inspects no agent publishes the agent-* spelling.
export type RuntimeTerminalWaitBlockedReason =
  | 'codex-update-prompt'
  | 'codex-trust-workspace'
  | 'codex-cwd-prompt'
  | 'codex-model-migration-prompt'
  | 'codex-hooks-review-prompt'
  | 'codex-interactive-prompt'
  | 'agent-update-prompt'
  | 'agent-trust-workspace'
  | 'agent-cwd-prompt'
  | 'agent-hooks-review-prompt'
  | 'agent-interactive-prompt'
  | 'agent-approval-prompt'

// Older hosts mislabeled generic dialogs codex-*; render neutral equivalents for other agents.
// Use Map for unvalidated wire keys so constructor/toString cannot print inherited functions.
// Only map old → neutral: old clients receiving new tokens use their own shipped rendering.
const LEGACY_CODEX_REASON_ALIASES = new Map<string, RuntimeTerminalWaitBlockedReason>([
  ['codex-update-prompt', 'agent-update-prompt'],
  ['codex-trust-workspace', 'agent-trust-workspace'],
  ['codex-cwd-prompt', 'agent-cwd-prompt'],
  ['codex-hooks-review-prompt', 'agent-hooks-review-prompt'],
  ['codex-interactive-prompt', 'agent-interactive-prompt']
])

/** Neutral spelling for a reason an older host published, or null when it is already neutral or agent-specific. */
export function agentNeutralTerminalWaitBlockedReason(
  reason: RuntimeTerminalWaitBlockedReason
): RuntimeTerminalWaitBlockedReason | null {
  return LEGACY_CODEX_REASON_ALIASES.get(reason) ?? null
}

/** Append the neutral spelling for old hosts; preserve the published raw token because scripts parse it. */
export function describeTerminalWaitBlockedReason(
  reason: RuntimeTerminalWaitBlockedReason
): string {
  const neutral = agentNeutralTerminalWaitBlockedReason(reason)
  return neutral ? `${reason} (${neutral})` : reason
}
