/**
 * Timer plumbing shared by the bridge (and providers).
 *
 * Every reducer the bridge hosts (merge, stream, draft-throttle, deliver-queue)
 * needs the same thing: at most one pending wake-up per key, re-armable,
 * cleared on dispose, never keeping the process alive. `KeyedTimers` is that
 * shape, written once.
 */
export class KeyedTimers {
  private readonly timers = new Map<string, NodeJS.Timeout>()

  /** Arm (or re-arm) the timer for `key` to fire at epoch-ms `at` (clamped to now). */
  arm(key: string, at: number, fire: () => void): void {
    this.clear(key)
    const timer = setTimeout(() => {
      this.timers.delete(key)
      fire()
    }, Math.max(0, at - Date.now()))
    timer.unref?.()
    this.timers.set(key, timer)
  }

  clear(key: string): void {
    const timer = this.timers.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(key)
    }
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

/** Sleep that rejects on abort, so a polling loop unwinds promptly on disconnect. */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** True when `promise` settled (either way) within `timeoutMs`; false on timeout. */
export function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref?.()
    const settled = () => {
      clearTimeout(timer)
      resolve(true)
    }
    void promise.then(settled, settled)
  })
}
