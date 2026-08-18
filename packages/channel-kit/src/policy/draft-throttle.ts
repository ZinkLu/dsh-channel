/**
 * Adaptive draft-edit throttle: flood →
 * interval doubles; any success → strikes reset to zero; server `retry_after`
 * is honored only up to a ceiling. Beyond the ceiling the reducer reports
 * `fail-over` instead of stalling the user.
 */

export interface DraftThrottleState {
  /** Consecutive edit failures since the last success. */
  readonly strikes: number
  /** Earliest epoch-ms at which the next edit attempt is allowed. */
  readonly nextAttemptAt: number | undefined
}

export const emptyDraftThrottleState: DraftThrottleState = { strikes: 0, nextAttemptAt: undefined }

export type DraftThrottleInput =
  | { readonly kind: 'attempt'; readonly now: number }
  | { readonly kind: 'success'; readonly now: number }
  | { readonly kind: 'failure'; readonly now: number; readonly retryAfterMs?: number }

export type DraftThrottleEffect =
  | { readonly kind: 'allow' }
  | { readonly kind: 'delay'; readonly at: number }
  | { readonly kind: 'fail-over' }
  | { readonly kind: 'noop' }

export interface DraftThrottleOptions {
  /** Base spacing between edits; default 800ms. */
  baseIntervalMs?: number
  /** Hard ceiling for the doubled interval; default 5000ms. */
  maxIntervalMs?: number
  /** Server retry_after is honored only up to this ceiling; default 5000ms. */
  maxRetryAfterMs?: number
}

export function draftThrottleReduce(
  state: DraftThrottleState,
  input: DraftThrottleInput,
  opts: DraftThrottleOptions = {},
): { state: DraftThrottleState; effect: DraftThrottleEffect } {
  const baseIntervalMs = opts.baseIntervalMs ?? 800
  const maxIntervalMs = opts.maxIntervalMs ?? 5000
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 5000

  if (input.kind === 'success') {
    return { state: { strikes: 0, nextAttemptAt: input.now + baseIntervalMs }, effect: { kind: 'allow' } }
  }

  if (input.kind === 'attempt') {
    if (state.nextAttemptAt !== undefined && input.now < state.nextAttemptAt) {
      return { state, effect: { kind: 'delay', at: state.nextAttemptAt } }
    }
    return { state: { ...state, nextAttemptAt: undefined }, effect: { kind: 'allow' } }
  }

  // failure
  const strikes = state.strikes + 1
  const doubled = baseIntervalMs * 2 ** (strikes - 1)
  const backoff = Math.min(doubled, maxIntervalMs)

  if (input.retryAfterMs !== undefined && input.retryAfterMs > maxRetryAfterMs) {
    // Server wants a longer stall than we are willing to impose on the user:
    // fail over instead of freezing the preview.
    return { state: { strikes, nextAttemptAt: input.now + maxRetryAfterMs }, effect: { kind: 'fail-over' } }
  }

  const retryAfter = input.retryAfterMs !== undefined ? Math.min(input.retryAfterMs, maxRetryAfterMs) : 0
  const delay = Math.max(backoff, retryAfter)
  return { state: { strikes, nextAttemptAt: input.now + delay }, effect: { kind: 'delay', at: input.now + delay } }
}
