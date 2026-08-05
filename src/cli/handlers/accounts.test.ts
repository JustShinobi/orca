import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

// Why: the interactive Claude paste-back prompt reads from process.stdin via
// node:readline/promises — mock it so tests can drive the user's answer
// without a real TTY. vi.mock factories are hoisted above top-level const
// declarations, so the mock fns must be created via vi.hoisted.
const { questionMock, closeMock, createInterfaceMock } = vi.hoisted(() => ({
  questionMock: vi.fn(),
  closeMock: vi.fn(),
  createInterfaceMock: vi.fn()
}))
createInterfaceMock.mockImplementation(() => ({ question: questionMock, close: closeMock }))

vi.mock('node:readline/promises', () => ({
  createInterface: createInterfaceMock
}))

vi.mock('../runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { main } from '../index'
import { RuntimeClientError } from '../runtime-client'
import { okFixture, queueFixtures } from '../test-fixtures'

// Why: main()'s cwd argument must never assume a POSIX path (SSH/Windows
// hosts too) — use the real cwd instead of a hardcoded POSIX-style path.
const testCwd = process.cwd()

describe('orca accounts CLI handlers', () => {
  const originalStdinIsTTY = process.stdin.isTTY

  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    questionMock.mockReset()
    closeMock.mockReset()
    createInterfaceMock.mockClear()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    process.exitCode = undefined
    // Why: default to a real interactive terminal so paste-code prompt tests
    // exercise readline; the non-TTY test below overrides this itself.
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalStdinIsTTY,
      configurable: true
    })
  })

  it('prints a table of managed accounts with usage', async () => {
    queueFixtures(
      callMock,
      okFixture('req_list', {
        codex: {
          accounts: [{ id: 'acc-codex-1', email: 'codex@example.com' }],
          activeAccountId: 'acc-codex-1'
        },
        claude: {
          accounts: [{ id: 'acc-claude-1', email: 'claude@example.com' }],
          activeAccountId: null
        },
        rateLimits: {
          codex: { provider: 'codex', session: { usedPercent: 42.4 }, weekly: null },
          claude: null,
          inactiveCodexAccounts: [],
          inactiveClaudeAccounts: [{ accountId: 'acc-claude-1', rateLimits: null }]
        }
      })
    )

    await main(['accounts', 'list'], testCwd)

    expect(callMock).toHaveBeenCalledWith('accounts.list')
    const output = String(vi.mocked(console.log).mock.calls[0][0])
    expect(output).toContain('PROVIDER')
    expect(output).toContain('codex')
    expect(output).toContain('codex@example.com')
    expect(output).toContain('acc-codex-1')
    expect(output).toContain('yes')
    expect(output).toContain('5h 42%')
    expect(output).toContain('claude@example.com')
    expect(output).toContain('n/a')
  })

  it('rejects an unknown --provider before calling the runtime', async () => {
    await main(['accounts', 'select', '--provider', 'gemini', '--id', 'acc-1'], testCwd)

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      '--provider must be codex or claude'
    )
    expect(process.exitCode).toBe(1)
  })

  it('selects a codex account by id', async () => {
    queueFixtures(
      callMock,
      okFixture('req_select', {
        accounts: [{ id: 'acc-codex-1', email: 'codex@example.com' }],
        activeAccountId: 'acc-codex-1'
      })
    )

    await main(['accounts', 'select', '--provider', 'codex', '--id', 'acc-codex-1'], testCwd)

    expect(callMock).toHaveBeenCalledWith('accounts.selectCodex', { accountId: 'acc-codex-1' })
    expect(vi.mocked(console.log).mock.calls[0][0]).toContain(
      'Active codex account: codex@example.com (acc-codex-1)'
    )
  })

  it('selects a claude account by id', async () => {
    queueFixtures(
      callMock,
      okFixture('req_select', {
        accounts: [{ id: 'acc-claude-1', email: 'claude@example.com' }],
        activeAccountId: 'acc-claude-1'
      })
    )

    await main(['accounts', 'select', '--provider', 'claude', '--id', 'acc-claude-1'], testCwd)

    expect(callMock).toHaveBeenCalledWith('accounts.selectClaude', { accountId: 'acc-claude-1' })
  })

  it('removes a codex account via the remove alias for the canonical rm command', async () => {
    queueFixtures(
      callMock,
      okFixture('req_remove', {
        accounts: [],
        activeAccountId: null
      })
    )

    await main(['accounts', 'remove', '--provider', 'codex', '--id', 'acc-codex-1'], testCwd)

    expect(callMock).toHaveBeenCalledWith('accounts.removeCodex', { accountId: 'acc-codex-1' })
    expect(vi.mocked(console.log).mock.calls[0][0]).toContain(
      'Removed codex account. 0 account(s) remain.'
    )
  })

  it('streams login output live, announces the login URL, and reports the added account', async () => {
    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-1' }),
      okFixture('req_poll_1', {
        loginId: 'login-1',
        provider: 'codex',
        status: 'in_progress',
        outputTail: 'Visit https://auth.example.com/login?code=abc to continue.\n'
      }),
      okFixture('req_poll_2', {
        loginId: 'login-1',
        provider: 'codex',
        status: 'completed',
        outputTail: 'Visit https://auth.example.com/login?code=abc to continue.\nSigned in.\n',
        state: {
          accounts: [{ id: 'acc-codex-1', email: 'codex@example.com' }],
          activeAccountId: 'acc-codex-1'
        }
      })
    )

    await main(['accounts', 'add', '--provider', 'codex'], testCwd)

    expect(callMock).toHaveBeenCalledWith('accounts.addCodex', {})
    expect(callMock).toHaveBeenCalledWith(
      'accounts.pollAdd',
      { loginId: 'login-1', timeoutMs: expect.any(Number) },
      { timeoutMs: expect.any(Number) }
    )
    expect(callMock).toHaveBeenCalledTimes(3)

    const written = vi.mocked(process.stdout.write).mock.calls.map((call) => String(call[0]))
    expect(written.join('')).toContain('Visit https://auth.example.com/login?code=abc')
    expect(written.join('')).toContain('Signed in.')

    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    expect(logged.some((line) => line.includes('Login URL (open on another device'))).toBe(true)
    expect(logged.some((line) => line.includes('auth.example.com/login?code=abc'))).toBe(true)
    expect(
      logged.some((line) => line.includes('Added codex account: codex@example.com (acc-codex-1)'))
    ).toBe(true)
    // The final summary must not repeat the URL once the live poll already announced it.
    const finalSummary = logged.at(-1)
    expect(finalSummary).not.toContain('Login URL:')
    expect(process.exitCode).toBeUndefined()
  })

  it('announces a live login URL exactly once, omits it from the final human-readable summary, but --json output still includes it', async () => {
    // Why: this fixture must include a real URL in outputTail (unlike a prior
    // version of this test, which asserted against a fixture with no URL at
    // all — trivially "passing" without ever distinguishing "announced once,
    // then correctly omitted" from "there was never a URL to announce").
    const url = 'https://auth.example.com/login?code=live-url'
    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-5' }),
      okFixture('req_poll_1', {
        loginId: 'login-5',
        provider: 'codex',
        status: 'in_progress',
        outputTail: `Visit ${url} to continue.\n`
      }),
      okFixture('req_poll_2', {
        loginId: 'login-5',
        provider: 'codex',
        status: 'completed',
        outputTail: `Visit ${url} to continue.\nSigned in.\n`,
        state: {
          accounts: [{ id: 'acc-codex-2', email: 'codex2@example.com' }],
          activeAccountId: 'acc-codex-2'
        }
      })
    )

    await main(['accounts', 'add', '--provider', 'codex'], testCwd)

    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    const urlAnnouncements = logged.filter((line) =>
      line.includes('Login URL (open on another device')
    )
    expect(urlAnnouncements).toHaveLength(1)
    const finalSummary = logged.at(-1)
    expect(finalSummary).not.toContain(url)
    expect(finalSummary).toContain('Added codex account: codex2@example.com (acc-codex-2)')

    // The human-readable summary above omits the URL once it was announced
    // live (see omitLoginUrl in formatAccountAddResult), but --json mode must
    // still carry it for scripts/tools parsing the final response.
    callMock.mockReset()
    vi.mocked(console.log).mockClear()
    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-5b' }),
      okFixture('req_poll_1', {
        loginId: 'login-5b',
        provider: 'codex',
        status: 'in_progress',
        outputTail: `Visit ${url} to continue.\n`
      }),
      okFixture('req_poll_2', {
        loginId: 'login-5b',
        provider: 'codex',
        status: 'completed',
        outputTail: `Visit ${url} to continue.\nSigned in.\n`,
        state: {
          accounts: [{ id: 'acc-codex-2', email: 'codex2@example.com' }],
          activeAccountId: 'acc-codex-2'
        }
      })
    )

    await main(['accounts', 'add', '--provider', 'codex', '--json'], testCwd)

    const jsonPrinted = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))
    expect(jsonPrinted.result.loginUrl).toBe(url)
  })

  it('skips a loopback callback-server URL and announces the real external auth URL', async () => {
    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-8' }),
      okFixture('req_poll_1', {
        loginId: 'login-8',
        provider: 'codex',
        status: 'completed',
        outputTail:
          'Starting local login server on http://localhost:1455.\n' +
          'If your browser did not open, visit https://auth.openai.com/oauth/authorize?state=xyz\n',
        state: {
          accounts: [{ id: 'acc-codex-4', email: 'codex4@example.com' }],
          activeAccountId: 'acc-codex-4'
        }
      })
    )

    await main(['accounts', 'add', '--provider', 'codex'], testCwd)

    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    expect(logged.some((line) => line.includes('auth.openai.com/oauth/authorize'))).toBe(true)
    expect(logged.some((line) => line.includes('localhost:1455'))).toBe(false)
  })

  it('extracts the device-auth URL and one-time code from real codex --device-auth output, ignoring trailing ANSI resets', async () => {
    // Why: real `codex login --device-auth` output colors the URL/code with
    // ANSI SGR escapes with no whitespace before the reset code (e.g.
    // "\x1b[94mhttps://...\x1b[0m"), which a naive \S+ URL regex would
    // otherwise swallow into the extracted URL.
    const deviceAuthOutput =
      'Welcome to Codex [v0.144.4]\n' +
      "OpenAI's command-line coding agent\n\n" +
      'Follow these steps to sign in with ChatGPT using device code authorization:\n\n' +
      '1. Open this link in your browser and sign in to your account\n' +
      '   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n' +
      '2. Enter this one-time code (expires in 15 minutes)\n' +
      '   \x1b[1m7UNS-MDSUA\x1b[0m\n'

    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-9' }),
      okFixture('req_poll_1', {
        loginId: 'login-9',
        provider: 'codex',
        status: 'completed',
        outputTail: deviceAuthOutput,
        state: {
          accounts: [{ id: 'acc-codex-9', email: 'codex9@example.com' }],
          activeAccountId: 'acc-codex-9'
        }
      })
    )

    await main(['accounts', 'add', '--provider', 'codex'], testCwd)

    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    expect(logged.some((line) => line.includes('https://auth.openai.com/codex/device'))).toBe(true)
    expect(logged.some((line) => line.includes('\x1b[0m'))).toBe(false)
    expect(logged.some((line) => line.includes('7UNS-MDSUA'))).toBe(true)
  })

  it('strips OSC 8 terminal hyperlink escapes around the real Claude login URL, leaving one clean copy', async () => {
    // Why: real bytes captured from `claude auth login --claudeai` (cat -v'd
    // as ^[]8;;<url>^G<url>^[]8;;^G) — Claude wraps the printed URL in an OSC
    // 8 hyperlink, a different escape family (ESC ]) than ANSI_SGR_PATTERN's
    // CSI (ESC [) sequences, so it previously slipped through unstripped and
    // into the extracted "login URL" as mangled escape-code garbage.
    const url =
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_challenge=yAdRhFlEa9knigczwtQv2wRHy4UY5Udh6JJXj4pe6t8&code_challenge_method=S256&state=fJzYBC5jAWisQ2EdJJe0K8jDZe5Ps1tXNl3A44MTOZc'
    const oscWrappedOutput = `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`

    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-16' }),
      okFixture('req_poll_1', {
        loginId: 'login-16',
        provider: 'claude',
        status: 'completed',
        outputTail: oscWrappedOutput,
        state: {
          accounts: [{ id: 'acc-claude-16', email: 'claude16@example.com' }],
          activeAccountId: 'acc-claude-16'
        }
      })
    )

    await main(['accounts', 'add', '--provider', 'claude'], testCwd)

    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    const urlLine = logged.find((line) => line.includes('Login URL'))
    expect(urlLine).toBe(`\nLogin URL (open on another device if needed): ${url}`)
    // The raw live stream forwarded to the user's terminal must be left
    // untouched — a real terminal renders OSC 8 as a clickable hyperlink.
    const written = vi.mocked(process.stdout.write).mock.calls.map((call) => String(call[0]))
    expect(written.join('')).toBe(oscWrappedOutput)
  })

  it('announces the login URL and device code on stderr in --json mode so scripts see them before the 15-minute code expiry', async () => {
    const deviceAuthOutput =
      '1. Open this link in your browser and sign in to your account\n' +
      '   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n' +
      '2. Enter this one-time code (expires in 15 minutes)\n' +
      '   \x1b[1m7UNS-MDSUA\x1b[0m\n'

    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-10' }),
      okFixture('req_poll_1', {
        loginId: 'login-10',
        provider: 'codex',
        status: 'in_progress',
        outputTail: deviceAuthOutput
      }),
      okFixture('req_poll_2', {
        loginId: 'login-10',
        provider: 'codex',
        status: 'completed',
        outputTail: deviceAuthOutput,
        state: {
          accounts: [{ id: 'acc-codex-10', email: 'codex10@example.com' }],
          activeAccountId: 'acc-codex-10'
        }
      })
    )

    await main(['accounts', 'add', '--provider', 'codex', '--json'], testCwd)

    // Why: stdout must stay clean JSON for scripts/tools, so raw streaming
    // and the URL/code announcement are not allowed to touch it here.
    expect(vi.mocked(process.stdout.write)).not.toHaveBeenCalled()
    expect(vi.mocked(console.log)).toHaveBeenCalledTimes(1)

    const stderrWritten = vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0]))
    expect(
      stderrWritten.some((line) => line.includes('https://auth.openai.com/codex/device'))
    ).toBe(true)
    expect(stderrWritten.some((line) => line.includes('7UNS-MDSUA'))).toBe(true)
  })

  it('keeps streaming live output correctly after the server-side outputTail truncates from the front', async () => {
    // Why: pending-account-login-registry.ts caps outputTail at 4_000 chars and
    // slices from the front once exceeded, so a length-only "already printed"
    // offset would stop advancing and silently drop everything printed after
    // the cap is first hit. Simulate that with a tiny window to prove the CLI
    // still prints every chunk instead of freezing once truncation starts.
    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-7' }),
      okFixture('req_poll_1', {
        loginId: 'login-7',
        provider: 'codex',
        status: 'in_progress',
        outputTail: 'AAAAAAAAAABBBBBBBBBB'
      }),
      okFixture('req_poll_2', {
        loginId: 'login-7',
        provider: 'codex',
        status: 'in_progress',
        // Front-truncated: the leading "AAAAA" from the previous tail is gone.
        outputTail: 'BBBBBCCCCCCCCCCDDDDD'
      }),
      okFixture('req_poll_3', {
        loginId: 'login-7',
        provider: 'codex',
        status: 'completed',
        outputTail: 'CCCCCCCCCCDDDDDEEEEE',
        state: {
          accounts: [{ id: 'acc-codex-3', email: 'codex3@example.com' }],
          activeAccountId: 'acc-codex-3'
        }
      })
    )

    await main(['accounts', 'add', '--provider', 'codex'], testCwd)

    const written = vi.mocked(process.stdout.write).mock.calls.map((call) => String(call[0]))
    // Every chunk (A, B, C, D, E) must appear exactly once in the combined
    // live stream — none dropped, none duplicated — despite the truncation.
    expect(written.join('')).toBe('AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDEEEEE')
  })

  it('adds a claude account without live output in --json mode, emitting one final JSON blob', async () => {
    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-2' }),
      okFixture('req_poll_1', {
        loginId: 'login-2',
        provider: 'claude',
        status: 'completed',
        outputTail: 'https://claude.ai/oauth/authorize?state=xyz\n',
        state: {
          accounts: [{ id: 'acc-claude-1', email: 'claude@example.com' }],
          activeAccountId: 'acc-claude-1'
        }
      })
    )

    await main(['accounts', 'add', '--provider', 'claude', '--json'], testCwd)

    expect(callMock).toHaveBeenCalledWith('accounts.addClaude', {})
    expect(vi.mocked(process.stdout.write)).not.toHaveBeenCalled()
    expect(vi.mocked(console.log)).toHaveBeenCalledTimes(1)
    const printed = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]))
    expect(printed.result.status).toBe('completed')
    expect(printed.result.loginUrl).toBe('https://claude.ai/oauth/authorize?state=xyz')
  })

  it('sets a nonzero exit code when the login fails', async () => {
    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-3' }),
      okFixture('req_poll_1', {
        loginId: 'login-3',
        provider: 'codex',
        status: 'failed',
        outputTail: 'error: denied\n',
        error: 'Codex sign-in was denied.'
      })
    )

    await main(['accounts', 'add', '--provider', 'codex'], testCwd)

    expect(process.exitCode).toBe(1)
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    expect(
      logged.some((line) => line.includes('codex login failed: Codex sign-in was denied.'))
    ).toBe(true)
  })

  it('times out client-side if the login never settles', async () => {
    vi.useFakeTimers()
    try {
      queueFixtures(callMock, okFixture('req_add', { loginId: 'login-4' }))
      callMock.mockImplementation(async (method: string) => {
        if (method === 'accounts.pollAdd') {
          vi.advanceTimersByTime(20_000)
          return okFixture('req_poll', {
            loginId: 'login-4',
            provider: 'codex',
            status: 'in_progress',
            outputTail: ''
          })
        }
        return okFixture('req_add', { loginId: 'login-4' })
      })

      await main(['accounts', 'add', '--provider', 'codex'], testCwd)

      expect(process.exitCode).toBe(1)
      expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
        'Timed out waiting for the codex login to finish'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes the readline interface left open by an unanswered paste-code prompt when the claude login times out client-side', async () => {
    // Why: this is issue #1's exact regression scenario — a Claude paste-code
    // prompt opens a readline.Interface (see promptForPastedCode) and is only
    // ever closed via pendingPrompt?.abandon(); before the try/finally fix,
    // that call only ran on the normal "status !== in_progress" return, never
    // on the timeout throw at the top of the loop, so an abandoned prompt kept
    // the whole CLI process alive waiting on stdin after the command had
    // already failed and exited. Mirrors "does not block on an unanswered
    // paste-code prompt" above for how the never-resolving questionMock is set up.
    questionMock.mockImplementationOnce(() => new Promise<string>(() => {}))
    vi.useFakeTimers()
    try {
      queueFixtures(callMock, okFixture('req_add', { loginId: 'login-18' }))
      callMock.mockImplementation(async (method: string) => {
        if (method === 'accounts.pollAdd') {
          vi.advanceTimersByTime(20_000)
          return okFixture('req_poll', {
            loginId: 'login-18',
            provider: 'claude',
            status: 'in_progress',
            outputTail: 'Paste code here if prompted > '
          })
        }
        return okFixture('req_add', { loginId: 'login-18' })
      })

      await main(['accounts', 'add', '--provider', 'claude'], testCwd)

      expect(process.exitCode).toBe(1)
      expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
        'Timed out waiting for the claude login to finish'
      )
      // The regression: without the try/finally fix, this never fires because
      // the timeout throw bypasses the loop's only (pre-fix) cleanup call.
      expect(closeMock).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('tolerates the real-world claude worst case (16min login + 20s status) without timing out client-side', async () => {
    vi.useFakeTimers()
    try {
      queueFixtures(callMock, okFixture('req_add', { loginId: 'login-6' }))
      let elapsedMs = 0
      // Why: pinned to ADD_ACCOUNT_TIMEOUT_MS.claude's own documented formula
      // in accounts.ts (16 * 60 * 1000 + 20_000 server-side worst case, before
      // its +10_000 client grace) rather than an arbitrary guess, so this test
      // actually fails if that constant regresses to a shorter value.
      const CLAUDE_WORST_CASE_SERVER_MS = 16 * 60 * 1000 + 20_000
      callMock.mockImplementation(async (method: string) => {
        if (method === 'accounts.pollAdd') {
          if (elapsedMs < CLAUDE_WORST_CASE_SERVER_MS) {
            // Why: cap the final increment so total elapsed lands exactly on
            // the worst-case boundary instead of overshooting past it (15s
            // poll windows don't evenly divide 980s) — overshooting would eat
            // into the +10s client grace and spuriously time out the test.
            const increment = Math.min(15_000, CLAUDE_WORST_CASE_SERVER_MS - elapsedMs)
            elapsedMs += increment
            vi.advanceTimersByTime(increment)
            return okFixture('req_poll_in_progress', {
              loginId: 'login-6',
              provider: 'claude',
              status: 'in_progress',
              outputTail: ''
            })
          }
          return okFixture('req_poll_done', {
            loginId: 'login-6',
            provider: 'claude',
            status: 'completed',
            outputTail: 'Signed in.\n',
            state: {
              accounts: [{ id: 'acc-claude-2', email: 'claude2@example.com' }],
              activeAccountId: 'acc-claude-2'
            }
          })
        }
        return okFixture('req_add', { loginId: 'login-6' })
      })

      await main(['accounts', 'add', '--provider', 'claude'], testCwd)

      expect(process.exitCode).toBeUndefined()
      expect(vi.mocked(console.error)).not.toHaveBeenCalled()
      const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
      expect(
        logged.some((line) => line.includes('Added claude account: claude2@example.com'))
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prompts for and submits a pasted Claude login code without blocking the poll loop, then completes', async () => {
    // Why: the prompt now runs detached from the poll loop (see
    // pollAccountAdd/submitPastedCodeInBackground), so there is no guaranteed
    // ordering between "submitLoginInput fires" and "the next pollAdd call
    // fires" — dispatch on method name instead of a strict call queue, and
    // keep polling "in_progress" until the background submit has actually
    // landed, mirroring the real race without depending on microtask timing.
    questionMock.mockResolvedValueOnce('pasted-code-123')
    let submitted = false
    let pollCount = 0
    callMock.mockImplementation(async (method: string) => {
      if (method === 'accounts.addClaude') {
        return okFixture('req_add', { loginId: 'login-11' })
      }
      if (method === 'accounts.submitLoginInput') {
        submitted = true
        return okFixture('req_submit', { submitted: true })
      }
      if (method === 'accounts.pollAdd') {
        pollCount += 1
        if (pollCount === 1) {
          return okFixture('req_poll_1', {
            loginId: 'login-11',
            provider: 'claude',
            status: 'in_progress',
            outputTail: 'Paste code here if prompted > '
          })
        }
        if (!submitted) {
          return okFixture('req_poll_wait', {
            loginId: 'login-11',
            provider: 'claude',
            status: 'in_progress',
            outputTail: 'Paste code here if prompted > '
          })
        }
        return okFixture('req_poll_2', {
          loginId: 'login-11',
          provider: 'claude',
          status: 'completed',
          outputTail: 'Paste code here if prompted > \nSigned in.\n',
          state: {
            accounts: [{ id: 'acc-claude-11', email: 'claude11@example.com' }],
            activeAccountId: 'acc-claude-11'
          }
        })
      }
      throw new Error(`unexpected method: ${method}`)
    })

    await main(['accounts', 'add', '--provider', 'claude'], testCwd)

    expect(createInterfaceMock).toHaveBeenCalledTimes(1)
    expect(questionMock).toHaveBeenCalledTimes(1)
    expect(closeMock).toHaveBeenCalled()
    const submitCalls = callMock.mock.calls.filter(
      ([method]) => method === 'accounts.submitLoginInput'
    )
    expect(submitCalls).toEqual([
      ['accounts.submitLoginInput', { loginId: 'login-11', input: 'pasted-code-123' }]
    ])
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    expect(logged.some((line) => line.includes('Added claude account: claude11@example.com'))).toBe(
      true
    )
  })

  it('does not block on an unanswered paste-code prompt when the login completes on its own', async () => {
    // Why: this is the exact bug scenario — Claude's CLI often completes the
    // login on its own (polling Anthropic's OAuth backend independently)
    // while the user is still looking for a code to paste. The prompt must
    // never block the loop from noticing the login already settled.
    questionMock.mockImplementationOnce(() => new Promise<string>(() => {}))
    let pollCount = 0
    callMock.mockImplementation(async (method: string) => {
      if (method === 'accounts.addClaude') {
        return okFixture('req_add', { loginId: 'login-15' })
      }
      if (method === 'accounts.pollAdd') {
        pollCount += 1
        if (pollCount === 1) {
          return okFixture('req_poll_1', {
            loginId: 'login-15',
            provider: 'claude',
            status: 'in_progress',
            outputTail: 'Paste code here if prompted > '
          })
        }
        return okFixture('req_poll_2', {
          loginId: 'login-15',
          provider: 'claude',
          status: 'completed',
          outputTail: 'Paste code here if prompted > \nSigned in.\n',
          state: {
            accounts: [{ id: 'acc-claude-15', email: 'claude15@example.com' }],
            activeAccountId: 'acc-claude-15'
          }
        })
      }
      throw new Error(`unexpected method: ${method}`)
    })

    // If the old blocking implementation were still in place, this await
    // would hang forever on the never-resolving questionMock promise.
    await main(['accounts', 'add', '--provider', 'claude'], testCwd)

    expect(process.exitCode).toBeUndefined()
    const stderrWritten = vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0]))
    expect(stderrWritten.some((line) => line.includes('Failed to submit the pasted code'))).toBe(
      false
    )
    expect(callMock.mock.calls.some(([method]) => method === 'accounts.submitLoginInput')).toBe(
      false
    )
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    expect(logged.some((line) => line.includes('Added claude account: claude15@example.com'))).toBe(
      true
    )
    // Why: the poll loop must release the still-open readline.Interface once
    // the login settles, or the abandoned prompt would keep the process
    // alive waiting for stdin input nobody needs anymore.
    expect(closeMock).toHaveBeenCalled()
  })

  it('quietly notes (rather than alarms) when a late pasted-code submit finds the login already settled', async () => {
    // Why: the user finishing typing after the login already completed is
    // now the expected common outcome (see the bug report), not a real
    // failure — it must be reported reassuringly, not with the same wording
    // used for a genuine submit failure.
    let resolveQuestion: ((value: string) => void) | undefined
    questionMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveQuestion = resolve
        })
    )
    let pollCount = 0
    callMock.mockImplementation(async (method: string) => {
      if (method === 'accounts.addClaude') {
        return okFixture('req_add', { loginId: 'login-17' })
      }
      if (method === 'accounts.submitLoginInput') {
        throw new RuntimeClientError('invalid_state', 'That account login no longer exists.')
      }
      if (method === 'accounts.pollAdd') {
        pollCount += 1
        if (pollCount === 1) {
          return okFixture('req_poll_1', {
            loginId: 'login-17',
            provider: 'claude',
            status: 'in_progress',
            outputTail: 'Paste code here if prompted > '
          })
        }
        return okFixture('req_poll_2', {
          loginId: 'login-17',
          provider: 'claude',
          status: 'completed',
          outputTail: 'Paste code here if prompted > \nSigned in.\n',
          state: {
            accounts: [{ id: 'acc-claude-17', email: 'claude17@example.com' }],
            activeAccountId: 'acc-claude-17'
          }
        })
      }
      throw new Error(`unexpected method: ${method}`)
    })

    await main(['accounts', 'add', '--provider', 'claude'], testCwd)
    expect(process.exitCode).toBeUndefined()

    // The command already finished; now the user finally finishes typing.
    resolveQuestion?.('too-late-code')
    await vi.waitFor(() => {
      expect(callMock.mock.calls.some(([method]) => method === 'accounts.submitLoginInput')).toBe(
        true
      )
    })

    const stderrWritten = vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0]))
    expect(stderrWritten.some((line) => line.includes('Failed to submit the pasted code'))).toBe(
      false
    )
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    expect(
      logged.some((line) => line.includes('already completed before the pasted code was submitted'))
    ).toBe(true)
  })

  it('skips the paste-code prompt without hanging when stdin is not an interactive terminal', async () => {
    // Why: readline/promises' rl.question() never settles when stdin has no
    // data and stays open (CI, `< /dev/null`, a closed fd, or a piped, silent
    // stream) — this test guards the isTTY short-circuit that prevents that.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-14' }),
      okFixture('req_poll_1', {
        loginId: 'login-14',
        provider: 'claude',
        status: 'in_progress',
        outputTail: 'Paste code here if prompted > '
      }),
      okFixture('req_poll_2', {
        loginId: 'login-14',
        provider: 'claude',
        status: 'completed',
        outputTail: 'Paste code here if prompted > \nSigned in.\n',
        state: {
          accounts: [{ id: 'acc-claude-14', email: 'claude14@example.com' }],
          activeAccountId: 'acc-claude-14'
        }
      })
    )

    await main(['accounts', 'add', '--provider', 'claude'], testCwd)

    expect(createInterfaceMock).not.toHaveBeenCalled()
    expect(callMock.mock.calls.some(([method]) => method === 'accounts.submitLoginInput')).toBe(
      false
    )
    const stderrWritten = vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0]))
    expect(
      stderrWritten.some((line) => line.includes('stdin is not an interactive terminal'))
    ).toBe(true)
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    expect(logged.some((line) => line.includes('Added claude account: claude14@example.com'))).toBe(
      true
    )
  })

  it('never prompts for pasted input on a codex add flow, even if similar text appears in output', async () => {
    queueFixtures(
      callMock,
      okFixture('req_add', { loginId: 'login-12' }),
      okFixture('req_poll_1', {
        loginId: 'login-12',
        provider: 'codex',
        status: 'completed',
        outputTail: 'Paste code here if prompted > (this text should never trigger for codex)\n',
        state: {
          accounts: [{ id: 'acc-codex-12', email: 'codex12@example.com' }],
          activeAccountId: 'acc-codex-12'
        }
      })
    )

    await main(['accounts', 'add', '--provider', 'codex'], testCwd)

    expect(createInterfaceMock).not.toHaveBeenCalled()
    expect(callMock.mock.calls.some(([method]) => method === 'accounts.submitLoginInput')).toBe(
      false
    )
  })

  it('does not crash the command when submitting the pasted code fails for a genuine reason, and keeps polling', async () => {
    questionMock.mockResolvedValueOnce('pasted-code-456')
    let submitAttempted = false
    let pollCount = 0
    callMock.mockImplementation(async (method: string) => {
      if (method === 'accounts.addClaude') {
        return okFixture('req_add', { loginId: 'login-13' })
      }
      if (method === 'accounts.submitLoginInput') {
        submitAttempted = true
        throw new Error('submit failed')
      }
      if (method === 'accounts.pollAdd') {
        pollCount += 1
        if (pollCount === 1) {
          return okFixture('req_poll_1', {
            loginId: 'login-13',
            provider: 'claude',
            status: 'in_progress',
            outputTail: 'Paste code here if prompted > '
          })
        }
        if (!submitAttempted) {
          return okFixture('req_poll_wait', {
            loginId: 'login-13',
            provider: 'claude',
            status: 'in_progress',
            outputTail: ''
          })
        }
        return okFixture('req_poll_2', {
          loginId: 'login-13',
          provider: 'claude',
          status: 'completed',
          outputTail: 'Signed in.\n',
          state: {
            accounts: [{ id: 'acc-claude-13', email: 'claude13@example.com' }],
            activeAccountId: 'acc-claude-13'
          }
        })
      }
      throw new Error(`unexpected method: ${method}`)
    })

    await main(['accounts', 'add', '--provider', 'claude'], testCwd)

    expect(process.exitCode).toBeUndefined()
    const stderrWritten = vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0]))
    expect(stderrWritten.some((line) => line.includes('Failed to submit the pasted code'))).toBe(
      true
    )
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
    expect(logged.some((line) => line.includes('Added claude account: claude13@example.com'))).toBe(
      true
    )
  })
})
