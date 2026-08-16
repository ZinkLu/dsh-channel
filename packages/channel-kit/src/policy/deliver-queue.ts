/**
 * Outbound delivery queue reducer (pure; timers and IO live outside, like merge.ts / stream.ts).
 *
 * One bounded queue + one serial worker per outlet (chatKey): a full queue
 * backpressures only that outlet, same-outlet delivery order is preserved by the
 * single worker, and every attempt is a *retryable* unit. The queue decides *when*
 * to call `deliver()`; the `channel/deliver` waterfall still decides *what happens*
 * on a given attempt — so this slots in front of `ChannelRegistry.deliver()` with no
 * change to the `channel/deliver` event contract.
 */

/** An item queued for delivery. `value` is opaque to the reducer and rides through to the `attempt` effect. */
export interface QueuedDelivery<T = unknown> {
  /** Stable id used by the ledger/waterfall (the delivery key). */
  readonly key: string
  /** Bridge-owned payload (chatKey, rendered markdown, origin, …). */
  readonly value: T
}

export interface DeliverQueueState<T> {
  /** Item currently being attempted (the single in-flight worker), or null when idle. */
  readonly inFlight: QueuedDelivery<T> | null
  /** Attempts already made on the in-flight item (1 = first attempt; 0 = scheduled but not yet attempted). */
  readonly attempts: number
  /** Absolute epoch-ms to (re)attempt the in-flight item; undefined = attempt immediately. */
  readonly retryAt: number | undefined
  /** Items waiting behind the in-flight item, in FIFO order. */
  readonly waiting: readonly QueuedDelivery<T>[]
}

export function emptyDeliverQueueState<T>(): DeliverQueueState<T> {
  return { inFlight: null, attempts: 0, retryAt: undefined, waiting: [] }
}

export type DeliverQueueInput<T> =
  | { readonly kind: 'enqueue'; readonly item: QueuedDelivery<T>; readonly now: number }
  | { readonly kind: 'attempt-result'; readonly key: string; readonly outcome: 'sent' | 'suppressed' | 'failed'; readonly error?: string; readonly now: number }
  | { readonly kind: 'tick'; readonly now: number }

export type DeliverQueueEffect<T> =
  | { readonly kind: 'attempt'; readonly item: QueuedDelivery<T> }
  | { readonly kind: 'retry-after'; readonly at: number; readonly item: QueuedDelivery<T> }
  | { readonly kind: 'give-up'; readonly item: QueuedDelivery<T>; readonly error: string }
  | { readonly kind: 'reject-backpressure'; readonly item: QueuedDelivery<T> }

export interface DeliverQueueOptions {
  /** Retries after the first attempt (so up to maxRetries+1 attempts total). Default 3. */
  maxRetries?: number
  /** Base backoff delay in ms; the n-th retry waits baseDelayMs * 2^(n-1) (1/2/4s by default). */
  baseDelayMs?: number
  /** Maximum number of waiting items before rejecting new ones with backpressure. Default 32. */
  maxQueue?: number
  /** Minimum spacing between successive deliveries (rate-limit guard, preserves the old 1s inter-chunk sleep). Default 1000. */
  spacingMs?: number
}

export function deliverQueueReduce<T>(
  state: DeliverQueueState<T>,
  input: DeliverQueueInput<T>,
  opts: DeliverQueueOptions = {},
): { state: DeliverQueueState<T>; effects: DeliverQueueEffect<T>[] } {
  const maxRetries = opts.maxRetries ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 1000
  const maxQueue = opts.maxQueue ?? 32
  const spacingMs = opts.spacingMs ?? 1000

  if (input.kind === 'tick') return onTick(state, input.now)
  if (input.kind === 'enqueue') return onEnqueue(state, input, maxQueue)
  return onAttemptResult(state, input, maxRetries, baseDelayMs, spacingMs)
}

