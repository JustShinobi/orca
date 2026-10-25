import type { ActivityBarItem } from './activity-bar-buttons'

type RightSidebarActivityVisibilityState = {
  isFolder: boolean
  isFolderWorkspace: boolean
  /** The workspace runs on an SSH host, reached directly or through its managed server. */
  hasSshHost: boolean
  isPreviewProxyActive?: boolean
}

export function getVisibleRightSidebarActivityItems(
  items: ActivityBarItem[],
  {
    isFolder,
    isFolderWorkspace,
    hasSshHost,
    isPreviewProxyActive = false
  }: RightSidebarActivityVisibilityState
): ActivityBarItem[] {
  return items.filter(
    (item) =>
      (!item.gitOnly || !isFolder) &&
      (!item.folderOnly || isFolderWorkspace) &&
      // Why: ports were SSH-only because a local workspace's ports are already
      // reachable. A live preview proxy breaks that — it mints a shareable URL
      // per port that no other surface lists in full.
      (!item.sshOnly || hasSshHost || isPreviewProxyActive)
  )
}
