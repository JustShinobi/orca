import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const previewProxyApi = {
  status: () => ipcRenderer.invoke('previewProxy:status')
} satisfies PreloadApi['previewProxy']
