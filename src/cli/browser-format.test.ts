import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatScreenshot, saveBrowserScreenshot } from './browser-format'
import type { RuntimeRpcSuccess } from './runtime-client'
import type { BrowserScreenshotResult } from '../shared/runtime-types'

let testScreenshotDir: string | null = null

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.ORCA_BROWSER_SCREENSHOT_TMPDIR
  if (testScreenshotDir) {
    rmSync(testScreenshotDir, { recursive: true, force: true })
    testScreenshotDir = null
  }
})

function screenshotResponse(data: string | undefined): RuntimeRpcSuccess<BrowserScreenshotResult> {
  return {
    id: 'req/1',
    ok: true,
    result: { data, format: 'png' },
    _meta: { runtimeId: 'runtime-1' }
  }
}

describe('saveBrowserScreenshot', () => {
  it('exports inline screenshot data to a temp file', () => {
    testScreenshotDir = mkdtempSync(join(tmpdir(), 'orca-browser-format-test-'))
    process.env.ORCA_BROWSER_SCREENSHOT_TMPDIR = testScreenshotDir
    const screenshotData = Buffer.from('png-data').toString('base64')

    const output = saveBrowserScreenshot(screenshotResponse(screenshotData))

    const result = output.result
    expect(result.expiresAt).toBeDefined()
    expect(result.path).toContain('req_1-screenshot.png')
    expect(readFileSync(result.path as string, 'utf8')).toBe('png-data')
    expect(existsSync(join(testScreenshotDir, '.last-cleanup'))).toBe(true)
  })

  it('removes expired screenshot temp files when cleanup is due', () => {
    testScreenshotDir = mkdtempSync(join(tmpdir(), 'orca-browser-format-test-'))
    process.env.ORCA_BROWSER_SCREENSHOT_TMPDIR = testScreenshotDir
    const expiredPath = join(testScreenshotDir, 'old-screenshot.png')
    writeFileSync(expiredPath, 'old')
    const expired = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(expiredPath, expired, expired)

    saveBrowserScreenshot(screenshotResponse(Buffer.from('png-data').toString('base64')))

    expect(existsSync(expiredPath)).toBe(false)
  })

  it('leaves results without inline data untouched', () => {
    const response = screenshotResponse(undefined)

    const output = saveBrowserScreenshot(response)

    expect(output.result.path).toBeUndefined()
  })
})

describe('formatScreenshot', () => {
  it('reports the temp file path when saved', () => {
    const output = formatScreenshot({
      format: 'jpeg',
      path: '/tmp/orca-browser-screenshots/req_1-screenshot.jpeg',
      expiresAt: new Date().toISOString()
    })

    expect(output).toBe(
      'Screenshot saved to /tmp/orca-browser-screenshots/req_1-screenshot.jpeg (jpeg)'
    )
  })

  it('reports when screenshot is unchanged', () => {
    const output = formatScreenshot({
      format: 'png',
      changed: false
    })

    expect(output).toBe('Screenshot unchanged since the last --if-changed capture; nothing saved')
  })
})