function onEnqueue<T>(
  state: DeliverQueueState<T>,
  input: { readonly item: QueuedDelivery<T>; readonly now: number },
  maxQueue: number,
): { state: DeliverQueueState<T>; effects: DeliverQueueEffect<T>[] } {
  if (state.inFlight === null) {
    // Idle worker: start immediately (first attempt).
    return {
      state: { inFlight: input.item, attempts: 1, retryAt: undefined, waiting: [] },
      effects: [{ kind: 'attempt', item: input.item }],
    }
  }
  if (state.waiting.length >= maxQueue) {
    return { state, effects: [{ kind: 'reject-backpressure', item: input.item }] }
  }
  return { state: { ...state, waiting: [...state.waiting, input.item] }, effects: [] }
}

function onAttemptResult<T>(
  state: DeliverQueueState<T>,
  input: { readonly key: string; readonly outcome: 'sent' | 'suppressed' | 'failed'; readonly error?: string; readonly now: number },
  maxRetries: number,
  baseDelayMs: number,
  spacingMs: number,
): { state: DeliverQueueState<T>; effects: DeliverQueueEffect<T>[] } {
  // Stale result for an item that is no longer in flight: ignore (defensive).
  if (state.inFlight === null || input.key !== state.inFlight.key) {
    return { state, effects: [] }
  }

  if (input.outcome === 'sent' || input.outcome === 'suppressed') {
    return advanceToNext(state, input.now, spacingMs, [])
  }

  // Failed attempt: retry with exponential backoff, or give up once retries are exhausted.
  const totalAllowed = maxRetries + 1
  if (state.attempts < totalAllowed) {
    const nextAttempts = state.attempts + 1
    const backoff = baseDelayMs * 2 ** (state.attempts - 1)
    const at = input.now + backoff
    return {
      state: { ...state, attempts: nextAttempts, retryAt: at },
      effects: [{ kind: 'retry-after', at, item: state.inFlight }],
    }
  }

  const giveUpEffects: DeliverQueueEffect<T>[] = [
    { kind: 'give-up', item: state.inFlight, error: input.error ?? 'delivery failed' },
  ]
  return advanceToNext(state, input.now, spacingMs, giveUpEffects)
}

function onTick<T>(state: DeliverQueueState<T>, now: number): { state: DeliverQueueState<T>; effects: DeliverQueueEffect<T>[] } {
  if (state.inFlight === null || state.retryAt === undefined) return { state, effects: [] }
  if (now < state.retryAt) {
    // Early tick: re-request a wakeup at the scheduled time.
    return { state, effects: [{ kind: 'retry-after', at: state.retryAt, item: state.inFlight }] }
  }
  const attempts = state.attempts === 0 ? 1 : state.attempts
  return { state: { ...state, attempts, retryAt: undefined }, effects: [{ kind: 'attempt', item: state.inFlight }] }
}

/** Complete the current in-flight item and advance to the next waiting item (spaced or immediate). */
function advanceToNext<T>(
  state: DeliverQueueState<T>,
  now: number,
  spacingMs: number,
  leadingEffects: DeliverQueueEffect<T>[],
): { state: DeliverQueueState<T>; effects: DeliverQueueEffect<T>[] } {
  const next = state.waiting[0]
  if (next === undefined) {
    return {
      state: { inFlight: null, attempts: 0, retryAt: undefined, waiting: [] },
      effects: leadingEffects,
    }
  }
  const rest = state.waiting.slice(1)
  if (spacingMs > 0) {
    const at = now + spacingMs
    return {
      state: { ...state, inFlight: next, attempts: 0, retryAt: at, waiting: rest },
      effects: [...leadingEffects, { kind: 'retry-after', at, item: next }],
    }
  }
  return {
    state: { ...state, inFlight: next, attempts: 1, retryAt: undefined, waiting: rest },
    effects: [...leadingEffects, { kind: 'attempt', item: next }],
  }
}
