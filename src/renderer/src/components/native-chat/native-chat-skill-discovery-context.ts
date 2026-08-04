import type { AppState } from '../../store/types'
import type { PaneSkillDiscoveryTarget, SkillDiscoveryTarget } from '../../../../shared/skills'
import {
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { resolveExactWorktreeRoute } from '@/lib/worktree-owner-route'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getExecutionHostIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

export type NativeChatSkillStateInputs = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorktreeId'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'projects'
  | 'repos'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'settings'
  | 'sshConnectionStates'
  | 'sshStateByEnvironment'
  | 'tabsByWorktree'
  | 'worktreesByRepo'
>

type NativeChatSkillTab = { id: string; startupCwd?: string }

type NativeChatSkillWorktreeState = {
  tabsByWorktree: Record<string, readonly NativeChatSkillTab[]>
  worktreesByRepo: Record<string, readonly { id: string; path: string }[]>
}

export type NativeChatSkillDiscoveryContext =
  | {
      key: string
      cwd: string
      executionHostKind: 'local' | 'runtime'
      runtimeTarget: RuntimeClientTarget
      discoveryTarget: SkillDiscoveryTarget
    }
  | {
      key: string
      executionHostKind: 'ssh'
      runtimeTarget: RuntimeClientTarget
      /** Identity only; the owning runtime derives the scanned directory. */
      paneTarget: PaneSkillDiscoveryTarget
      /** Known-disconnected host: skip the doomed RPC and show the host error. */
      sshDisconnected: boolean
    }

export function selectNativeChatSkillStateInputs(state: AppState): NativeChatSkillStateInputs {
  return {
    activeRepoId: state.activeRepoId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    activeWorktreeId: state.activeWorktreeId,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    projects: state.projects,
    repos: state.repos,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    settings: state.settings,
    sshConnectionStates: state.sshConnectionStates,
    sshStateByEnvironment: state.sshStateByEnvironment,
    tabsByWorktree: state.tabsByWorktree,
    worktreesByRepo: state.worktreesByRepo
  }
}

type SshTransportResolution =
  | { kind: 'resolved'; environmentId: string | null }
  | { kind: 'ambiguous' }
  | { kind: 'missing' }

function resolveCatalogSshTransport(
  state: NativeChatSkillStateInputs,
  worktreeId: string,
  hostId: ExecutionHostId
): SshTransportResolution {
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return { kind: 'missing' }
  }
  const rawWorktreeId = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
  const repoIds = new Set([getRepoIdFromWorktreeId(rawWorktreeId)])
  const environmentIds = new Set<string | null>()
  const catalogs = [
    ...Object.values(state.worktreesByRepo ?? {}),
    ...Object.values(state.detectedWorktreesByRepo ?? {}).map((result) => result.worktrees)
  ]
  for (const worktrees of catalogs) {
    for (const worktree of worktrees) {
      if (worktree.id !== rawWorktreeId || parseExecutionHostId(worktree.hostId)?.id !== hostId) {
        continue
      }
      repoIds.add(worktree.repoId)
      const resolution = resolveExactWorktreeRoute(state, worktree)
      if (resolution.kind === 'ambiguous') {
        return resolution
      }
      if (resolution.kind === 'resolved' && resolution.route.executionHostId === hostId) {
        environmentIds.add(resolution.route.runtimeEnvironmentId)
      }
    }
  }
  if (environmentIds.size === 0) {
    for (const repo of state.repos) {
      if (!repoIds.has(repo.id)) {
        continue
      }
      const executionHost = parseExecutionHostId(repo.executionHostId)
      const connectionId = repo.connectionId?.trim()
      const connectionHostId = connectionId ? toSshExecutionHostId(connectionId) : null
      if (connectionHostId !== hostId && executionHost?.id !== hostId) {
        continue
      }
      environmentIds.add(executionHost?.kind === 'runtime' ? executionHost.environmentId : null)
    }
  }
  if (environmentIds.size > 1) {
    return { kind: 'ambiguous' }
  }
  const environmentId = environmentIds.values().next().value
  return environmentIds.size === 1
    ? { kind: 'resolved', environmentId: environmentId ?? null }
    : { kind: 'missing' }
}

export function resolveNativeChatSkillDiscoveryCwd(
  state: NativeChatSkillWorktreeState,
  terminalTabId: string
): string | null {
  const found = findTerminalTab(state.tabsByWorktree, terminalTabId)
  if (!found) {
    return null
  }
  // Why: the agent runs where its pane started. A pane launched in a
  // subdirectory must not scan (or share a cache key with) the worktree root.
  const startupCwd = found.tab.startupCwd?.trim()
  if (startupCwd) {
    return startupCwd
  }
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    const worktree = worktrees.find((entry) => entry.id === found.worktreeId)
    if (worktree) {
      return worktree.path
    }
  }
  return null
}

