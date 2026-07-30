import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

const SESSION_LIMIT = 500

export function resetAiVaultForcedRescanThrottleForTest(): void {
  // Retained for test compatibility after passive refreshes stopped forcing.
}

type AiVaultRefreshArgs = {
  force?: boolean
  background?: boolean
  reason?: 'manual' | 'passive' | 'session-start'
  refreshExecutionHostId?: ExecutionHostId
}

export function useAiVaultSessionRefresh(
  scopePaths: readonly string[],
  executionHostScope: ExecutionHostScope
): {
  error: string | null
  loading: boolean
  refresh: (args?: AiVaultRefreshArgs) => Promise<void>
  scanResult: AiVaultListResult | null
  sessions: AiVaultSession[]
} {
  const [sessions, setSessions] = useState<AiVaultSession[]>([])
  const [scanResult, setScanResult] = useState<AiVaultListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refreshIdRef = useRef(0)
  const refreshInFlightRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  const pendingForceRef = useRef(false)
  const pendingBackgroundRef = useRef(true)
  const pendingRefreshHostIdsRef = useRef(new Set<ExecutionHostId>())
  const lastAppliedScanRef = useRef<{ scopeKey: string; scannedAt: string } | null>(null)
  const mountedRef = useRef(true)
  const scopePathsKey = useMemo(() => scopePaths.join('\n'), [scopePaths])
  const scanScopeKey = `${executionHostScope}\n${scopePathsKey}`
  const scopePathsRef = useRef<readonly string[]>(scopePaths)
  scopePathsRef.current = scopePaths
  const executionHostScopeRef = useRef<ExecutionHostScope>(executionHostScope)
  executionHostScopeRef.current = executionHostScope
  const currentScanScopeKey = useCallback(
    () => `${executionHostScopeRef.current}\n${scopePathsRef.current.join('\n')}`,
    []
  )

  const refresh = useCallback(
    async (args: AiVaultRefreshArgs = {}): Promise<void> => {
      // A scope change during an in-flight scan must not be dropped; queue one more
      // scan so the current scoped view is refreshed after the older scan settles.
      if (refreshInFlightRef.current) {
        pendingRefreshRef.current = true
        pendingForceRef.current ||= args.force === true || args.reason === 'manual'
        pendingBackgroundRef.current &&= args.background === true
        if (args.reason === 'session-start' && args.refreshExecutionHostId) {
          pendingRefreshHostIdsRef.current.add(args.refreshExecutionHostId)
        }
        return
      }

      refreshInFlightRef.current = true
      const refreshId = refreshIdRef.current + 1
      refreshIdRef.current = refreshId
      // Background (refocus) refreshes usually resolve from the main-process
      // cache; suppressing the loading flag avoids a spinner flash on every
      // return to the app.
      if (args.background !== true) {
        setLoading(true)
      }
      setError(null)
      const scopeKey = scopePathsRef.current.join('\n')
      const hostScope = executionHostScopeRef.current
      const scanKey = `${hostScope}\n${scopeKey}`
      try {
        const result = await window.api.aiVault.listSessions({
          limit: SESSION_LIMIT,
          scopePaths: scopePathsRef.current,
          executionHostScope: hostScope,
          force: args.force,
          refreshReason: args.reason ?? (args.force ? 'manual' : 'passive'),
          refreshExecutionHostId: args.refreshExecutionHostId
        })
        if (!mountedRef.current || refreshIdRef.current !== refreshId) {
          return
        }
        // Why: host/scope changes queue a follow-up scan, but the older result
        // may resolve first and must not briefly paint the wrong history list.
        if (scanKey !== currentScanScopeKey()) {
          return
        }
        // A cache hit returns the snapshot already on screen; skip the state
        // updates so refocus flips don't force pointless re-renders.
        if (
          lastAppliedScanRef.current?.scopeKey === scanKey &&
          lastAppliedScanRef.current.scannedAt === result.scannedAt
        ) {
          return
        }
        lastAppliedScanRef.current = { scopeKey: scanKey, scannedAt: result.scannedAt }
        setScanResult(result)
        setSessions(result.sessions)
      } catch (err) {
        if (
          mountedRef.current &&
          refreshIdRef.current === refreshId &&
          scanKey === currentScanScopeKey()
        ) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        refreshInFlightRef.current = false
        if (mountedRef.current && refreshIdRef.current === refreshId) {
          setLoading(false)
        }
        if (pendingRefreshRef.current && mountedRef.current) {
          pendingRefreshRef.current = false
          const force = pendingForceRef.current
          // The queued refresh is background-only if every queued caller was.
          const background = pendingBackgroundRef.current
          pendingForceRef.current = false
          pendingBackgroundRef.current = true
          if (force) {
            pendingRefreshHostIdsRef.current.clear()
          }
          const hostIterator = pendingRefreshHostIdsRef.current.values().next()
          const refreshExecutionHostId = hostIterator.done ? undefined : hostIterator.value
          if (refreshExecutionHostId) {
            pendingRefreshHostIdsRef.current.delete(refreshExecutionHostId)
          }
          pendingRefreshRef.current = pendingRefreshHostIdsRef.current.size > 0
          void refresh({
            force,
            background,
            reason: force ? 'manual' : refreshExecutionHostId ? 'session-start' : 'passive',
            refreshExecutionHostId
          })
        }
      }
      // Deps intentionally avoid changing scope values: refresh reads them
      // through refs and recurses on itself, so its identity must stay stable.
    },
    [currentScanScopeKey]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      refreshIdRef.current += 1
      refreshInFlightRef.current = false
    }
  }, [])

  // Re-scan on mount and scope changes while retaining the remote TTL.
  useEffect(() => {
    void refresh({ reason: 'passive' })
  }, [refresh, scanScopeKey])

  // Sessions started while the app was backgrounded should appear when the
  // user returns, so refocus also bypasses the scan cache (throttled). OS
  // refocus arrives via the main process — renderer DOM focus events don't
  // fire on macOS app activation; visibilitychange covers minimize-restore.
  useEffect(() => {
    const onRefocus = (): void => {
      if (document.visibilityState !== 'visible') {
        return
      }
      void refresh({ background: true, reason: 'passive' })
    }
    const unsubscribeWindowFocus = window.api.aiVault.onWindowFocused?.(onRefocus)
    document.addEventListener('visibilitychange', onRefocus)
    return () => {
      unsubscribeWindowFocus?.()
      document.removeEventListener('visibilitychange', onRefocus)
    }
  }, [refresh])

  // Sessions started inside Orca never blur the window, so refocus alone
  // can't surface them. Agent hooks already report provider sessions; re-scan
  // only when a session id we haven't seen appears — state transitions are
  // deliberately ignored, they fire constantly while agents work.
  const agentSessionIdsKey = useAppStore((state) => {
    const ids: [ExecutionHostId, string][] = []
    for (const entry of Object.values(state.agentStatusByPaneKey)) {
      if (entry.providerSession?.id) {
        const hostId = entry.connectionId
          ? toSshExecutionHostId(entry.connectionId)
          : entry.worktreeId
            ? getExecutionHostIdForWorktree(state, entry.worktreeId)
            : LOCAL_EXECUTION_HOST_ID
        ids.push([hostId, entry.providerSession.id])
      }
    }
    return JSON.stringify(
      ids.sort((left, right) => left.join('\0').localeCompare(right.join('\0')))
    )
  })
  const seenAgentSessionIdsRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    const entries = JSON.parse(agentSessionIdsKey) as [ExecutionHostId, string][]
    const ids = entries.map(([hostId, sessionId]) => `${hostId}\0${sessionId}`)
    // The mount refresh already covers sessions live at mount time.
    if (seenAgentSessionIdsRef.current === null) {
      seenAgentSessionIdsRef.current = new Set(ids)
      return
    }
    const seen = seenAgentSessionIdsRef.current
    const freshEntries = entries.filter(
      ([hostId, sessionId]) => !seen.has(`${hostId}\0${sessionId}`)
    )
    if (freshEntries.length === 0) {
      return
    }
    for (const [hostId, sessionId] of freshEntries) {
      seen.add(`${hostId}\0${sessionId}`)
      const selectedHost = executionHostScopeRef.current
      if (selectedHost !== 'all' && selectedHost !== hostId) {
        continue
      }
      void refresh({
        background: true,
        reason: 'session-start',
        refreshExecutionHostId: hostId
      })
    }
  }, [agentSessionIdsKey, refresh])

  return { error, loading, refresh, scanResult, sessions }
}
