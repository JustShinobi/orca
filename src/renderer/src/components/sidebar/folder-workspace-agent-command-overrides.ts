import { resolveCursorCommandOverrides } from '@/lib/ai-vault-cursor-command'
import { useAppStore } from '@/store'
import { normalizeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectGroup, TuiAgent } from '../../../../shared/types'

export function resolveFolderWorkspaceAgentCommandOverrides(args: {
  agent: TuiAgent | null
  cmdOverrides: Record<string, string> | undefined
  projectGroup: Pick<ProjectGroup, 'connectionId' | 'executionHostId' | 'parentPath'>
}): Partial<Record<TuiAgent, string>> | undefined {
  if (!args.agent) {
    return args.cmdOverrides
  }
  return resolveCursorCommandOverrides({
    state: useAppStore.getState(),
    agent: args.agent,
    cmdOverrides: args.cmdOverrides ?? {},
    executionHostId: args.projectGroup.connectionId
      ? toSshExecutionHostId(args.projectGroup.connectionId)
      : normalizeExecutionHostId(args.projectGroup.executionHostId),
    workspacePath: args.projectGroup.parentPath
  })
}
