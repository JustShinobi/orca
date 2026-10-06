import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  readActiveClaudeKeychainCredentialsStrict,
  writeActiveClaudeKeychainCredentials
} from '../../main/claude-accounts/keychain'
import { ACCOUNT_IMPORT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type {
  RuntimeAccountProvider,
  RuntimeAccountsSnapshot,
  RuntimeStatus
} from '../../shared/runtime-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  ManagedDataAccountsState
} from '../../shared/managed-account-types'
import {
  formatAccountRemoveResult,
  formatAccountSelectResult,
  formatAccountsBlock,
  formatAccountsList
} from '../accounts-format'
import { addAccountRemote } from './account-remote-login'
import { runAgentLoginInTerminal } from './account-terminal-login'
import {
  type InteractiveLoginSession,
  withInteractiveLoginCleanup
} from './interactive-login-interruption'
import { getWslAccountTarget } from './account-wsl-location'
import { addDataAccount, listDataAccounts, mutateDataAccount } from './data-account-commands'
import { formatDataAccounts } from './account-list-format'

async function cleanupClaudeLoginArtifacts(
  configDir: string,
  legacyCredentials: string | null,
  restoreLegacyCredentials: boolean
): Promise<void> {
  const errors: unknown[] = []
  if (process.platform === 'darwin') {
    try {
      await deleteActiveClaudeKeychainCredentialsStrict(configDir)
    } catch (error) {
      errors.push(error)
    }
    if (restoreLegacyCredentials) {
      try {
        await (legacyCredentials
          ? writeActiveClaudeKeychainCredentials(legacyCredentials)
          : deleteActiveClaudeKeychainCredentialsStrict())
      } catch (error) {
        errors.push(error)
      }
    }
  }
  try {
    rmSync(configDir, { recursive: true, force: true })
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to clean up Claude login artifacts.')
  }
}

/** Logs into a Claude account in a temp config dir, then registers it with the local runtime. */
async function addClaudeAccount({ client, cwd, json }: HandlerContext): Promise<void> {
  const configDir = mkdtempSync(join(tmpdir(), 'orca-account-add-claude-'))
  const session: InteractiveLoginSession = {
    child: null,
    registering: false,
    terminationPromise: null
  }
  let legacyCredentials: string | null = null
  let restoreLegacyCredentials = false
  const result = await withInteractiveLoginCleanup(
    session,
    async () => {
      await cleanupClaudeLoginArtifacts(configDir, legacyCredentials, restoreLegacyCredentials)
    },
    async () => {
      if (process.platform === 'darwin') {
        legacyCredentials = await readActiveClaudeKeychainCredentialsStrict()
        restoreLegacyCredentials = true
      }
      await runAgentLoginInTerminal(
        'claude',
        ['auth', 'login', '--claudeai'],
        {
          CLAUDE_CONFIG_DIR: configDir
        },
        json,
        session
      )
      session.registering = true
      return client.call<ClaudeRateLimitAccountsState>('accounts.addClaudeFromConfigDir', {
        configDir,
        ...getWslAccountTarget(cwd),
        ...(process.platform === 'darwin'
          ? {
              previousLegacyCredentialsSha256: legacyCredentials
                ? createHash('sha256').update(legacyCredentials).digest('hex')
                : null
            }
          : {})
      })
    }
  )
  printResult(result, json, (state) => formatAccountsBlock('Claude', state))
}

/** Logs into a Codex account in a temp CODEX_HOME, then registers it with the local runtime. */
async function addCodexAccount({ client, cwd, json }: HandlerContext): Promise<void> {
  const codexHome = mkdtempSync(join(tmpdir(), 'orca-account-add-codex-'))
  const session: InteractiveLoginSession = {
    child: null,
    registering: false,
    terminationPromise: null
  }
  const result = await withInteractiveLoginCleanup(
    session,
    async () => {
      rmSync(codexHome, { recursive: true, force: true })
    },
    async () => {
      // Why: plain OAuth binds a loopback callback the user's browser cannot reach
      // on a headless/SSH host; device auth is explicitly designed for this flow.
      await runAgentLoginInTerminal(
        'codex',
        ['login', '--device-auth'],
        { CODEX_HOME: codexHome },
        json,
        session
      )
      session.registering = true
      return client.call<CodexRateLimitAccountsState>('accounts.addCodexFromHome', {
        sourceHome: codexHome,
        ...getWslAccountTarget(cwd)
      })
    }
  )
  printResult(result, json, (state) => formatAccountsBlock('Codex', state))
}

async function assertAccountImportSupported({ client }: HandlerContext): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(ACCOUNT_IMPORT_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The running Orca runtime is too old to add accounts from the CLI. Update or restart Orca and try again.'
    )
  }
}

/**
 * Rejects the runtime-selector flags instead of ignoring them. shouldIgnoreRemoteSelection
 * pins account commands to the local runtime, so honoring `--environment homelab`
 * silently would target the laptop rather than the host the user named — the exact
 * mistake this feature exists to avoid. A `--help` note does not reach someone who
 * already typed the flag.
 */
function rejectAccountRemoteSelectionFlags(ctx: HandlerContext, command: string): void {
  rejectRemoteSelectionFlags(
    ctx.flags,
    `\`${command}\`. Run it on the host whose accounts you want to manage.`
  )
}

