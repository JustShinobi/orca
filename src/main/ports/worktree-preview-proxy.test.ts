import http, { type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreviewRouteEntry, PreviewRouteIndex } from './preview-route-resolver'
import { parsePreviewDomain } from './worktree-preview-routes'
import { WorktreePreviewProxy, type WorktreePreviewProxyOptions } from './worktree-preview-proxy'

const origin = parsePreviewDomain('http://preview.test')

type Harness = {
  request: (options: {
    host: string
    path?: string
    headers?: Record<string, string>
  }) => Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>
}

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
  vi.restoreAllMocks()
})

async function startUpstream(
  handler: http.RequestListener = (request, response) => {
    response.writeHead(200, { 'x-upstream': 'yes' })
    response.end(`upstream:${request.headers.host}:${request.url}`)
  }
): Promise<number> {
  const server: Server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('upstream failed to bind')
  }
  return address.port
}

function routeEntry(overrides: Partial<PreviewRouteEntry>): PreviewRouteEntry {
  return {
    worktreeId: 'repo::/w/feat',
    label: 'feat',
    displayName: 'feat',
    primaryPort: null,
    ports: [],
    ...overrides
  }
}

async function startProxy(
  index: PreviewRouteIndex,
  overrides: Partial<WorktreePreviewProxyOptions> = {}
): Promise<Harness> {
  const proxy = new WorktreePreviewProxy({
    bindHost: '127.0.0.1',
    port: 0,
    origin,
    auth: 'open',
    token: null,
    resolveRoutes: async () => index,
    ...overrides
  })
  const { port } = await proxy.start()
  cleanups.push(() => proxy.stop())
  return {
    request: ({ host, path = '/', headers = {} }) =>
      new Promise((resolve, reject) => {
        const request = http.request(
          { host: '127.0.0.1', port, path, headers: { host, ...headers } },
          (response) => {
            let body = ''
            response.on('data', (chunk: Buffer) => {
              body += chunk.toString()
            })
            response.on('end', () =>
              resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
            )
          }
        )
        request.once('error', reject)
        request.end()
      })
  }
}

describe('WorktreePreviewProxy routing', () => {
  it('routes an explicit port suffix to the workspace listener', async () => {
    const upstreamPort = await startUpstream()
    const index: PreviewRouteIndex = new Map([
      ['feat', routeEntry({ ports: [{ port: upstreamPort, connectHost: 'localhost' }] })]
    ])
    const harness = await startProxy(index)

    const response = await harness.request({
      host: `feat--${upstreamPort}.preview.test`,
      path: '/api?x=1'
    })
    expect(response.status).toBe(200)
    expect(response.headers['x-upstream']).toBe('yes')
    // The upstream sees its own host, not the preview host.
    expect(response.body).toBe(`upstream:localhost:${upstreamPort}:/api?x=1`)
  })

  it('routes a bare label to the primary port', async () => {
    const upstreamPort = await startUpstream()
    const index: PreviewRouteIndex = new Map([
      [
        'feat',
        routeEntry({
          primaryPort: upstreamPort,
          ports: [{ port: upstreamPort, connectHost: 'localhost' }]
        })
      ]
    ])
    const harness = await startProxy(index)

    const response = await harness.request({ host: 'feat.preview.test' })
    expect(response.status).toBe(200)
  })

  it('lists ports when a bare label has several and none advertised', async () => {
    const index: PreviewRouteIndex = new Map([
      [
        'feat',
        routeEntry({
          ports: [
            { port: 3000, connectHost: 'localhost' },
            { port: 5173, connectHost: 'localhost' }
          ]
        })
      ]
    ])
    const harness = await startProxy(index)

    const response = await harness.request({ host: 'feat.preview.test' })
    expect(response.status).toBe(200)
    expect(response.body).toContain('feat--3000.preview.test')
    expect(response.body).toContain('feat--5173.preview.test')
  })

  it('404s unknown labels and hosts outside the preview domain', async () => {
    const harness = await startProxy(new Map())
    expect((await harness.request({ host: 'ghost.preview.test' })).status).toBe(404)
    expect((await harness.request({ host: 'other.example.com' })).status).toBe(404)
  })

  it('retries with a fresh scan before failing a port that just started', async () => {
    const upstreamPort = await startUpstream()
    const stale: PreviewRouteIndex = new Map([['feat', routeEntry({})]])
    const fresh: PreviewRouteIndex = new Map([
      ['feat', routeEntry({ ports: [{ port: upstreamPort, connectHost: 'localhost' }] })]
    ])
    const resolveRoutes = vi.fn(async ({ fresh: wantFresh = false } = {}) =>
      wantFresh ? fresh : stale
    )
    const harness = await startProxy(stale, { resolveRoutes })

    const response = await harness.request({ host: `feat--${upstreamPort}.preview.test` })
    expect(response.status).toBe(200)
    expect(resolveRoutes).toHaveBeenCalledWith({ fresh: true })
  })
})

describe('WorktreePreviewProxy token auth', () => {
  async function startTokenProxy(upstreamPort: number): Promise<Harness> {
    const index: PreviewRouteIndex = new Map([
      ['feat', routeEntry({ ports: [{ port: upstreamPort, connectHost: 'localhost' }] })]
    ])
    return startProxy(index, { auth: 'token', token: 'secret' })
  }

  it('rejects requests without the token or cookie', async () => {
    const harness = await startTokenProxy(await startUpstream())
    const response = await harness.request({ host: 'feat--3000.preview.test' })
    expect(response.status).toBe(401)
  })

  it('rejects a wrong token', async () => {
    const harness = await startTokenProxy(await startUpstream())
    const response = await harness.request({
      host: 'feat--3000.preview.test',
      path: '/?orca-preview-token=wrong'
    })
    expect(response.status).toBe(403)
  })

  it('exchanges a valid token query for a domain cookie and redirects', async () => {
    const upstreamPort = await startUpstream()
    const harness = await startTokenProxy(upstreamPort)
    const response = await harness.request({
      host: `feat--${upstreamPort}.preview.test`,
      path: '/deep/page?orca-preview-token=secret&keep=1'
    })
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('/deep/page?keep=1')
    const cookie = String(response.headers['set-cookie'])
    expect(cookie).toContain('orca_preview_token=secret')
    expect(cookie).toContain('Domain=preview.test')
    expect(cookie).toContain('HttpOnly')
  })

  it('accepts the cookie on subsequent requests', async () => {
    const upstreamPort = await startUpstream()
    const harness = await startTokenProxy(upstreamPort)
    const response = await harness.request({
      host: `feat--${upstreamPort}.preview.test`,
      headers: { cookie: 'orca_preview_token=secret' }
    })
    expect(response.status).toBe(200)
  })
})
