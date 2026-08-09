// Why: the localhost worktree-label proxy and the serve preview proxy route by
// hostname differently but forward identically. Keeping the request/upgrade
// forwarding in one place keeps streaming, header, and teardown behavior in
// lockstep between them.
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { URL } from 'node:url'
import { connectableLoopbackHost } from '../shared/localhost-worktree-labels'

export function forwardHttpRequestToTarget(options: {
  target: URL
  request: IncomingMessage
  response: ServerResponse
  /** Names the route in the 502 body so failures are attributable. */
  routeLabel: string
}): void {
  const { request, response, routeLabel } = options
  const target = targetUrlForRequest(options.target, request)
  const proxyRequest = requestForTarget(target, {
    method: request.method,
    headers: requestHeadersForTarget(request, options.target)
  })

  // Why: a client abort or downstream socket error must tear down the
  // upstream request instead of surfacing as an uncaught exception/leak.
  request.on('error', () => proxyRequest.destroy())
  response.on('error', () => proxyRequest.destroy())

  // Why: the proxy only relabels the hostname; responses are streamed
  // through untouched so app headers (CSP, cookies) and bodies are
  // preserved exactly as the dev server sent them.
  proxyRequest.on('response', (proxyResponse) => {
    proxyResponse.on('error', () => response.destroy())
    response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers)
    proxyResponse.pipe(response)
  })
  proxyRequest.on('error', (error) => {
    // Why: once headers/bytes are flushed we can't write a 502, so tear the
    // socket down to avoid an ERR_HTTP_HEADERS_SENT crash.
    if (response.headersSent) {
      response.destroy(error)
      return
    }
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`Proxy failed for ${routeLabel}: ${error.message}`)
  })
  request.pipe(proxyRequest)
}

export function forwardUpgradeToTarget(options: {
  target: URL
  request: IncomingMessage
  socket: Duplex
  head: Buffer
}): void {
  const { request, socket, head } = options
  const target = targetUrlForRequest(options.target, request)
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
  const targetSocket = net.connect(targetPort, connectableLoopbackHost(target.hostname), () => {
    const headers = requestHeadersForTarget(request, options.target)
    targetSocket.write(
      `${request.method ?? 'GET'} ${target.pathname}${target.search} HTTP/${request.httpVersion}\r\n`
    )
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          targetSocket.write(`${name}: ${entry}\r\n`)
        }
      } else if (value !== undefined) {
        targetSocket.write(`${name}: ${value}\r\n`)
      }
    }
    targetSocket.write('\r\n')
    if (head.length > 0) {
      targetSocket.write(head)
    }
    targetSocket.pipe(socket)
    socket.pipe(targetSocket)
  })
  targetSocket.on('error', () => socket.destroy())
  socket.on('error', () => targetSocket.destroy())
}

function requestForTarget(
  target: URL,
  options: { method?: string; headers: http.OutgoingHttpHeaders }
): http.ClientRequest {
  const requestOptions = {
    protocol: target.protocol,
    hostname: connectableLoopbackHost(target.hostname),
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: options.method,
    headers: options.headers
  }
  return target.protocol === 'https:' ? https.request(requestOptions) : http.request(requestOptions)
}

function targetUrlForRequest(target: URL, request: IncomingMessage): URL {
  const url = new URL(target.toString())
  const incomingUrl = new URL(request.url || '/', target)
  url.pathname = incomingUrl.pathname
  url.search = incomingUrl.search
  return url
}

function requestHeadersForTarget(request: IncomingMessage, target: URL): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...request.headers }
  headers.host = target.host
  return headers
}
