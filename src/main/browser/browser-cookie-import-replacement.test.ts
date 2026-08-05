import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appGetPathMock,
  clearPendingCookieImportMock,
  execFileSyncMock,
  sessionFromPartitionMock,
  setPendingCookieImportMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  clearPendingCookieImportMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  setPendingCookieImportMock: vi.fn()
}))

vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    setPendingCookieImport: setPendingCookieImportMock,
    clearPendingCookieImport: clearPendingCookieImportMock,
    persistUserAgent: vi.fn()
  }
}))
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))
vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  dialog: { showOpenDialog: vi.fn() },
  session: { fromPartition: sessionFromPartitionMock }
}))

import { importCookiesFromBrowser, importCookiesFromFile } from './browser-cookie-import'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('validated cookie replacement', () => {
  let cookiesGetMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-replacement-test-'))
    cookiesGetMock = vi.fn().mockResolvedValue([])
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset().mockReturnValue({
      cookies: { get: cookiesGetMock, remove: cookiesRemoveMock, set: cookiesSetMock }
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeCookies(cookies: unknown[]): string {
    const filePath = join(tmpDir, 'cookies.json')
    writeFileSync(filePath, JSON.stringify(cookies))
    return filePath
  }

  it('filters Google source-bound cookies before replacing imported domain scopes', async () => {
    cookiesGetMock.mockResolvedValue([
      cookie('.google.com', 'old-google'),
      cookie('.accounts.google.com', 'old-accounts', '/signin'),
      cookie('.unrelated.com', 'keep'),
      cookie('.google.com.evil.example', 'keep-suffix-confusion')
    ])
    const filePath = writeCookies([
      { domain: '.google.com', name: 'SIDCC', value: 'source-bound', secure: true },
      { domain: '.google.com', name: 'SAPISID', value: 'google-session', secure: true },
      { domain: '.example.com', name: 'SIDCC', value: 'not-google', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok && result.summary).toMatchObject({
      totalCookies: 3,
      importedCookies: 2,
      skippedCookies: 1,
      domains: ['example.com', 'google.com']
    })
    expect(cookiesRemoveMock.mock.calls).toEqual([
      ['https://google.com/', 'old-google'],
      ['https://accounts.google.com/signin', 'old-accounts']
    ])
    expect(cookiesSetMock.mock.calls.map(([details]) => details.name)).toEqual(['SAPISID', 'SIDCC'])
    expect(Math.max(...cookiesRemoveMock.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...cookiesSetMock.mock.invocationCallOrder)
    )
  })

  it('does not touch the store when every valid entry is source-bound', async () => {
    const filePath = writeCookies([
      { domain: '.google.com', name: 'AEC', value: 'source-bound', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok && result.summary).toEqual({
      totalCookies: 1,
      importedCookies: 0,
      skippedCookies: 1,
      domains: []
    })
    expect(cookiesGetMock).not.toHaveBeenCalled()
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })

  it('fails closed when existing cookies cannot be replaced', async () => {
    cookiesGetMock.mockRejectedValue(new Error('cookie store unavailable'))
    const filePath = writeCookies([
      { domain: '.example.com', name: 'session', value: 'new', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok).toBe(false)
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })
})

describe('native Chromium integrity-cookie accounting', () => {
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-accounting-test-'))
    appGetPathMock.mockReset().mockReturnValue(join(tmpDir, 'userData'))
    execFileSyncMock.mockReset().mockImplementation(() => {
      throw new Error('OS browser version lookup unavailable')
    })
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset().mockReturnValue({
      cookies: {
        flushStore: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        set: cookiesSetMock
      },
      clearStorageData: vi.fn().mockResolvedValue(undefined)
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('includes domain-scoped integrity cookies in skippedCookies', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { domain: '.google.com', name: 'AEC', value: 'source-bound' },
      { domain: '.google.com', name: 'SAPISID', value: 'google-session' },
      { domain: '.example.com', name: 'AEC', value: 'not-google' }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )
      expect(result.ok && result.summary).toMatchObject({
        totalCookies: 3,
        importedCookies: 2,
        skippedCookies: 1,
        domains: ['example.com', 'google.com']
      })
      expect(cookiesSetMock.mock.calls.map(([details]) => details.name)).toEqual(['SAPISID', 'AEC'])
    } finally {
      platformSpy.mockRestore()
    }
  })
})

function cookie(domain: string, name: string, path = '/') {
  return { domain, name, path, secure: true, sameSite: 'unspecified', value: 'old' }
}

function chromeBrowser(cookiesPath: string) {
  return {
    family: 'chrome' as const,
    label: 'Google Chrome',
    cookiesPath,
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
    profiles: [{ name: 'Default', directory: 'Default' }],
    selectedProfile: 'Default'
  }
}
