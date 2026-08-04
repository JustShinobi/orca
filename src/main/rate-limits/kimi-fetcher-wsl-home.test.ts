import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const files = vi.hoisted(() => new Map<string, string>())

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))
vi.mock('node:fs', () => ({
  existsSync: (path: string) => files.has(path),
  readFileSync: (path: string) => {
    const contents = files.get(path)
    if (contents === undefined) {
      throw new Error(`ENOENT: ${path}`)
    }
    return contents
  }
}))
// Posix-shaped host home so `node:path.join` behaves the same on every test runner.
vi.mock('node:os', () => ({ homedir: () => '/home/neil' }))

import { fetchKimiRateLimits } from './kimi-fetcher'

const HOST_CREDENTIALS = '/home/neil/.kimi-code/credentials/kimi-code.json'
const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\neil\\.kimi-code'
const WSL_CREDENTIALS = `${WSL_HOME}\\credentials\\kimi-code.json`

function credentials(token: string, expiresInSeconds: number): string {
  return JSON.stringify({
    access_token: token,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds
  })
}

function usageResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      usage: { limit: '1000', remaining: '900' },
      limits: [
        {
          window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' },
          detail: { limit: '100', remaining: '40' }
        }
      ]
    })
  } as Response
}

describe('fetchKimiRateLimits with a WSL credentials home', () => {
  beforeEach(() => {
    files.clear()
    netFetchMock.mockReset()
    netFetchMock.mockResolvedValue(usageResponse())
    // The Windows-side copy stopped rotating when the CLI moved into WSL.
    files.set(HOST_CREDENTIALS, credentials('host-stale', -3 * 24 * 3600))
    files.set(WSL_CREDENTIALS, credentials('wsl-fresh', 13 * 60))
  })

  it('reads the WSL token instead of the stale host one', async () => {
    const result = await fetchKimiRateLimits({
      home: { runtime: 'wsl', wslDistro: 'Ubuntu', path: WSL_HOME }
    })

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(60)
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(netFetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer wsl-fresh')
  })

  it('still reads the host home by default', async () => {
    const result = await fetchKimiRateLimits()

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('delegated-refresh-required')
    expect(result.error).toContain('on the computer running Orca')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('points an expired WSL session at the distro to rerun kimi in', async () => {
    files.set(WSL_CREDENTIALS, credentials('wsl-stale', -60))

    const result = await fetchKimiRateLimits({
      home: { runtime: 'wsl', wslDistro: 'Ubuntu', path: WSL_HOME }
    })

    expect(result.error).toBe(
      'Kimi session expired — run kimi inside WSL (Ubuntu), then retry usage.'
    )
    expect(result.usageMetadata?.failureKind).toBe('delegated-refresh-required')
  })

  it('reports an unresolvable WSL home instead of falling back to host credentials', async () => {
    const result = await fetchKimiRateLimits({
      home: { runtime: 'wsl', wslDistro: 'Ubuntu', path: null }
    })

    expect(result.status).toBe('error')
    expect(result.error).toBe('WSL Kimi home unavailable for Ubuntu')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('reports not signed in when the WSL home has no credentials file', async () => {
    files.delete(WSL_CREDENTIALS)

    const result = await fetchKimiRateLimits({
      home: { runtime: 'wsl', wslDistro: 'Ubuntu', path: WSL_HOME }
    })

    expect(result.status).toBe('unavailable')
  })
})
