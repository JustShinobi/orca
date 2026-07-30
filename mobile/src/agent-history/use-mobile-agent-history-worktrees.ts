import { useEffect, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'

export function useMobileAgentHistoryWorktrees(
  client: Pick<RpcClient, 'sendRequest'> | null,
  connected: boolean
): { worktrees: Worktree[]; worktreesLoaded: boolean } {
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [worktreesLoaded, setWorktreesLoaded] = useState(false)
  useEffect(() => {
    if (!client || !connected) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const response = await client.sendRequest('worktree.ps', { limit: 10000 })
        if (!cancelled && response.ok) {
          setWorktrees(((response as RpcSuccess).result as { worktrees: Worktree[] }).worktrees)
        }
      } catch {
        // Scope context is best effort; the session scan can still proceed unscoped.
      } finally {
        if (!cancelled) {
          setWorktreesLoaded(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, connected])
  return { worktrees, worktreesLoaded }
}
