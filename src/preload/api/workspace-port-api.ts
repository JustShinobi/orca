import type {
  LocalhostWorktreeLabelResult,
  LocalhostWorktreeLabelRoute
} from '../../shared/localhost-worktree-labels'
import type {
  WorkspacePortAdvertisedUrlChangedEvent,
  WorkspacePortKillRequest,
  WorkspacePortKillResult,
  WorkspacePortScanRequest,
  WorkspacePortScanResult
} from '../../shared/workspace-ports'
import type { PreviewProxyStatus } from '../../shared/preview-proxy-types'

export type WorkspacePortsApi = {
  scan: (args: WorkspacePortScanRequest) => Promise<WorkspacePortScanResult>
  kill: (args: WorkspacePortKillRequest) => Promise<WorkspacePortKillResult>
  onAdvertisedUrlChanged: (
    callback: (event: WorkspacePortAdvertisedUrlChangedEvent) => void
  ) => () => void
}

export type PreviewProxyApi = {
  /** Null when the connected runtime predates the preview proxy. */
  status: () => Promise<PreviewProxyStatus | null>
}

export type LocalhostWorktreeLabelsApi = {
  register: (args: LocalhostWorktreeLabelRoute) => Promise<LocalhostWorktreeLabelResult>
}