/**
 * Reads and validates `--agent`. A valueless `--agent` parses as boolean
 * true; defaulting or accepting it would silently run a full OAuth login (or
 * RPC) for a provider the user did not ask for, so it is rejected instead.
 */
function getAgentFlag(flags: Map<string, string | boolean>): string | undefined {
  const value = flags.get('agent')
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing a value for --agent. Use `--agent claude`, `--agent codex`, `--agent opencode`, or `--agent devin`.'
    )
  }
  if (value !== 'claude' && value !== 'codex' && value !== 'opencode' && value !== 'devin') {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unsupported --agent "${value}". Use "claude", "codex", "opencode", or "devin".`
    )
  }
  return value
}

function requireAgentFlag(flags: Map<string, string | boolean>): string {
  const agent = getAgentFlag(flags)
  if (!agent) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing required --agent. Use `--agent claude`, `--agent codex`, `--agent opencode`, or `--agent devin`.'
    )
  }
  return agent
}

type RuntimeAccountsSnapshotWithData = RuntimeAccountsSnapshot & {
  opencode?: ManagedDataAccountsState
  devin?: ManagedDataAccountsState
}

/** CLI handlers for managed account enrollment, listing, selection, and removal. */
export const ACCOUNT_HANDLERS: Record<string, CommandHandler> = {
  'account add': async (ctx) => {
    const agent = getAgentFlag(ctx.flags) ?? 'claude'
    if (agent === 'opencode' || agent === 'devin') {
      rejectAccountRemoteSelectionFlags(ctx, 'orca account add')
      await addDataAccount(ctx, agent, runAgentLoginInTerminal)
      return
    }
    // Why: main's import RPCs take a filesystem path that only resolves on
    // this CLI's own machine, so a runtime-selector flag means the user wants
    // the login to happen on the remote runtime host instead — the PR's
    // server-side login (accounts.addCodex/addClaude) is the only flow that
    // can honor that.
    if (ctx.flags.has('environment') || ctx.flags.has('pairing-code')) {
      await addAccountRemote(ctx.client, agent as RuntimeAccountProvider, ctx.json)
      return
    }
    // Why: fail on runtime version skew before burning a full OAuth round trip.
    await assertAccountImportSupported(ctx)
    await ctx.client.call('accounts.list', { refreshUsage: false })
    await (agent === 'claude' ? addClaudeAccount(ctx) : addCodexAccount(ctx))
  },
  'account list': async (ctx) => {
    const provider = ctx.flags.get('agent')
    if (provider === 'opencode' || provider === 'devin') {
      rejectAccountRemoteSelectionFlags(ctx, 'orca account list')
      await listDataAccounts(ctx, provider)
      return
    }
    const agent = getAgentFlag(ctx.flags) as RuntimeAccountProvider | undefined
    const { client, json } = ctx
    // Why: this now renders usage numbers, so it needs the forced refresh
    // (unlike the pre-consolidation local-only listing).
    const result = await client.call<RuntimeAccountsSnapshotWithData>('accounts.list', {
      refreshUsage: true
    })
    printResult(result, json, (snapshot) => {
      const parts = [formatAccountsList(snapshot, agent)]
      if (!agent) {
        if (snapshot.opencode) {
          parts.push(formatDataAccounts('OpenCode', snapshot.opencode))
        }
        if (snapshot.devin) {
          parts.push(formatDataAccounts('Devin', snapshot.devin))
        }
      }
      return parts.join('\n\n')
    })
  },
  'account select': async (ctx) => {
    const agent = requireAgentFlag(ctx.flags)
    if (agent === 'opencode' || agent === 'devin') {
      rejectAccountRemoteSelectionFlags(ctx, 'orca account select')
      if (!ctx.flags.has('account') && ctx.flags.has('id')) {
        ctx.flags.set('account', ctx.flags.get('id')!)
      }
      await mutateDataAccount(ctx, 'select')
      return
    }
    const accountId = ctx.flags.get('id') ?? ctx.flags.get('account')
    if (typeof accountId !== 'string' || !accountId) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --id.')
    }
    const result = await ctx.client.call<
      CodexRateLimitAccountsState | ClaudeRateLimitAccountsState
    >(agent === 'codex' ? 'accounts.selectCodex' : 'accounts.selectClaude', { accountId })
    printResult(result, ctx.json, (state) =>
      formatAccountSelectResult(agent as RuntimeAccountProvider, state)
    )
  },
  'account rm': async (ctx) => {
    const agent = requireAgentFlag(ctx.flags)
    if (agent === 'opencode' || agent === 'devin') {
      rejectAccountRemoteSelectionFlags(ctx, 'orca account rm')
      if (!ctx.flags.has('account') && ctx.flags.has('id')) {
        ctx.flags.set('account', ctx.flags.get('id')!)
      }
      await mutateDataAccount(ctx, 'remove')
      return
    }
    const accountId = ctx.flags.get('id') ?? ctx.flags.get('account')
    if (typeof accountId !== 'string' || !accountId) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --id.')
    }
    const result = await ctx.client.call<
      CodexRateLimitAccountsState | ClaudeRateLimitAccountsState
    >(agent === 'codex' ? 'accounts.removeCodex' : 'accounts.removeClaude', { accountId })
    printResult(result, ctx.json, (state) =>
      formatAccountRemoveResult(agent as RuntimeAccountProvider, state)
    )
  }
}
