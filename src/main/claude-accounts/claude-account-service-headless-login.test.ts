import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { readActiveClaudeKeychainCredentials } from './keychain'
import {
  createService,
  resetClaudeKeychainMocks,
  restorePlatform,
  setPlatform
} from './claude-account-service-test-harness'

const CLAUDE_SERVICE_TEST_ROOT = join(tmpdir(), 'orca-claude-service-headless-login-test')

vi.mock('electron', () => ({
  app: {
    getPath: () => CLAUDE_SERVICE_TEST_ROOT
  }
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: vi.fn(() => 'claude')
}))

vi.mock('./keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(async () => {}),
  deleteManagedClaudeKeychainCredentials: vi.fn(async () => {}),
  readActiveClaudeKeychainCredentials: vi.fn(),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(),
  writeActiveClaudeKeychainCredentials: vi.fn(async () => {}),
  writeManagedClaudeKeychainCredentials: vi.fn(async () => {})
}))

describe('ClaudeAccountService headless and streaming login', () => {
  beforeEach(() => {
    setPlatform('darwin')
    resetClaudeKeychainMocks()
  })

  afterEach(() => {
    restorePlatform()
  })

  it('forwards raw stdout/stderr chunks to onOutput during a command', async () => {
    vi.resetModules()
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: () => void
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      const onOutput = vi.fn()
      const commandPromise = (
        service as unknown as {
          runClaudeCommand(
            args: string[],
            configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
            timeoutMs: number,
            options?: { keepStdinOpen?: boolean; onOutput?: (chunk: string) => void }
          ): Promise<string>
        }
      ).runClaudeCommand(
        ['auth', 'login', '--claudeai'],
        { windowsPath: '/tmp/claude-auth', linuxPath: null, wslDistro: null },
        1000,
        { keepStdinOpen: true, onOutput }
      )

      child.stdout.write('open this URL to sign in\n')
      child.stderr.write('warning: something\n')
      queueMicrotask(() => child.emit('close', 0))
      await commandPromise

      expect(onOutput).toHaveBeenCalledWith('open this URL to sign in\n')
      expect(onOutput).toHaveBeenCalledWith('warning: something\n')
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('still enforces the command timeout when onOutput is provided', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: () => void
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      const onOutput = vi.fn()
      const commandPromise = (
        service as unknown as {
          runClaudeCommand(
            args: string[],
            configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
            timeoutMs: number,
            options?: { keepStdinOpen?: boolean; onOutput?: (chunk: string) => void }
          ): Promise<string>
        }
      ).runClaudeCommand(
        ['login'],
        { windowsPath: '/tmp/claude-auth', linuxPath: null, wslDistro: null },
        1000,
        { keepStdinOpen: true, onOutput }
      )
      const rejection = expect(commandPromise).rejects.toThrow(
        'Claude sign-in took too long to finish.'
      )

      await vi.advanceTimersByTimeAsync(1000)

      await rejection
      expect(child.kill).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      vi.doUnmock('node:child_process')
    }
  })

  it('invokes onChildReady with a writer that writes pasted text into the child stdin', async () => {
    vi.resetModules()
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: () => void
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      const stdinChunks: string[] = []
      child.stdin.on('data', (chunk: Buffer) => stdinChunks.push(chunk.toString()))
      let capturedWriteInput: ((text: string) => void) | undefined
      const commandPromise = (
        service as unknown as {
          runClaudeCommand(
            args: string[],
            configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
            timeoutMs: number,
            options?: {
              keepStdinOpen?: boolean
              onChildReady?: (writeInput: (text: string) => void) => void
            }
          ): Promise<string>
        }
      ).runClaudeCommand(
        ['auth', 'login', '--claudeai'],
        { windowsPath: '/tmp/claude-auth', linuxPath: null, wslDistro: null },
        1000,
        {
          keepStdinOpen: true,
          onChildReady: (writeInput) => {
            capturedWriteInput = writeInput
          }
        }
      )

      expect(capturedWriteInput).toBeInstanceOf(Function)
      capturedWriteInput?.('pasted-code-123')
      queueMicrotask(() => child.emit('close', 0))
      await commandPromise

      expect(stdinChunks.join('')).toBe('pasted-code-123\n')
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('logs and continues when writing pasted input to a closed stdin throws', async () => {
    vi.resetModules()
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: () => void
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    vi.spyOn(child.stdin, 'write').mockImplementation(() => {
      throw new Error('stream closed')
    })
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      let capturedWriteInput: ((text: string) => void) | undefined
      const commandPromise = (
        service as unknown as {
          runClaudeCommand(
            args: string[],
            configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
            timeoutMs: number,
            options?: {
              keepStdinOpen?: boolean
              onChildReady?: (writeInput: (text: string) => void) => void
            }
          ): Promise<string>
        }
      ).runClaudeCommand(
        ['auth', 'login', '--claudeai'],
        { windowsPath: '/tmp/claude-auth', linuxPath: null, wslDistro: null },
        1000,
        {
          keepStdinOpen: true,
          onChildReady: (writeInput) => {
            capturedWriteInput = writeInput
          }
        }
      )

      expect(() => capturedWriteInput?.('pasted-code-123')).not.toThrow()
      queueMicrotask(() => child.emit('close', 0))
      await commandPromise

      expect(warnSpy).toHaveBeenCalledWith(
        '[claude-accounts] Failed to write pasted input to Claude login:',
        expect.any(Error)
      )
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('uses REMOTE_LOGIN_TIMEOUT_MS instead of LOGIN_TIMEOUT_MS for a headless remote-auth login', async () => {
    setPlatform('linux')
    vi.resetModules()
    vi.useFakeTimers()
    vi.mocked(readActiveClaudeKeychainCredentials).mockResolvedValue(null)
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: () => void
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))

    try {
      const { ClaudeAccountService } = await import('./service')
      const service = new ClaudeAccountService(
        createService() as never,
        createService() as never,
        createService() as never
      )
      const capturePromise = (
        service as unknown as {
          runClaudeLoginAndCapture(
            location?: unknown,
            onOutput?: (chunk: string) => void,
            options?: { remoteAuth?: boolean }
          ): Promise<unknown>
        }
      ).runClaudeLoginAndCapture(undefined, undefined, { remoteAuth: true })
      const rejection = expect(capturePromise).rejects.toThrow(
        'Claude sign-in took too long to finish.'
      )

      await vi.advanceTimersByTimeAsync(180_000)
      expect(child.kill).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(16 * 60 * 1000 - 180_000)

      await rejection
      expect(child.kill).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      vi.doUnmock('node:child_process')
    }
  })
})
