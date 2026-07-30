import { describe, expect, it, vi } from 'vitest'
import { resolveMobileCursorCommand } from './mobile-cursor-command'

describe('resolveMobileCursorCommand', () => {
  it('preserves the host-matched Cursor command', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        version: 1,
        agents: ['cursor'],
        matchedCommands: { cursor: 'cursor agent' }
      }
    })

    await expect(resolveMobileCursorCommand({ client: { sendRequest } })).resolves.toBe(
      'cursor agent'
    )
    expect(sendRequest).toHaveBeenCalledWith('preflight.detectAgentInventory', undefined)
  })

  it('fails closed without a valid inventory unless an override exists', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ ok: false })
    await expect(resolveMobileCursorCommand({ client: { sendRequest } })).resolves.toBeNull()
    await expect(
      resolveMobileCursorCommand({
        client: { sendRequest },
        settings: { agentCmdOverrides: { cursor: 'cursor-dev' } }
      })
    ).resolves.toBe('cursor-dev')
  })

  it('requests inventory from the exact WSL distro context', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        version: 1,
        agents: ['cursor'],
        matchedCommands: { cursor: 'cursor agent' }
      }
    })

    await expect(
      resolveMobileCursorCommand({
        client: { sendRequest },
        wslDistro: ' Ubuntu '
      })
    ).resolves.toBe('cursor agent')
    expect(sendRequest).toHaveBeenCalledWith('preflight.detectAgentInventory', {
      wslDistro: 'Ubuntu'
    })
  })
})
