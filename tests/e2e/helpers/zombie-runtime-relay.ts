import type { RawData } from 'ws'
import WebSocket, { WebSocketServer } from 'ws'

type QueuedFrame = { data: RawData; isBinary: boolean }

type RelayConnection = {
  downstream: WebSocket
  preserveUpstream: boolean
  upstream: WebSocket
}

export type ZombieRuntimeRelay = {
  close: () => Promise<void>
  endpoint: string
  evidence: () => {
    activeConnectionCount: number
    controlPingCount: number
    connectionCount: number
    zombifiedConnectionCount: number
  }
  zombifyActiveSessions: () => Promise<void>
}

export async function createZombieRuntimeRelay(
  targetEndpoint: string
): Promise<ZombieRuntimeRelay> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const connections = new Set<RelayConnection>()
  let connectionCount = 0
  let controlPingCount = 0
  let zombifiedConnectionCount = 0

  server.on('connection', (upstream) => {
    connectionCount += 1
    const downstream = new WebSocket(targetEndpoint)
    const connection: RelayConnection = { downstream, preserveUpstream: false, upstream }
    const queuedFrames: QueuedFrame[] = []
    connections.add(connection)

    upstream.on('ping', () => {
      controlPingCount += 1
    })
    upstream.on('message', (data, isBinary) => {
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.send(data, { binary: isBinary })
      } else if (downstream.readyState === WebSocket.CONNECTING) {
        queuedFrames.push({ data, isBinary })
      }
    })
    upstream.on('close', () => {
      connections.delete(connection)
      downstream.terminate()
    })
    upstream.on('error', () => undefined)

    downstream.on('open', () => {
      for (const frame of queuedFrames.splice(0)) {
        downstream.send(frame.data, { binary: frame.isBinary })
      }
    })
    downstream.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary })
      }
    })
    downstream.on('close', () => {
      if (!connection.preserveUpstream && upstream.readyState === WebSocket.OPEN) {
        upstream.close()
      }
    })
    downstream.on('error', () => undefined)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Zombie runtime relay did not bind a TCP port')
  }

  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    evidence: () => ({
      activeConnectionCount: connections.size,
      controlPingCount,
      connectionCount,
      zombifiedConnectionCount
    }),
    zombifyActiveSessions: async () => {
      const active = Array.from(connections).filter(
        ({ downstream, upstream }) =>
          downstream.readyState === WebSocket.OPEN && upstream.readyState === WebSocket.OPEN
      )
      if (active.length === 0) {
        throw new Error('Zombie runtime relay has no active session to sever')
      }
      zombifiedConnectionCount += active.length
      await Promise.all(
        active.map(
          ({ downstream }, index) =>
            new Promise<void>((resolve) => {
              active[index].preserveUpstream = true
              downstream.once('close', resolve)
              downstream.terminate()
            })
        )
      )
    },
    close: async () => {
      for (const { downstream, upstream } of connections) {
        upstream.terminate()
        downstream.terminate()
      }
      connections.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
