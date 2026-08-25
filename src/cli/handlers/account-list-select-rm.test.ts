import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_HANDLERS } from './account'
import { ACCOUNT_COMMAND_SPECS } from '../specs/account'
import type { HandlerContext } from '../dispatch'
import type { RateLimitState } from '../../shared/rate-limit-types'

function accountState(email: string) {
  return {
    accounts: [{ id: 'account-1', email }],
    activeAccountId: 'account-1',
    activeAccountIdsByRuntime: { host: 'account-1', wsl: {} }
  }
}

function rateLimitState(overrides: Partial<RateLimitState> = {}): RateLimitState {
  return {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    minimaxCookieConfigured: false,
    grokAuthConfigured: false,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: [],
    ...overrides
  }
}

type AccountsStateFixture = {
  accounts: { id: string; email: string }[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: { host: string | null; wsl: Record<string, string | null> }
}

function accountsSnapshotResult(
  claude: AccountsStateFixture,
  codex: AccountsStateFixture,
  rateLimitsOverrides: Partial<RateLimitState> = {}
) {
  return { claude, codex, rateLimits: rateLimitState(rateLimitsOverrides) }
}

describe('account list, select, rm CLI handlers', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  const callMock = vi.fn()

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockReset()
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  function context(agent = 'codex', json = false): HandlerContext {
    return {
      client: { call: callMock } as unknown as HandlerContext['client'],
      cwd: process.cwd(),
      flags: new Map([['agent', agent]]),
      json,
      rawArgs: []
    }
  }

  it('marks the active account "yes" in the usage table', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: accountsSnapshotResult(
        {
          accounts: [{ id: 'claude-1', email: 'claude@example.com' }],
          activeAccountId: 'claude-1'
        },
        { accounts: [], activeAccountId: null }
      ),
      _meta: { runtimeId: 'test-runtime' }
    })

    await ACCOUNT_HANDLERS['account list']({ ...context('claude'), flags: new Map() })

    const output = String(logSpy.mock.calls.at(-1)?.[0])
    expect(output).toMatch(/claude@example\.com\s+claude-1\s+yes/)
  })

  it('marks an account active when it is selected only on a WSL slot', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: accountsSnapshotResult(
        {
          accounts: [{ id: 'claude-wsl', email: 'claude@example.com' }],
          activeAccountId: null,
          activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'claude-wsl' } }
        },
        { accounts: [], activeAccountId: null }
      ),
      _meta: { runtimeId: 'test-runtime' }
    })

    await ACCOUNT_HANDLERS['account list']({ ...context('claude'), flags: new Map() })

    const output = String(logSpy.mock.calls.at(-1)?.[0])
    expect(output).toMatch(/claude@example\.com\s+claude-wsl\s+yes/)
  })

  it('lists accounts with a forced usage refresh, since the table now renders usage numbers', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: accountsSnapshotResult(
        { accounts: [], activeAccountId: null },
        { accounts: [], activeAccountId: null }
      ),
      _meta: { runtimeId: 'test-runtime' }
    })

    await ACCOUNT_HANDLERS['account list']({ ...context('claude'), flags: new Map() })

    expect(callMock).toHaveBeenCalledWith('accounts.list', { refreshUsage: true })
  })

  it('renders usage numbers from rateLimits for the active and inactive accounts of each agent', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: accountsSnapshotResult(
        { accounts: [], activeAccountId: null },
        {
          accounts: [
            { id: 'acc-active', email: 'active@example.com' },
            { id: 'acc-inactive', email: 'inactive@example.com' }
          ],
          activeAccountId: 'acc-active'
        },
        {
          codex: {
            provider: 'codex',
            session: {
              usedPercent: 42.4,
              windowMinutes: 300,
              resetsAt: null,
              resetDescription: null
            },
            weekly: null,
            updatedAt: 0,
            error: null,
            status: 'ok'
          },
          inactiveCodexAccounts: [
            {
              accountId: 'acc-inactive',
              rateLimits: null,
              updatedAt: 0,
              isFetching: false
            }
          ]
        }
      ),
      _meta: { runtimeId: 'test-runtime' }
    })

    await ACCOUNT_HANDLERS['account list']({
      ...context('codex'),
      flags: new Map([['agent', 'codex']])
    })

    const output = String(logSpy.mock.calls.at(-1)?.[0])
    expect(output).toContain('5h 42%')
    expect(output).toContain('n/a')
  })

  it('narrows `account list` human output to --agent but keeps --json output as the full unfiltered snapshot', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: accountsSnapshotResult(
        accountState('claude@example.com'),
        accountState('codex@example.com')
      ),
      _meta: { runtimeId: 'test-runtime' }
    })

    await ACCOUNT_HANDLERS['account list']({
      ...context('codex'),
      flags: new Map([['agent', 'codex']])
    })
    const humanOutput = String(logSpy.mock.calls.at(-1)?.[0])
    expect(humanOutput).toContain('codex@example.com')
    expect(humanOutput).not.toContain('claude@example.com')

    logSpy.mockClear()
    await ACCOUNT_HANDLERS['account list']({
      ...context('codex', true),
      flags: new Map([['agent', 'codex']])
    })
    const jsonPrinted = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))
    expect(jsonPrinted.result.claude.accounts[0].email).toBe('claude@example.com')
    expect(jsonPrinted.result.codex.accounts[0].email).toBe('codex@example.com')
  })

  it('selects a codex account by id', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: accountState('codex@example.com'),
      _meta: { runtimeId: 'test-runtime' }
    })

    await ACCOUNT_HANDLERS['account select']({
      ...context('codex'),
      flags: new Map([
        ['agent', 'codex'],
        ['id', 'account-1']
      ])
    })

    expect(callMock).toHaveBeenCalledWith('accounts.selectCodex', { accountId: 'account-1' })
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Active codex account: codex@example.com (account-1)')
    )
  })

  it('selects a claude account by id', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: accountState('claude@example.com'),
      _meta: { runtimeId: 'test-runtime' }
    })

    await ACCOUNT_HANDLERS['account select']({
      ...context('claude'),
      flags: new Map([
        ['agent', 'claude'],
        ['id', 'account-1']
      ])
    })

    expect(callMock).toHaveBeenCalledWith('accounts.selectClaude', { accountId: 'account-1' })
  })

  it('removes a codex account via `account rm`', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: { accounts: [], activeAccountId: null },
      _meta: { runtimeId: 'test-runtime' }
    })

    await ACCOUNT_HANDLERS['account rm']({
      ...context('codex'),
      flags: new Map([
        ['agent', 'codex'],
        ['id', 'account-1']
      ])
    })

    expect(callMock).toHaveBeenCalledWith('accounts.removeCodex', { accountId: 'account-1' })
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Removed codex account. 0 account(s) remain.')
    )
  })

  it('removes a claude account via `account rm`', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: { accounts: [], activeAccountId: null },
      _meta: { runtimeId: 'test-runtime' }
    })

    await ACCOUNT_HANDLERS['account rm']({
      ...context('claude'),
      flags: new Map([
        ['agent', 'claude'],
        ['id', 'account-1']
      ])
    })

    expect(callMock).toHaveBeenCalledWith('accounts.removeClaude', { accountId: 'account-1' })
  })

  it('rejects `account select` missing --id', async () => {
    await expect(
      ACCOUNT_HANDLERS['account select']({
        ...context('codex'),
        flags: new Map([['agent', 'codex']])
      })
    ).rejects.toThrow('Missing required --id')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects `account rm` missing --id', async () => {
    await expect(
      ACCOUNT_HANDLERS['account rm']({
        ...context('codex'),
        flags: new Map([['agent', 'codex']])
      })
    ).rejects.toThrow('Missing required --id')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects `account select` missing --agent', async () => {
    await expect(
      ACCOUNT_HANDLERS['account select']({
        ...context('codex'),
        flags: new Map([['id', 'account-1']])
      })
    ).rejects.toThrow('Missing required --agent')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects `account rm` with a valueless --agent instead of defaulting', async () => {
    await expect(
      ACCOUNT_HANDLERS['account rm']({
        ...context('codex'),
        flags: new Map<string, string | boolean>([
          ['agent', true],
          ['id', 'account-1']
        ])
      })
    ).rejects.toThrow('Missing a value for --agent')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('declares `account remove` as an alias for the canonical `account rm` command', () => {
    const rm = ACCOUNT_COMMAND_SPECS.find((spec) => spec.path.join(' ') === 'account rm')
    expect(rm?.aliases).toContainEqual(['account', 'remove'])
  })
})
