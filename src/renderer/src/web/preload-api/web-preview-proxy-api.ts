import type { PreloadApi } from '../../../../preload/api-types'
import type { PreviewProxyStatus } from '../../../../shared/preview-proxy-types'
import { callRuntimeResult } from './web-runtime-calls'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'

export function createWebPreviewProxyApi(): NonNullable<Partial<PreloadApi>['previewProxy']> {
  return {
    status: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return null
      }
      try {
        const result = await callRuntimeResult<{ status: PreviewProxyStatus | null }>(
          'previewProxy.status',
          undefined,
          15_000
        )
        return result.status
      } catch {
        // Why: older runtimes answer method_not_found; the settings card
        // simply hides live status instead of erroring.
        return null
      }
    }
  }
}
