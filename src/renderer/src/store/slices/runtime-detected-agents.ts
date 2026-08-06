import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/types'
import { callRuntimeRpc, RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import {
  getRuntimeAgentDetectionEnvironmentId,
  getRuntimeAgentDetectionKey
} from '@/lib/runtime-agent-detection-key'

// Why: remote runtime hosts are not SSH connections, but their launch surfaces
// (tab bar, quick launch, Settings → Agents under an Active Server) still have
// to probe the host where the workspace actually runs. Keys are either an
// environment id or an environment + server-owned SSH target composite
// produced by getRuntimeAgentDetectionKey().
export type RuntimeDetectedAgentsSlice = {
  runtimeDetectedAgentIds: Record<string, TuiAgent[] | null>
  isDetectingRuntimeAgents: Record<string, boolean>
  isRefreshingRuntimeAgents: Record<string, boolean>
  ensureRuntimeDetectedAgents: (
    environmentId: string,
    connectionId?: string | null
  ) => Promise<TuiAgent[]>
  /** Forces a re-detect on the runtime host via `preflight.refreshAgents`
   *  (login-shell PATH re-read), falling back to `preflight.detectAgents` for
   *  servers that predate the refresh RPC. */
  refreshRuntimeDetectedAgents: (
    environmentId: string,
    connectionId?: string | null
  ) => Promise<TuiAgent[]>
  clearRuntimeDetectedAgents: (environmentId: string, connectionId?: string | null) => void
  /** Drops runtime detected-agent caches for environments not in the kept set.
   *  Wired into setRuntimeEnvironments so removed environments don't leak their
   *  detected-agent entries for the renderer session. */
  retainRuntimeDetectedAgents: (environmentIds: Iterable<string>) => void
}

// Why: these are module-scoped (not in the store) so we can deduplicate
// concurrent callers without storing a Promise in Zustand state.
const runtimeDetectPromises = new Map<string, Promise<TuiAgent[]>>()
const runtimeRefreshPromises = new Map<string, Promise<TuiAgent[]>>()

function isRuntimeMethodNotFoundError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}

export function _getRuntimeDetectPromiseCountForTest(): number {
  return runtimeDetectPromises.size
}

export const createRuntimeDetectedAgentsSlice: StateCreator<
  AppState,
  [],
  [],
  RuntimeDetectedAgentsSlice
