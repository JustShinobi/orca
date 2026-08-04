import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  getDefaultWslDistro: vi.fn<() => string | null>(),
  getWslHome: vi.fn<(distro: string) => string | null>()
}))

vi.mock('../wsl', () => wslMocks)
vi.mock('node:os', () => ({ homedir: () => 'C:\\Users\\neil' }))

import { getHostKimiHome, getKimiRuntimeTarget, resolveKimiHome } from './kimi-runtime-home'
import type { GlobalSettings } from '../../shared/types'

function settings(overrides: Partial<GlobalSettings>): GlobalSettings {
  return overrides as GlobalSettings
}

describe('getKimiRuntimeTarget', () => {
  it('follows the configured WSL runtime on Windows', () => {
    expect(
      getKimiRuntimeTarget(
        settings({ localAccountRuntime: 'wsl', localAccountWslDistro: ' Ubuntu ' }),
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('pins to host off Windows even when the setting says wsl', () => {
    expect(
      getKimiRuntimeTarget(
        settings({ localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' }),
        'darwin'
      )
    ).toEqual({ runtime: 'host', wslDistro: null })
  })

  it('follows the Windows runtime default when the policy is auto', () => {
    expect(
      getKimiRuntimeTarget(
        settings({
          localAccountRuntime: 'auto',
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Debian' }
        }),
        'win32'
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Debian' })
  })
})

describe('resolveKimiHome', () => {
  const originalKimiCodeHome = process.env.KIMI_CODE_HOME

  beforeEach(() => {
    delete process.env.KIMI_CODE_HOME
    wslMocks.getDefaultWslDistro.mockReset().mockReturnValue('Ubuntu')
    wslMocks.getWslHome.mockReset().mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\neil')
  })

  afterEach(() => {
    if (originalKimiCodeHome === undefined) {
      delete process.env.KIMI_CODE_HOME
    } else {
      process.env.KIMI_CODE_HOME = originalKimiCodeHome
    }
  })

  it('resolves the host home for a host target', () => {
    expect(resolveKimiHome({ runtime: 'host', wslDistro: null }, 'win32')).toEqual({
      runtime: 'host',
      wslDistro: null,
      path: getHostKimiHome()
    })
    expect(wslMocks.getWslHome).not.toHaveBeenCalled()
  })

  it('resolves the WSL distro home for a WSL target', () => {
    expect(resolveKimiHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      path: '\\\\wsl.localhost\\Ubuntu\\home\\neil\\.kimi-code'
    })
  })

  it('ignores the host KIMI_CODE_HOME when reading a WSL home', () => {
    process.env.KIMI_CODE_HOME = 'D:\\kimi-home'
    expect(resolveKimiHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'win32').path).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\neil\\.kimi-code'
    )
  })

  it('falls back to the default distro when none is configured', () => {
    expect(resolveKimiHome({ runtime: 'wsl', wslDistro: null }, 'win32')).toMatchObject({
      wslDistro: 'Ubuntu'
    })
    expect(wslMocks.getWslHome).toHaveBeenCalledWith('Ubuntu')
  })

  it('reports no path when the distro home cannot be probed', () => {
    wslMocks.getWslHome.mockReturnValue(null)
    expect(resolveKimiHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      path: null
    })
  })

  it('reports no path when no distro exists at all', () => {
    wslMocks.getDefaultWslDistro.mockReturnValue(null)
    expect(resolveKimiHome({ runtime: 'wsl', wslDistro: null }, 'win32')).toEqual({
      runtime: 'wsl',
      wslDistro: null,
      path: null
    })
  })

  it('never probes WSL off Windows', () => {
    expect(resolveKimiHome({ runtime: 'wsl', wslDistro: 'Ubuntu' }, 'darwin')).toEqual({
      runtime: 'host',
      wslDistro: null,
      path: getHostKimiHome()
    })
    expect(wslMocks.getDefaultWslDistro).not.toHaveBeenCalled()
    expect(wslMocks.getWslHome).not.toHaveBeenCalled()
  })
})
