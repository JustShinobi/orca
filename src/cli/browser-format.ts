import { formatBase64PayloadByteCount } from './base64-payload-byte-count'
import { exportScreenshotToTempFile } from './screenshot-temp-export'
import type { RuntimeRpcSuccess } from './runtime-client'
import type {
  BrowserProfileListResult,
  BrowserScreenshotResult,
  BrowserSnapshotResult,
  BrowserTabCurrentResult,
  BrowserTabListResult,
  BrowserTabProfileCloneResult,
  BrowserTabProfileShowResult,
  BrowserTabShowResult
} from '../shared/runtime-types'

export function formatSnapshot(result: BrowserSnapshotResult): string {
  const header = `page: ${result.browserPageId}\n${result.title} — ${result.url}\n`
  return header + result.snapshot
}

export function formatScreenshot(result: BrowserScreenshotResult): string {
  const detail = result.data
    ? formatBase64PayloadByteCount(result.data)
    : `saved to ${result.path ?? 'temporary file'}`
  return `Screenshot captured (${result.format}, ${detail})`
}

export function prepareBrowserScreenshotCliJsonResult(
  response: RuntimeRpcSuccess<BrowserScreenshotResult>
): RuntimeRpcSuccess<BrowserScreenshotResult> {
  const result = response.result
  if (!result || typeof result.data !== 'string' || result.data.length === 0) {
    return response
  }
  try {
    const exported = exportScreenshotToTempFile({
      fileStem: response.id,
      data: result.data,
      format: result.format,
      tempDirEnvVar: 'ORCA_BROWSER_SCREENSHOT_TMPDIR',
      tempDirName: 'orca-browser-screenshots'
    })
    return {
      ...response,
      result: { ...result, data: undefined, ...exported }
    }
  } catch {
    // Why: temp-file export is an ergonomics optimization; keep inline screenshot
    // data when disk, permissions, or path validation would otherwise fail --json.
    return response
  }
}

export function formatTabList(result: BrowserTabListResult): string {
  return formatTabListWithProfiles(result, false)
}

export function formatTabListWithProfiles(
  result: BrowserTabListResult,
  showProfile: boolean
): string {
  if (result.tabs.length === 0) {
    return 'No browser tabs open.'
  }
  return result.tabs
    .map((t) => {
      const marker = t.active ? '* ' : '  '
      const profile = showProfile ? `  [${t.profileLabel ?? t.profileId ?? 'Unknown'}]` : ''
      return `${marker}[${t.index}] ${t.browserPageId}  ${t.title} — ${t.url}${profile}`
    })
    .join('\n')
}

export function formatBrowserProfileList(result: BrowserProfileListResult): string {
  if (result.profiles.length === 0) {
    return 'No browser profiles found.'
  }
  return result.profiles
    .map((profile) => {
      const marker = profile.scope === 'default' ? '* ' : '  '
      const source = profile.source?.browserFamily ?? 'none'
      const userAgent = profile.userAgentMode === 'native' ? '  ua:native' : ''
      return `${marker}${profile.id}  ${profile.label}  ${profile.scope}  source:${source}${userAgent}`
    })
    .join('\n')
}

export function formatTabShow(result: BrowserTabShowResult | BrowserTabCurrentResult): string {
  const tab = result.tab
  return [
    `page: ${tab.browserPageId}`,
    `title: ${tab.title}`,
    `url: ${tab.url}`,
    `active: ${tab.active}`,
    `worktree: ${tab.worktreeId ?? 'unknown'}`,
    `profile: ${tab.profileLabel ?? tab.profileId ?? 'unknown'}`
  ].join('\n')
}

export function formatTabProfileShow(result: BrowserTabProfileShowResult): string {
  return [
    `page: ${result.browserPageId}`,
    `worktree: ${result.worktreeId ?? 'unknown'}`,
    `profileId: ${result.profileId ?? 'default'}`,
    `profile: ${result.profileLabel ?? result.profileId ?? 'default'}`
  ].join('\n')
}

export function formatTabProfileClone(result: BrowserTabProfileCloneResult): string {
  return `Cloned ${result.sourceBrowserPageId} to ${result.browserPageId} (${result.profileLabel ?? result.profileId ?? 'default'})`
}
