import { GLOBAL_FLAGS, type CommandSpec } from '../args'

// Why: absorbs the deleted `orca accounts` group; adds select/rm and a remote
// device-authorization login path alongside the original local-terminal flow.
export const ACCOUNT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['account', 'add'],
    summary: 'Add a managed agent account by signing in locally or on a remote Orca host',
    usage:
      'orca account add [--agent claude|codex|opencode|devin] [--label <name>] [--integration <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent', 'label', 'integration'],
    notes: [
      'Without --environment/--pairing-code, runs the agent login (`claude login` / `codex login`) in this terminal and imports the captured credentials into the local Orca runtime.',
      'With --environment or --pairing-code, runs the login on that remote Orca host via device authorization instead and streams its output back to this terminal.',
      'Codex always uses device authorization so the browser can complete sign-in from a different machine.',
      'OpenCode 2 uses `opencode auth login --standalone` in private XDG directories. Devin uses `devin auth login --force-manual-token-flow`.',
      'Use --integration <id> to skip the OpenCode integration picker; --label names the saved OpenCode or Devin profile.',
      'OpenCode and Devin profiles apply to new explicit host agent launches. Direct SSH relay and Windows-hosted WSL selection are not supported; run the command on a headless Orca runtime on that host.',
      'Sign in with the account you want to add (e.g. use a private/incognito browser window for a second account).',
      '--agent defaults to claude. Requires the Orca runtime to be running on this machine.'
    ],
    examples: [
      'orca account add',
      'orca account add --agent codex',
      'orca account add --agent codex --environment homelab'
    ]
  },
  {
    path: ['account', 'list'],
    summary: 'List managed agent accounts on this Orca host',
    usage: 'orca account list [--agent opencode|devin] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent'],
    notes: [
      'Renders per-account email, active marker, and current usage/rate-limit state.',
      '--agent filters the list to claude, codex, opencode, or devin; omit it to list all.',
      'Runs against the local Orca runtime by default; pass --environment or --pairing-code to list accounts on that remote host instead.'
    ],
    examples: ['orca account list', 'orca account list --agent codex --json']
  },
  {
    path: ['account', 'select'],
    summary: 'Select an OpenCode or Devin profile for new agent launches',
    usage: 'orca account select --agent opencode|devin --account <id|system> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent', 'account', 'id'],
    notes: ['--account or --id is a managed account id from `orca account list --json`.'],
    examples: ['orca account select --agent codex --id acc_123']
  },
  {
    path: ['account', 'rm'],
    // Why: 'rm' is the canonical deletion verb (see vocabulary-policy.ts); 'remove'
    // stays reachable as an alias so it satisfies the policy without a rename.
    aliases: [['account', 'remove']],
    destructive: true,
    summary: 'Remove a managed account for an agent',
    usage: 'orca account rm --agent opencode|devin --account <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent', 'account', 'id'],
    notes: [
      '--account or --id is a managed account id from `orca account list --json`.',
      'Deletes credentials and conversation data in the managed profile. Stop its running agents first. System credentials are never removed.'
    ],
    examples: ['orca account rm --agent codex --id acc_123']
  }
]
