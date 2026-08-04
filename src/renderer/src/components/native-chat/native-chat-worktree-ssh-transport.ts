import type { AppState } from '../../store/types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  getRepoIdFromWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../../shared/worktree-id'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { resolveExactWorktreeRoute } from '@/lib/worktree-owner-route'

type WorktreeSshTransportState = Pick<
  AppState,
  | 'detectedWorktreesByRepo'
  | 'repos'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'worktreesByRepo'
>

export type NativeChatWorktreeSshTransportResolution =
  | { kind: 'resolved'; environmentId: string | null }
  | { kind: 'ambiguous' }
  | { kind: 'missing' }

export function resolveNativeChatWorktreeSshTransport(
  state: WorktreeSshTransportState,
  worktreeId: string,
  hostId: ExecutionHostId
): NativeChatWorktreeSshTransportResolution {
  const scope = parseWorkspaceKey(worktreeId)
  const rawWorktreeId = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
  const repoIds = new Set([getRepoIdFromWorktreeId(rawWorktreeId)])
  const environmentIds = new Set<string | null>()
  const catalogs = [
    ...Object.values(state.worktreesByRepo ?? {}),
    ...Object.values(state.detectedWorktreesByRepo ?? {}).map((result) => result.worktrees)
  ]
  let hasDirectOwner = false
  let hasRuntimeOwner = false
  for (const worktrees of catalogs) {
    for (const worktree of worktrees) {
      if (
        !worktreeIdsEqual(worktree.id, rawWorktreeId) ||
        parseExecutionHostId(worktree.hostId)?.id !== hostId
      ) {
        continue
      }
      repoIds.add(worktree.repoId)
      if (worktree.runtimeOwnerEnvironmentId?.trim()) {
        hasRuntimeOwner = true
      } else {
        hasDirectOwner = true
      }
      const resolution = resolveExactWorktreeRoute(state, worktree)
      if (resolution.kind === 'ambiguous') {
        return resolution
      }
      if (resolution.kind === 'resolved' && resolution.route.executionHostId === hostId) {
        environmentIds.add(resolution.route.runtimeEnvironmentId)
      }
    }
  }
  if (hasDirectOwner && hasRuntimeOwner) {
    return { kind: 'ambiguous' }
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
  const restoredHostId =
    state.restoredRuntimeHostIdByWorkspaceSessionKey[rawWorktreeId] ??
    state.restoredRuntimeHostIdByWorkspaceSessionKey[worktreeId]
  if (restoredHostId) {
    const restoredHost = parseExecutionHostId(restoredHostId)
    if (restoredHost?.kind !== 'runtime') {
      return { kind: 'ambiguous' }
    }
    environmentIds.add(restoredHost.environmentId)
  }
  if (environmentIds.size > 1) {
    return { kind: 'ambiguous' }
  }
  const environmentId = environmentIds.values().next().value
  return environmentIds.size === 1
    ? { kind: 'resolved', environmentId: environmentId ?? null }
    : { kind: 'missing' }
}

function worktreeIdsEqual(left: string, right: string): boolean {
  if (left === right) {
    return true
  }
  const parsedLeft = splitWorktreeIdForFilesystem(left)
  const parsedRight = splitWorktreeIdForFilesystem(right)
  return Boolean(
    parsedLeft &&
    parsedRight &&
    parsedLeft.repoId === parsedRight.repoId &&
    normalizeRuntimePathForComparison(parsedLeft.worktreePath) ===
      normalizeRuntimePathForComparison(parsedRight.worktreePath)
  )
}
