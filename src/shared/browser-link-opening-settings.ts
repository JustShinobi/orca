import type { PreviewProxySettings } from './preview-proxy-types'

export type BrowserLinkOpeningSettings = {
  /** Links from Orca surfaces join the browser without taking focus from the pane they came from. */
  openLinksInAppInBackground?: boolean
  /** Settings-driven workspace preview proxy; `orca serve --preview-*` flags override this whole object while set. */
  previewProxy?: PreviewProxySettings
}
