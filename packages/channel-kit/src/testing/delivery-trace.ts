/**
 * Delivery-trace golden support.
 *
 * A scenario is replayed under a fake clock and the observed client-call
 * sequence is canonicalized to JSONL. The fixed non-zero epoch matters:
 * throttle state seeded with `lastSent = 0` reads epoch 0 as "just sent";
 * a zero-based fake clock silently hides that class of bug.
 */

export const TRACE_CLOCK_EPOCH = 1_700_000_000_000

export interface TraceClock {
  now(): number
  advance(ms: number): void
  set(epochMs: number): void
}

export function createTraceClock(start: number = TRACE_CLOCK_EPOCH): TraceClock {
  let current = start
  return {
    now: () => current,
    advance(ms) {
      current += ms
    },
    set(epochMs) {
      current = epochMs
    },
  }
}

export interface TraceEvent {
  readonly at: number
  readonly kind: string
  readonly [key: string]: unknown
}

export interface DeliveryTracer {
  record(kind: string, payload?: Record<string, unknown>): void
  events(): readonly TraceEvent[]
  toJsonl(): string
}

export function createDeliveryTracer(clock: TraceClock): DeliveryTracer {
  const events: TraceEvent[] = []
  return {
    record(kind, payload = {}) {
      events.push({ at: clock.now(), kind, ...payload })
    },
    events() {
      return [...events]
    },
    toJsonl() {
      return events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : '')
    },
  }
}

/** Re-record a trace golden when the env flag is set (tests call this with the actual trace). */
export function traceGoldenPath(name: string, actual: string): string | undefined {
  if (process.env['DSH_CHANNEL_RE_RECORD_TRACE'] === '1') {
    return `${name}.jsonl`
  }
  return undefined
}
