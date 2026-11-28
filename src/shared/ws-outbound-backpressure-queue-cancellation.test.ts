import { expect, it, vi } from 'vitest'
import { createWsOutboundBackpressureQueue } from './ws-outbound-backpressure-queue'

it('bounds retained storage when parked frames are repeatedly cancelled behind a live frame', () => {
  vi.useFakeTimers()
  const sent: string[] = []
  let bufferedAmount = 100
  const queue = createWsOutboundBackpressureQueue<string>({
    send: (frame) => sent.push(frame),
    byteLengthOf: (frame) => frame.length,
    getBufferedAmount: () => bufferedAmount,
    isWritable: () => true,
    onOverflow: vi.fn(),
    softCapBytes: 10,
    maxQueuedFrames: 3
  })

  try {
    expect(queue.enqueue('first')).toBe(true)
    const middle = queue.enqueueCancelable('middle')
    expect(queue.enqueue('last')).toBe(true)
    expect(middle.cancel()).toBe(true)
    for (let index = 0; index < 2_000; index += 1) {
      const cancelled = queue.enqueueCancelable('cancelled')
      expect(cancelled.accepted).toBe(true)
      expect(cancelled.cancel()).toBe(true)
    }
    expect(queue.evidence()).toEqual({ queuedBytes: 9, queuedFrames: 2, storageSlots: 2 })

    bufferedAmount = 0
    vi.runOnlyPendingTimers()
    expect(sent).toEqual(['first', 'last'])
    expect(queue.evidence()).toEqual({ queuedBytes: 0, queuedFrames: 0, storageSlots: 0 })
  } finally {
    queue.dispose()
    vi.useRealTimers()
  }
})
