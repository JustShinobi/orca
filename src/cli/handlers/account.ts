import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
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
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'
import { getRequiredStringFlag } from '../flags'
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
async function addClaudeAccount({ client, json }: HandlerContext): Promise<void> {
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
async function addCodexAccount({ client, json }: HandlerContext): Promise<void> {
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
        sourceHome: codexHome
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
 * Reads and validates `--agent`. A valueless `--agent` parses as boolean
 * true; defaulting or accepting it would silently run a full OAuth login (or
 * RPC) for a provider the user did not ask for, so it is rejected instead.
 */
function getAgentFlag(flags: Map<string, string | boolean>): RuntimeAccountProvider | undefined {
  const value = flags.get('agent')
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing a value for --agent. Use `--agent claude` or `--agent codex`.'
    )
  }
  if (value !== 'claude' && value !== 'codex') {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unsupported --agent "${value}". Use "claude" or "codex".`
    )
  }
  return value
}

function requireAgentFlag(flags: Map<string, string | boolean>): RuntimeAccountProvider {
  const agent = getAgentFlag(flags)
  if (!agent) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing required --agent. Use `--agent claude` or `--agent codex`.'
    )
  }
  return agent
}

/** CLI handlers for `orca account add|list|select|rm [--agent claude|codex]`. */
export const ACCOUNT_HANDLERS: Record<string, CommandHandler> = {
  'account add': async (ctx) => {
    const agent = getAgentFlag(ctx.flags) ?? 'claude'
    // Why: main's import RPCs take a filesystem path that only resolves on
    // this CLI's own machine, so a runtime-selector flag means the user wants
    // the login to happen on the remote runtime host instead — the PR's
    // server-side login (accounts.addCodex/addClaude) is the only flow that
    // can honor that.
    if (ctx.flags.has('environment') || ctx.flags.has('pairing-code')) {
      await addAccountRemote(ctx.client, agent, ctx.json)
      return
    }
    // Why: fail on runtime version skew before burning a full OAuth round trip.
    await assertAccountImportSupported(ctx)
    await ctx.client.call('accounts.list', { refreshUsage: false })
    await (agent === 'claude' ? addClaudeAccount(ctx) : addCodexAccount(ctx))
  },
  'account list': async (ctx) => {
    const agent = getAgentFlag(ctx.flags)
    const { client, json } = ctx
    // Why: this now renders usage numbers, so it needs the forced refresh
    // (unlike the pre-consolidation local-only listing).
    const result = await client.call<RuntimeAccountsSnapshot>('accounts.list', {
      refreshUsage: true
    })
    printResult(result, json, (snapshot) => formatAccountsList(snapshot, agent))
  },
  'account select': async ({ flags, client, json }) => {
    const agent = requireAgentFlag(flags)
    const accountId = getRequiredStringFlag(flags, 'id')
    const result = await client.call<CodexRateLimitAccountsState | ClaudeRateLimitAccountsState>(
      agent === 'codex' ? 'accounts.selectCodex' : 'accounts.selectClaude',
      { accountId }
    )
    printResult(result, json, (state) => formatAccountSelectResult(agent, state))
  },
  'account rm': async ({ flags, client, json }) => {
    const agent = requireAgentFlag(flags)
    const accountId = getRequiredStringFlag(flags, 'id')
    const result = await client.call<CodexRateLimitAccountsState | ClaudeRateLimitAccountsState>(
      agent === 'codex' ? 'accounts.removeCodex' : 'accounts.removeClaude',
      { accountId }
    )
    printResult(result, json, (state) => formatAccountRemoveResult(agent, state))
  }
}
