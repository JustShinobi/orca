import { homedir } from 'node:os'
import { join, win32 as pathWin32 } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  resolveLocalAccountRuntimeTarget,
  type LocalAccountRuntimeTarget
} from '../../shared/local-account-runtime'
import type { GlobalSettings } from '../../shared/types'
import { getDefaultWslDistro, getWslHome } from '../wsl'

export type KimiHomeResolution = LocalAccountRuntimeTarget & {
  /** null when the WSL distro's home could not be probed (distro missing/stopped). */
  path: string | null
}

// Why: match the CLI's `KIMI_CODE_HOME ?? ~/.kimi-code` resolution so we read the
// same files the running Kimi CLI writes.
export function getHostKimiHome(): string {
  return process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code')
}

/**
 * Kimi has no per-account runtime switcher, so it follows the local-account
 * runtime policy. WSL is Windows-only — pin everywhere else so no `wsl.exe`
 * probe is attempted on a stale `wsl` setting synced from a Windows machine.
 */
export function getKimiRuntimeTarget(
  settings: GlobalSettings,
  platform: NodeJS.Platform = process.platform
): LocalAccountRuntimeTarget {
  if (platform !== 'win32') {
    return { runtime: 'host', wslDistro: null }
  }
  return resolveLocalAccountRuntimeTarget(settings, platform)
}

/** Resolve a runtime target to the Kimi home Orca should read (UNC path for WSL). */
export function resolveKimiHome(
  target: LocalAccountRuntimeTarget,
  platform: NodeJS.Platform = process.platform
): KimiHomeResolution {
  if (target.runtime !== 'wsl' || platform !== 'win32') {
    return { runtime: 'host', wslDistro: null, path: getHostKimiHome() }
  }
  const distro = target.wslDistro?.trim() || getDefaultWslDistro()
  if (!distro) {
    return { runtime: 'wsl', wslDistro: null, path: null }
  }
  const home = getWslHome(distro)
  // KIMI_CODE_HOME describes the Windows host process, never the distro's home.
  return { runtime: 'wsl', wslDistro: distro, path: home ? joinKimiHome(home) : null }
}

function joinKimiHome(home: string): string {
  return parseWslUncPath(home) ? pathWin32.join(home, '.kimi-code') : join(home, '.kimi-code')
}
