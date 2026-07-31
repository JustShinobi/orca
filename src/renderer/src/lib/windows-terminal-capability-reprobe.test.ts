// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  resetWindowsTerminalCapabilityReprobeForTests,
  startWindowsTerminalCapabilityReprobe
} from './windows-terminal-capability-reprobe'
import type { WindowsTerminalCapabilities } from './windows-terminal-capabilities'

const ABSENT_WSL: WindowsTerminalCapabilities = {
  wslAvailable: false,
  wslDistros: [],
  pwshAvailable: false,
  gitBashAvailable: true,
  hostPlatform: 'win32',
  isLoading: false
}

const USABLE_WSL: WindowsTerminalCapabilities = {
  ...ABSENT_WSL,
  wslAvailable: true,
  wslDistros: ['Ubuntu']
}

function createWatcher(answers: WindowsTerminalCapabilities[] = []): {
  probe: Mock<() => Promise<WindowsTerminalCapabilities>>
  readCached: () => WindowsTerminalCapabilities
} {
  let current = ABSENT_WSL
  const probe = vi.fn(async () => {
    current = answers.shift() ?? current
    return current
  })
  return { probe, readCached: () => current }
}

afterEach(() => {
  resetWindowsTerminalCapabilityReprobeForTests()
  vi.useRealTimers()
})

describe('windows terminal capability re-probe', () => {
  it('backs off and parks on a stable answer instead of probing forever', async () => {
    vi.useFakeTimers()
    const { probe, readCached } = createWatcher()
    startWindowsTerminalCapabilityReprobe({ ownerKey: 'local', probe, readCached })

    // 30s, then +60s, then +120s: three unchanged answers settle the watcher.
    await vi.advanceTimersByTimeAsync(210_000)
    expect(probe).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('still re-checks a transient absent answer, then stops once WSL answers', async () => {
    vi.useFakeTimers()
    const { probe, readCached } = createWatcher([USABLE_WSL])
    startWindowsTerminalCapabilityReprobe({ ownerKey: 'local', probe, readCached })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(readCached()).toMatchObject({ wslAvailable: true, wslDistros: ['Ubuntu'] })

    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('keeps watching closely while the answer is still moving', async () => {
    vi.useFakeTimers()
    const { probe, readCached } = createWatcher([
      { ...ABSENT_WSL, pwshAvailable: true },
      { ...ABSENT_WSL, pwshAvailable: true, gitBashAvailable: false }
    ])
    startWindowsTerminalCapabilityReprobe({ ownerKey: 'local', probe, readCached })

    // Each changed answer resets the backoff to the base delay.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(probe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('stops entirely once the last consumer unregisters', async () => {
    vi.useFakeTimers()
    const { probe, readCached } = createWatcher()
    const stopFirst = startWindowsTerminalCapabilityReprobe({ ownerKey: 'local', probe, readCached })
    const stopSecond = startWindowsTerminalCapabilityReprobe({
      ownerKey: 'local',
      probe,
      readCached
    })

    // Two consumers share one schedule rather than each installing their own timer.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(probe).toHaveBeenCalledTimes(1)

    stopFirst()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probe).toHaveBeenCalledTimes(2)

    stopSecond()
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('re-arms a parked watcher when the window regains focus', async () => {
    vi.useFakeTimers()
    const { probe, readCached } = createWatcher()
    startWindowsTerminalCapabilityReprobe({ ownerKey: 'local', probe, readCached })

    await vi.advanceTimersByTimeAsync(210_000 + 30 * 60_000)
    expect(probe).toHaveBeenCalledTimes(3)

    globalThis.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(probe).toHaveBeenCalledTimes(4)
  })

  it('drops the focus listener when no owner is watched', () => {
    const addEventListener = vi.spyOn(globalThis, 'addEventListener')
    const removeEventListener = vi.spyOn(globalThis, 'removeEventListener')
    const { probe, readCached } = createWatcher()

    const stop = startWindowsTerminalCapabilityReprobe({ ownerKey: 'local', probe, readCached })
    expect(addEventListener).toHaveBeenCalledWith('focus', expect.any(Function))

    stop()
    expect(removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function))
    addEventListener.mockRestore()
    removeEventListener.mockRestore()
  })
})
