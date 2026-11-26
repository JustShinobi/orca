import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalhostWorktreeLabelProxy } from './localhost-worktree-label-proxy'

const upstreamServers: http.Server[] = []
const openSockets: net.Socket[] = []

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    socket.destroy()
  }
  await Promise.all(
    upstreamServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

async function startUpstream(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
  host = '127.0.0.1'
): Promise<number> {
  const server = http.createServer(handler)
  upstreamServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  return (server.address() as AddressInfo).port
}

async function startUpgradeUpstream(
  onUpgrade: (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void,
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void = (_req, res) =>
    res.end('ok'),
  host = '127.0.0.1'
): Promise<number> {
  const server = http.createServer(handler)
  server.on('upgrade', (request, socket, head) => {
    if (socket instanceof net.Socket) {
      openSockets.push(socket)
    }
    onUpgrade(request, socket, head)
  })
  upstreamServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  return (server.address() as AddressInfo).port
}

function fetchThroughProxy(
  labeledUrl: string,
  headers: http.OutgoingHttpHeaders = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const url = new URL(labeledUrl)
  return new Promise((resolve, reject) => {
    // Bypass DNS with loopback; route the worktree label through Host.
    const request = http.request(
      {
        host: '127.0.0.1',
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers
          })
        )
      }
    )
    request.on('error', reject)
    request.end()
  })
}

