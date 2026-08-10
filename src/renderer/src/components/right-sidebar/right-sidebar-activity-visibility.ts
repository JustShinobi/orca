import type { ActivityBarItem } from './activity-bar-buttons'

type RightSidebarActivityVisibilityState = {
  isFolder: boolean
  isFolderWorkspace: boolean
  isSshRepo: boolean
  isPreviewProxyActive?: boolean
}

export function getVisibleRightSidebarActivityItems(
  items: ActivityBarItem[],
  {
    isFolder,
    isFolderWorkspace,
    isSshRepo,
    isPreviewProxyActive = false
  }: RightSidebarActivityVisibilityState
): ActivityBarItem[] {
  return items.filter((item) => {
    if (item.gitOnly && isFolder) {
      return false
    }
    if (item.folderOnly && !isFolderWorkspace) {
      return false
    }
    // Why: ports were SSH-only because a local workspace's ports are already
    // reachable. A live preview proxy breaks that — it mints a shareable URL
    // per port that no other surface lists in full.
    if (item.sshOnly && !isSshRepo && !isPreviewProxyActive) {
      return false
    }
    return true
  })
}
