import { resolveEffectiveCursorCommand } from '../../shared/cursor-command'
import type { TuiAgent } from '../../shared/types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  detectInstalledAgentCommandsWithShellPathHydration,
  detectRemoteAgentCommands
} from '../ipc/tui-agent-inventory-detection'

export async function resolveRuntimeAgentCommandOverrides(args: {
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>>
  connectionId?: string | null
  wslDistro?: string | null
  workspacePath: string
}): Promise<Partial<Record<TuiAgent, string>>> {
  if (args.agent !== 'cursor' || args.cmdOverrides.cursor?.trim()) {
    return args.cmdOverrides
  }
  try {
    const wslDistro = args.wslDistro?.trim() || parseWslUncPath(args.workspacePath)?.distro
    const inventory = args.connectionId
      ? await detectRemoteAgentCommands({ connectionId: args.connectionId })
      : await detectInstalledAgentCommandsWithShellPathHydration(wslDistro ? { wslDistro } : {})
    const command = resolveEffectiveCursorCommand(null, inventory)
    return command ? { ...args.cmdOverrides, cursor: command } : args.cmdOverrides
  } catch {
    return args.cmdOverrides
  }
}
