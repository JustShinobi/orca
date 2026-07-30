import { resolveEffectiveCursorCommand } from '../../../src/shared/cursor-command'
import { detectedAgentInventorySchema } from '../../../src/shared/detected-agent-inventory'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileAiVaultResumeSettings } from './ai-vault-resume-launch'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'

export async function resolveMobileCursorCommand(args: {
  client: Pick<RpcClient, 'sendRequest'>
  settings?: MobileAiVaultResumeSettings | null
  wslDistro?: string | null
}): Promise<string | null> {
  const wslDistro = args.wslDistro?.trim()
  const response = await args.client.sendRequest(
    'preflight.detectAgentInventory',
    wslDistro ? { wslDistro } : undefined
  )
  if (!response.ok) {
    return resolveEffectiveCursorCommand(args.settings?.agentCmdOverrides?.cursor, null)
  }
  const result = detectedAgentInventorySchema.safeParse(response.result)
  return resolveEffectiveCursorCommand(
    args.settings?.agentCmdOverrides?.cursor,
    result.success ? result.data : null
  )
}

export async function resolveRequiredMobileCursorResumeCommand(args: {
  client: Pick<RpcClient, 'sendRequest'>
  settings?: MobileAiVaultResumeSettings | null
  wslDistro?: string | null
  session: Pick<AiVaultSession, 'agent' | 'cwd'>
}): Promise<string | null> {
  if (args.session.agent !== 'cursor') {
    return null
  }
  const command = await resolveMobileCursorCommand(args)
  if (!args.session.cwd || !command) {
    throw new Error(
      args.session.cwd
        ? 'Cursor CLI not detected on this host.'
        : 'Cursor did not record a resumable workspace for this session.'
    )
  }
  return command
}