export function resolveNativeChatSkillDiscoveryContext(
  state: NativeChatSkillStateInputs,
  terminalTabId: string
): NativeChatSkillDiscoveryContext | null {
  const worktreeId = findTerminalTab(state.tabsByWorktree, terminalTabId)?.worktreeId ?? null
  if (!worktreeId) {
    return null
  }
  const hostId = getExecutionHostIdForWorktree(state, worktreeId)
  const parsedHost = parseExecutionHostId(hostId)
  if (parsedHost?.kind === 'ssh') {
    const explicitRuntimeEnvironmentId = getExplicitRuntimeEnvironmentIdForWorktree(
      state,
      worktreeId
    )
    const catalogTransport = resolveCatalogSshTransport(state, worktreeId, parsedHost.id)
    if (
      catalogTransport.kind === 'ambiguous' ||
      (explicitRuntimeEnvironmentId &&
        catalogTransport.kind === 'resolved' &&
        catalogTransport.environmentId !== explicitRuntimeEnvironmentId)
    ) {
      return null
    }
    const runtimeEnvironmentId =
      explicitRuntimeEnvironmentId ??
      (catalogTransport.kind === 'resolved' ? catalogTransport.environmentId : null)
    // Why: unresolved paired-runtime transport can collide with a local target
    // id; failing closed prevents the identity-only RPC reaching the wrong host.
    if (!runtimeEnvironmentId && isRuntimeOwnedSshTargetId(parsedHost.targetId)) {
      return null
    }
    const connectionState = runtimeEnvironmentId
      ? state.sshStateByEnvironment
          .get(runtimeEnvironmentId)
          ?.connectionStates.get(parsedHost.targetId)
      : state.sshConnectionStates.get(parsedHost.targetId)
    // Why: an unhydrated environment bucket is unknown, not disconnected — the
    // owning runtime answers authoritatively. A missing local entry is offline.
    const status = connectionState?.status ?? (runtimeEnvironmentId ? null : 'disconnected')
    return {
      key: JSON.stringify([
        'ssh',
        runtimeEnvironmentId ?? null,
        hostId,
        connectionState?.connectionGeneration ?? 0,
        worktreeId,
        terminalTabId
      ]),
      executionHostKind: 'ssh',
      runtimeTarget: runtimeEnvironmentId
        ? { kind: 'environment', environmentId: runtimeEnvironmentId }
        : { kind: 'local' },
      paneTarget: { worktreeId, terminalTabId },
      sshDisconnected: status !== null && status !== 'connected'
    }
  }

  const workspaceScope = parseWorkspaceKey(worktreeId)
  const cwd =
    resolveNativeChatSkillDiscoveryCwd(state, terminalTabId) ??
    (workspaceScope?.type === 'folder'
      ? state.folderWorkspaces.find(
          (workspace) => workspace.id === workspaceScope.folderWorkspaceId
        )?.folderPath
      : null)
  if (!cwd) {
    return null
  }

  const runtimeEnvironmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
  // Why: a selected global runtime is not proof that it owns this pane. Modern
  // panes carry an owner stamp; ambiguous legacy panes stay not-ready.
  if (parsedHost?.kind === 'runtime' && !runtimeEnvironmentId) {
    return null
  }
  const runtimeTarget: RuntimeClientTarget = runtimeEnvironmentId
    ? { kind: 'environment', environmentId: runtimeEnvironmentId }
    : { kind: 'local' }
  const projectRuntime = runtimeEnvironmentId
    ? undefined
    : getLocalProjectExecutionRuntimeContext(state, worktreeId)
  const projectRuntimeKey =
    projectRuntime?.status === 'resolved'
      ? projectRuntime.runtime.cacheKey
      : projectRuntime?.repair.cacheKey
  return {
    key: JSON.stringify([
      runtimeTarget.kind,
      runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null,
      hostId,
      projectRuntimeKey ?? null,
      cwd
    ]),
    cwd,
    executionHostKind: runtimeEnvironmentId ? 'runtime' : 'local',
    runtimeTarget,
    // Why: worktreeId lets the owning runtime resolve its own WSL project
    // preference when this client cannot supply projectRuntime (environment-
    // owned panes resolve host semantics on the runtime, never here).
    discoveryTarget: { cwd, worktreeId, ...(projectRuntime ? { projectRuntime } : {}) }
  }
}

export function resolveNativeChatSkillDiscoverySubscriptionKey(
  state: AppState,
  terminalTabId: string
): string | null {
  const context = resolveNativeChatSkillDiscoveryContext(
    selectNativeChatSkillStateInputs(state),
    terminalTabId
  )
  return getNativeChatSkillDiscoverySubscriptionKey(context)
}

export function getNativeChatSkillDiscoverySubscriptionKey(
  context: NativeChatSkillDiscoveryContext | null
): string | null {
  if (!context) {
    return null
  }
  return context.executionHostKind === 'ssh'
    ? JSON.stringify([context.key, context.sshDisconnected])
    : context.key
}

function findTerminalTab(
  tabsByWorktree: Record<string, readonly NativeChatSkillTab[]>,
  terminalTabId: string
): { worktreeId: string; tab: NativeChatSkillTab } | null {
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const tab = tabs.find((entry) => entry.id === terminalTabId)
    if (tab) {
      return { worktreeId, tab }
    }
  }
  return null
}
