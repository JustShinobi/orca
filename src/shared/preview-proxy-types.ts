/** Workspace preview proxy exposed to browsers outside pairing auth (see
 *  docs/reference/headless-linux-server.md). Editable from paired clients, so
 *  every field is validated again in the main process before a listener binds. */
export type PreviewProxySettings = {
  enabled: boolean
  /** Listener port; the single port an external reverse proxy forwards to. */
  port: number
  /** Public base domain, `[scheme://]host[:port]` (labels become subdomains). */
  domain: string
  /** Listener bind address; defaults to loopback when empty. */
  bindHost?: string
  /** Omitted = open on loopback binds, token otherwise. */
  auth?: 'open' | 'token'
  /** Omitted with token auth = a session token is generated at start. */
  token?: string
}

/** Live state of the preview proxy listener, for the settings UI. */
export type PreviewProxyStatus = {
  running: boolean
  /** Which config source is (or failed to be) applied; null when disabled. */
  source: 'flags' | 'settings' | null
  /** Wildcard origin clients hit, e.g. `https://*.preview.example.com`. */
  origin?: string
  bindHost?: string
  port?: number
  auth?: 'open' | 'token'
  /** Present so the settings UI can show/copy a generated session token. */
  token?: string | null
  error?: string
}