describe('localhost worktree label proxy', () => {
  it('streams responses through untouched, preserving the app CSP and body', async () => {
    const port = await startUpstream((_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'"
      })
      response.end('<html><head></head><body>hello</body></html>')
    })
    const proxy = new LocalhostWorktreeLabelProxy()
    const { url } = await proxy.registerRoute({
      targetUrl: `http://localhost:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'analytics'
    })

    const result = await fetchThroughProxy(url)

    expect(result.status).toBe(200)
    expect(result.body).toBe('<html><head></head><body>hello</body></html>')
    expect(result.headers['content-security-policy']).toBe("default-src 'self'")
  })

  it('keeps Host on the target and forwards the labeled host, replacing a client value', async () => {
    let upstreamHeaders: http.IncomingHttpHeaders = {}
    const port = await startUpstream((request, response) => {
      upstreamHeaders = request.headers
      response.end()
    })
    const proxy = new LocalhostWorktreeLabelProxy()
    const { url } = await proxy.registerRoute({
      targetUrl: `http://localhost:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'analytics'
    })

    await fetchThroughProxy(url, { 'x-forwarded-host': 'attacker.example' })

    expect(upstreamHeaders.host).toBe(`localhost:${port}`)
    expect(upstreamHeaders['x-forwarded-host']).toBe(new URL(url).host)
  })

  it('normalizes a 0.0.0.0 target to a connectable loopback host', async () => {
    const port = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
    const proxy = new LocalhostWorktreeLabelProxy()
    const { url } = await proxy.registerRoute({
      targetUrl: `http://0.0.0.0:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'main'
    })

    const result = await fetchThroughProxy(url)

    expect(result.status).toBe(200)
    expect(result.body).toBe('ok')
  })

  it('returns 404 for unregistered orca.localhost labels', async () => {
    const port = await startUpstream((_request, response) => {
      response.end('ok')
    })
    const proxy = new LocalhostWorktreeLabelProxy()
    const { url } = await proxy.registerRoute({
      targetUrl: `http://localhost:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'main'
    })
    const proxyPort = new URL(url).port

    const result = await fetchThroughProxy(`http://unknown-label.orca.localhost:${proxyPort}/`)

    expect(result.status).toBe(404)
  })

  it('drops a worktree label routes on unregisterWorktree, leaving others intact', async () => {
    const port = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
    const proxy = new LocalhostWorktreeLabelProxy()
    const a = await proxy.registerRoute({
      targetUrl: `http://localhost:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'feature-a',
      worktreeId: 'wt-a'
    })
    const b = await proxy.registerRoute({
      targetUrl: `http://localhost:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'feature-b',
      worktreeId: 'wt-b'
    })

    expect((await fetchThroughProxy(a.url)).status).toBe(200)
    expect((await fetchThroughProxy(b.url)).status).toBe(200)

    proxy.unregisterWorktree('wt-a')

    expect((await fetchThroughProxy(a.url)).status).toBe(404)
    expect((await fetchThroughProxy(b.url)).status).toBe(200)
  })

  it('forwards HTTP and WebSocket upgrade requests to bracketed IPv6 loopback targets', async () => {
    const port = await startUpgradeUpstream(
      (_request, socket, head) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
        if (head.length > 0) {
          socket.write(head)
        }
        socket.on('data', (chunk) => socket.write(`echo:${chunk.toString('utf8')}`))
      },
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('ipv6-http-ok')
      },
      '::1'
    )
    const proxy = new LocalhostWorktreeLabelProxy()
    const { url } = await proxy.registerRoute({
      targetUrl: `http://[::1]:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'ipv6'
    })

    const httpResult = await fetchThroughProxy(url)
    expect(httpResult.status).toBe(200)
    expect(httpResult.body).toBe('ipv6-http-ok')

    const parsed = new URL(url)
    const upgraded = await new Promise<string>((resolve, reject) => {
      const client = net.connect(Number(parsed.port), '127.0.0.1', () => {
        client.write(
          `GET /ws HTTP/1.1\r\nHost: ${parsed.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
        )
      })
      openSockets.push(client)
      let buffer = ''
      let handshakeDone = false
      client.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        if (!handshakeDone && buffer.includes('\r\n\r\n')) {
          handshakeDone = true
          client.write('ping')
          return
        }
        if (handshakeDone && buffer.includes('echo:ping')) {
          client.destroy()
          resolve(buffer)
        }
      })
      client.on('error', reject)
    })
    expect(upgraded).toContain('HTTP/1.1 101 Switching Protocols')
    expect(upgraded).toContain('echo:ping')
  })

  it('returns 400 on malformed HTTP request targets and closes malformed upgrades without crashing', async () => {
    const port = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('healthy')
    })
    const proxy = new LocalhostWorktreeLabelProxy()
    const { url } = await proxy.registerRoute({
      targetUrl: `http://localhost:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'malformed'
    })
    const parsed = new URL(url)

    const httpReply = await new Promise<string>((resolve, reject) => {
      const client = net.connect(Number(parsed.port), '127.0.0.1', () => {
        client.end(
          `GET http://[invalid HTTP/1.1\r\nHost: ${parsed.host}\r\nConnection: close\r\n\r\n`
        )
      })
      openSockets.push(client)
      const chunks: Buffer[] = []
      client.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      client.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      client.on('error', reject)
    })
    expect(httpReply.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request')

    await new Promise<void>((resolve, reject) => {
      const client = net.connect(Number(parsed.port), '127.0.0.1', () => {
        client.write(
          `GET //[invalid HTTP/1.1\r\nHost: ${parsed.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
        )
      })
      openSockets.push(client)
      client.on('close', () => resolve())
      client.on('error', reject)
    })

    expect((await fetchThroughProxy(url)).status).toBe(200)
  })

  it('aborts upstream streaming responses when the downstream HTTP client closes early', async () => {
    let signalUpstreamClosed: (() => void) | null = null
    const upstreamClosed = new Promise<void>((resolve) => {
      signalUpstreamClosed = resolve
    })
    const port = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: first\n\n')
      response.on('close', () => {
        if (!response.writableFinished) {
          signalUpstreamClosed?.()
        }
      })
    })
    const proxy = new LocalhostWorktreeLabelProxy()
    const { url } = await proxy.registerRoute({
      targetUrl: `http://localhost:${port}/events`,
      projectName: 'Snap Studio',
      worktreeName: 'stream-abort'
    })
    const parsed = new URL(url)

    await new Promise<void>((resolve) => {
      const clientRequest = http.request(
        {
          host: '127.0.0.1',
          port: Number(parsed.port),
          path: parsed.pathname,
          headers: { host: parsed.host }
        },
        (clientResponse) => {
          clientResponse.once('data', () => {
            clientRequest.destroy()
            resolve()
          })
        }
      )
      clientRequest.on('error', () => resolve())
      clientRequest.on('socket', (socket) => openSockets.push(socket))
      clientRequest.end()
    })

    await upstreamClosed
  })

  it('destroys the upstream upgrade socket when the downstream client resets abruptly', async () => {
    let signalUpstreamClosed: (() => void) | null = null
    const upstreamClosed = new Promise<void>((resolve) => {
      signalUpstreamClosed = resolve
    })
    const port = await startUpgradeUpstream((_request, upstreamSocket) => {
      upstreamSocket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
      upstreamSocket.on('error', () => {})
      upstreamSocket.on('close', () => signalUpstreamClosed?.())
      // Probes detect whether the proxy destroyed targetSocket rather than leaving it half-open.
      upstreamSocket.on('end', () => {
        upstreamSocket.write('probe-1', () => {
          if (!upstreamSocket.destroyed) {
            upstreamSocket.write('probe-2')
          }
        })
      })
    })
    const proxy = new LocalhostWorktreeLabelProxy()
    const { url } = await proxy.registerRoute({
      targetUrl: `http://localhost:${port}/`,
      projectName: 'Snap Studio',
      worktreeName: 'upgrade-abort'
    })
    const parsed = new URL(url)

    await new Promise<void>((resolve, reject) => {
      const client = net.connect(Number(parsed.port), '127.0.0.1', () => {
        client.write(
          `GET /ws HTTP/1.1\r\nHost: ${parsed.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
        )
      })
      openSockets.push(client)
      client.once('data', () => {
        client.resetAndDestroy()
        resolve()
      })
      client.on('error', reject)
    })

    await upstreamClosed
  })
})