> = (set, get) => ({
  runtimeDetectedAgentIds: {},
  isDetectingRuntimeAgents: {},
  isRefreshingRuntimeAgents: {},

  ensureRuntimeDetectedAgents: (environmentId: string, connectionId?: string | null) => {
    const detectionKey = getRuntimeAgentDetectionKey(environmentId, connectionId)
    const inflightRefresh = runtimeRefreshPromises.get(detectionKey)
    if (inflightRefresh) {
      return inflightRefresh
    }
    const existing = get().runtimeDetectedAgentIds[detectionKey]
    // Why: an empty result ([]) is truthy, so a prior "no agents found" detection
    // must not be treated as cached — re-detect so a later install / PATH fix is
    // picked up without a reconnect. Non-empty results still short-circuit.
    if (existing?.length) {
      return Promise.resolve(existing)
    }
    const inflight = runtimeDetectPromises.get(detectionKey)
    if (inflight) {
      return inflight
    }

    set((s) => ({
      isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [detectionKey]: true }
    }))

    const remoteConnectionId = connectionId?.trim() || null
    const pending = callRuntimeRpc<TuiAgent[]>(
      { kind: 'environment', environmentId },
      remoteConnectionId ? 'preflight.detectRemoteAgents' : 'preflight.detectAgents',
      remoteConnectionId ? { connectionId: remoteConnectionId } : undefined,
      { timeoutMs: 30_000 }
    )
      .then((ids) => {
        const typed = ids as TuiAgent[]
        // Why: skip committing if the environment was removed (retained out)
        // while the detect was in flight — otherwise it re-adds a stale entry
        // that retainRuntimeDetectedAgents just pruned.
        if (runtimeDetectPromises.get(detectionKey) === pending) {
          set((s) => ({
            runtimeDetectedAgentIds: { ...s.runtimeDetectedAgentIds, [detectionKey]: typed },
            isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [detectionKey]: false }
          }))
        }
        return typed
      })
      .catch(() => {
        // Why: a remote runtime may be disconnected or version-incompatible.
        // Keep the menu retryable instead of pinning a failed probe forever.
        // Same in-flight guard as the .then() above: if the environment was
        // retained out mid-detect, don't re-add the isDetecting entry that
        // retainRuntimeDetectedAgents just pruned (and don't clobber a freshly
        // started detect's spinner).
        if (runtimeDetectPromises.get(detectionKey) === pending) {
          set((s) => ({
            isDetectingRuntimeAgents: { ...s.isDetectingRuntimeAgents, [detectionKey]: false }
          }))
        }
        return [] as TuiAgent[]
      })
      .finally(() => {
        if (runtimeDetectPromises.get(detectionKey) === pending) {
          runtimeDetectPromises.delete(detectionKey)
        }
      })

    runtimeDetectPromises.set(detectionKey, pending)
    return pending
  },

  refreshRuntimeDetectedAgents: (environmentId: string, connectionId?: string | null) => {
    const detectionKey = getRuntimeAgentDetectionKey(environmentId, connectionId)
    const inflight = runtimeRefreshPromises.get(detectionKey)
    if (inflight) {
      return inflight
    }

    // Why: a refresh is newer and authoritative; detach an older detect so its
    // late result cannot overwrite the freshly hydrated PATH result.
    runtimeDetectPromises.delete(detectionKey)
    set((s) => ({
      isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [detectionKey]: true }
    }))

    const remoteConnectionId = connectionId?.trim() || null
    const pending = callRuntimeRpc<{ agents: TuiAgent[] }>(
      { kind: 'environment', environmentId },
      'preflight.refreshAgents',
      remoteConnectionId ? { connectionId: remoteConnectionId } : undefined
    )
      .then((result) => result.agents)
      .catch((error) => {
        if (!isRuntimeMethodNotFoundError(error)) {
          throw error
        }
        // Why: only older servers need the fallback; retrying disconnects and
        // runtime failures doubles remote work without any chance of recovery.
        return callRuntimeRpc<TuiAgent[]>(
          { kind: 'environment', environmentId },
          remoteConnectionId ? 'preflight.detectRemoteAgents' : 'preflight.detectAgents',
          remoteConnectionId ? { connectionId: remoteConnectionId } : undefined
        )
      })
      .then((ids) => {
        const typed = ids as TuiAgent[]
        // Why: same guard as ensureRuntimeDetectedAgents — if the environment
        // was retained out mid-refresh, don't re-add a pruned entry.
        if (runtimeRefreshPromises.get(detectionKey) === pending) {
          set((s) => ({
            runtimeDetectedAgentIds: { ...s.runtimeDetectedAgentIds, [detectionKey]: typed },
            isDetectingRuntimeAgents: {
              ...s.isDetectingRuntimeAgents,
              [detectionKey]: false
            },
            isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [detectionKey]: false }
          }))
        }
        return typed
      })
      .catch(() => {
        // Why: a disconnected runtime must keep Refresh retryable and must not
        // wipe the last known agent list.
        if (runtimeRefreshPromises.get(detectionKey) === pending) {
          set((s) => ({
            isDetectingRuntimeAgents: {
              ...s.isDetectingRuntimeAgents,
              [detectionKey]: false
            },
            isRefreshingRuntimeAgents: { ...s.isRefreshingRuntimeAgents, [detectionKey]: false }
          }))
        }
        return get().runtimeDetectedAgentIds[detectionKey] ?? []
      })
      .finally(() => {
        if (runtimeRefreshPromises.get(detectionKey) === pending) {
          runtimeRefreshPromises.delete(detectionKey)
        }
      })

    runtimeRefreshPromises.set(detectionKey, pending)
    return pending
  },

  clearRuntimeDetectedAgents: (environmentId: string, connectionId?: string | null) => {
    const detectionKey = getRuntimeAgentDetectionKey(environmentId, connectionId)
    runtimeDetectPromises.delete(detectionKey)
    runtimeRefreshPromises.delete(detectionKey)
    set((s) => {
      const { [detectionKey]: _, ...restAgents } = s.runtimeDetectedAgentIds
      const { [detectionKey]: __, ...restLoading } = s.isDetectingRuntimeAgents
      const { [detectionKey]: ___, ...restRefreshing } = s.isRefreshingRuntimeAgents
      return {
        runtimeDetectedAgentIds: restAgents,
        isDetectingRuntimeAgents: restLoading,
        isRefreshingRuntimeAgents: restRefreshing
      }
    })
  },

  retainRuntimeDetectedAgents: (environmentIds: Iterable<string>) => {
    const keep = new Set(environmentIds)
    for (const key of runtimeDetectPromises.keys()) {
      if (!keep.has(getRuntimeAgentDetectionEnvironmentId(key))) {
        runtimeDetectPromises.delete(key)
      }
    }
    for (const key of runtimeRefreshPromises.keys()) {
      if (!keep.has(getRuntimeAgentDetectionEnvironmentId(key))) {
        runtimeRefreshPromises.delete(key)
      }
    }
    set((s) => {
      let changed = false
      const nextAgents = { ...s.runtimeDetectedAgentIds }
      const nextLoading = { ...s.isDetectingRuntimeAgents }
      const nextRefreshing = { ...s.isRefreshingRuntimeAgents }
      for (const key of Object.keys(nextAgents)) {
        if (!keep.has(getRuntimeAgentDetectionEnvironmentId(key))) {
          delete nextAgents[key]
          changed = true
        }
      }
      for (const key of Object.keys(nextLoading)) {
        if (!keep.has(getRuntimeAgentDetectionEnvironmentId(key))) {
          delete nextLoading[key]
          changed = true
        }
      }
      for (const key of Object.keys(nextRefreshing)) {
        if (!keep.has(getRuntimeAgentDetectionEnvironmentId(key))) {
          delete nextRefreshing[key]
          changed = true
        }
      }
      return changed
        ? {
            runtimeDetectedAgentIds: nextAgents,
            isDetectingRuntimeAgents: nextLoading,
            isRefreshingRuntimeAgents: nextRefreshing
          }
        : s
    })
  }
})
