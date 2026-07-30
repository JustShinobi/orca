export const AI_VAULT_DIRECT_SSH_SCAN_CONCURRENCY = 4

export async function mapDirectSshScans<T, U>(
  items: readonly T[],
  mapper: (item: T, signal: AbortSignal) => Promise<U>,
  signal: AbortSignal
): Promise<U[]> {
  const results: U[] = []
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      throwIfAborted(signal)
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index], signal)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(AI_VAULT_DIRECT_SSH_SCAN_CONCURRENCY, items.length) }, () =>
      worker()
    )
  )
  return results
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('ai_vault_scan_cancelled')
  }
}
