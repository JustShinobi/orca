import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ACCOUNTS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['accounts', 'list'],
    summary: 'List managed Codex and Claude accounts and their active/usage state',
    usage: 'orca accounts list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['accounts', 'add'],
    summary: 'Add a managed account by running the provider login and streaming its output',
    usage: 'orca accounts add --provider codex|claude [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'provider'],
    examples: ['orca accounts add --provider codex', 'orca accounts add --provider claude --json']
  },
  {
    path: ['accounts', 'select'],
    summary: 'Switch the active managed account for a provider',
    usage: 'orca accounts select --provider codex|claude --id <accountId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'provider', 'id']
  },
  {
    path: ['accounts', 'rm'],
    // Why: 'rm' is the canonical deletion verb (see vocabulary-policy.ts); 'remove'
    // stays reachable as an alias so it satisfies the policy without a rename.
    aliases: [['accounts', 'remove']],
    destructive: true,
    summary: 'Remove a managed account for a provider',
    usage: 'orca accounts rm --provider codex|claude --id <accountId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'provider', 'id']
  }
]
