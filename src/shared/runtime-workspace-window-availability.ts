import type { RuntimeStatus } from './runtime-types'

// Why: a headed Orca server keeps answering status.get after its workspace window
// closes, so "a status came back" is not evidence that graph-backed workspace work
// will succeed there. Narrow on purpose: 'reloading' is a transient renderer reload,
// and a host that omits desktopWindowStatus (older builds, headless serve) makes no
// claim about a desktop window — neither is a closed workspace window.
export function isRuntimeWorkspaceWindowClosed(status: RuntimeStatus | null | undefined): boolean {
  return status?.graphStatus === 'unavailable' && status.desktopWindowStatus === 'openable'
}

export function isRuntimeEnvironmentWorkspaceWindowClosed(
  runtimeStatusByEnvironmentId:
    | ReadonlyMap<string, { status: RuntimeStatus | null }>
    | undefined
    | null,
  environmentId: string | null | undefined
): boolean {
  if (!environmentId) {
    return false
  }
  return isRuntimeWorkspaceWindowClosed(runtimeStatusByEnvironmentId?.get(environmentId)?.status)
}
