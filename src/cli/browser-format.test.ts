import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatScreenshot, prepareBrowserScreenshotCliJsonResult } from './browser-format'
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

describe('prepareBrowserScreenshotCliJsonResult', () => {
  it('exports inline screenshot data to a temp file', () => {
    testScreenshotDir = mkdtempSync(join(tmpdir(), 'orca-browser-format-test-'))
    process.env.ORCA_BROWSER_SCREENSHOT_TMPDIR = testScreenshotDir
    const screenshotData = Buffer.from('png-data').toString('base64')

    const output = prepareBrowserScreenshotCliJsonResult(screenshotResponse(screenshotData))

    const result = output.result
    expect(result.data).toBeUndefined()
    expect(result.dataOmitted).toBe(true)
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

    prepareBrowserScreenshotCliJsonResult(
      screenshotResponse(Buffer.from('png-data').toString('base64'))
    )

    expect(existsSync(expiredPath)).toBe(false)
  })

  it('keeps inline screenshot data when temp export fails', () => {
    testScreenshotDir = join(tmpdir(), `orca-browser-format-blocked-${Date.now()}`)
    writeFileSync(testScreenshotDir, 'not-a-directory')
    process.env.ORCA_BROWSER_SCREENSHOT_TMPDIR = testScreenshotDir
    const screenshotData = Buffer.from('png-data').toString('base64')

    const output = prepareBrowserScreenshotCliJsonResult(screenshotResponse(screenshotData))

    expect(output.result.data).toBe(screenshotData)
    expect(output.result.path).toBeUndefined()
    expect(output.result.dataOmitted).toBeUndefined()
  })

  it('leaves results without inline data untouched', () => {
    const response = screenshotResponse(undefined)

    const output = prepareBrowserScreenshotCliJsonResult(response)

    expect(output).toBe(response)
  })
})

describe('formatScreenshot', () => {
  it('reports the base64 payload size when data is inline', () => {
    const output = formatScreenshot({
      data: Buffer.from('png-data').toString('base64'),
      format: 'png'
    })

    expect(output).toBe('Screenshot captured (png, 8 bytes)')
  })

  it('reports the temp file path when data was exported', () => {
    const output = formatScreenshot({
      format: 'jpeg',
      path: '/tmp/orca-browser-screenshots/req_1-screenshot.jpeg',
      dataOmitted: true,
      expiresAt: new Date().toISOString()
    })

    expect(output).toBe(
      'Screenshot captured (jpeg, saved to /tmp/orca-browser-screenshots/req_1-screenshot.jpeg)'
    )
  })
})
