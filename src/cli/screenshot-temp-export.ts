import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCREENSHOT_TEMP_TTL_MS = 24 * 60 * 60 * 1000
const SCREENSHOT_TEMP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const SCREENSHOT_TEMP_CLEANUP_MARKER = '.last-cleanup'

export type ScreenshotTempExport = {
  path: string
  dataOmitted: true
  expiresAt: string
}

export function exportScreenshotToTempFile(params: {
  fileStem: string
  data: string
  format: unknown
  tempDirEnvVar: string
  tempDirName: string
}): ScreenshotTempExport {
  const outputDir = screenshotTempDir(params.tempDirEnvVar, params.tempDirName)
  cleanupScreenshotTempDir(outputDir)
  const extension = params.format === 'png' ? 'png' : params.format === 'jpeg' ? 'jpeg' : 'img'
  const outputPath = join(outputDir, `${safeCliFileStem(params.fileStem)}-screenshot.${extension}`)
  writeFileSync(outputPath, Buffer.from(params.data, 'base64'), { mode: 0o600 })
  return {
    path: outputPath,
    dataOmitted: true,
    expiresAt: new Date(Date.now() + SCREENSHOT_TEMP_TTL_MS).toISOString()
  }
}

function screenshotTempDir(tempDirEnvVar: string, tempDirName: string): string {
  const outputDir = process.env[tempDirEnvVar] || join(tmpdir(), tempDirName)
  mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(outputDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe screenshot temp path: ${outputDir}`)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Screenshot temp path is not owned by the current user: ${outputDir}`)
  }
  chmodSync(outputDir, 0o700)
  return outputDir
}

function cleanupScreenshotTempDir(outputDir: string): void {
  const now = Date.now()
  const markerPath = join(outputDir, SCREENSHOT_TEMP_CLEANUP_MARKER)
  try {
    // Why: agents can call CLI screenshot commands in loops; a marker keeps
    // temp cleanup from becoming a synchronous directory scan per screenshot.
    if (statSync(markerPath).mtimeMs > now - SCREENSHOT_TEMP_CLEANUP_INTERVAL_MS) {
      return
    }
  } catch {
    // Missing or unreadable marker means this process should attempt cleanup.
  }

  const cutoff = now - SCREENSHOT_TEMP_TTL_MS
  for (const entry of readdirSync(outputDir)) {
    if (
      !entry.endsWith('-screenshot.png') &&
      !entry.endsWith('-screenshot.jpeg') &&
      !entry.endsWith('-screenshot.img')
    ) {
      continue
    }
    const path = join(outputDir, entry)
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true })
      }
    } catch {
      // Best-effort cleanup only; formatting should not fail because a temp file raced.
    }
  }
  try {
    writeFileSync(markerPath, `${now}\n`, { mode: 0o600 })
  } catch {
    // Best-effort marker only; stale cleanup state should not hide a screenshot.
  }
}

function safeCliFileStem(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_')
}
