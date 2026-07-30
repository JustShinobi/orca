import type { useAppStore } from '@/store'
import type { PendingWorktreeCreation } from '@/lib/pending-worktree-creation'
import type { GlobalSettings, Repo } from '../../../shared/types'

export type GitHubWorkItemBackgroundStoreSnapshot = {
  repos: readonly Repo[]
  pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
  sshConnectionStates: ReturnType<typeof useAppStore.getState>['sshConnectionStates']
  runtimeStatusByEnvironmentId: ReturnType<
    typeof useAppStore.getState
  >['runtimeStatusByEnvironmentId']
  settings:
    | Partial<
        Pick<
          GlobalSettings,
          | 'activeRuntimeEnvironmentId'
          | 'defaultTuiAgent'
          | 'disabledTuiAgents'
          | 'agentCmdOverrides'
          | 'agentDefaultArgs'
          | 'agentDefaultEnv'
          | 'terminalWindowsShell'
        >
      >
    | null
    | undefined
  ensureDetectedAgents: ReturnType<typeof useAppStore.getState>['ensureDetectedAgents']
  ensureRemoteDetectedAgents: ReturnType<typeof useAppStore.getState>['ensureRemoteDetectedAgents']
  ensureRuntimeDetectedAgents: ReturnType<
    typeof useAppStore.getState
  >['ensureRuntimeDetectedAgents']
  detectedAgentCommands?: ReturnType<typeof useAppStore.getState>['detectedAgentCommands']
  detectedAgentCommandsByContext?: ReturnType<
    typeof useAppStore.getState
  >['detectedAgentCommandsByContext']
  remoteDetectedAgentCommands?: ReturnType<
    typeof useAppStore.getState
  >['remoteDetectedAgentCommands']
  runtimeDetectedAgentCommands?: ReturnType<
    typeof useAppStore.getState
  >['runtimeDetectedAgentCommands']
}
