import type { SendErrorKind } from 'dsh-channel'
import type { DeliveryState, RecoverableDelivery } from '../policy/recovery.js'

/** Dedupe outcome: "seen, still being processed" / "seen, answered" / "seen, gave up". */
export type InboundOutcome = 'handling' | 'done' | 'failed'

export interface DeliveryRecord {
  state: DeliveryState
  chatKey: string
  textHash: string
  attempts: number
  platformMessageIds?: readonly string[]
  error?: string
  errorKind?: SendErrorKind
  createdAt: number
  updatedAt: number
}

export interface ChannelStore {
  // inbound dedupe (TTL map with outcome)
  seenInbound(messageId: string): boolean
  inboundOutcome(messageId: string): InboundOutcome | undefined
  markInbound(messageId: string, outcome?: InboundOutcome): void
  // merge crash recovery
  setMergeBuffer(chatKey: string, buffer: readonly string[]): void
  mergeBuffers(): Readonly<Record<string, readonly string[]>>
  // explicit binding (/bind exception path)
  setBinding(chatKey: string, sessionId: string | undefined): void
  bindings(): Readonly<Record<string, string>>
  // outbound ledger
  recordDelivery(key: string, out: { chatKey: string; textHash: string }): void
  markAttempting(key: string): void
  markDelivered(key: string, platformMessageIds: readonly string[]): void
  markFailed(key: string, error: string, errorKind?: SendErrorKind): void
  /**
   * Reclaim at startup. A failed/attempting/pending entry becomes abandoned only when
   * BOTH the attempt cap is reached AND the entry is old enough (otherwise a short
   * platform outage would discard messages that were never once sent).
   */
  sweepRecoverable(opts?: { now?: number; minAgeMs?: number }): Array<RecoverableDelivery>
  flush(): Promise<void>
}

export interface MemoryStoreOptions {
  /** seen-map cap; default 10_000 */
  seenLimit?: number
  /** entries to keep when trimming the seen map; default 5_000 */
  seenTrimTo?: number
  /** seen entry TTL ms; default 24h */
  seenTtlMs?: number
  /** max delivery attempts; beyond this (plus min age) sweep turns it abandoned */
  maxAttempts?: number
  /** minimum age before an over-attempt entry is abandoned; default 24h */
  abandonMinAgeMs?: number
  /** how long a settled (delivered/abandoned) ledger entry is retained; default 24h */
  deliveryRetentionMs?: number
}

/** A ledger entry in a terminal state older than the retention window is dropped (the ledger is a handoff log, not an archive). */
export function pruneSettledDeliveries(
  deliveries: Map<string, DeliveryRecord>,
  now: number,
  retentionMs: number,
): boolean {
  let pruned = false
  for (const [key, record] of deliveries) {
    if (record.state !== 'delivered' && record.state !== 'abandoned') continue
    if (now - record.updatedAt < retentionMs) continue
    deliveries.delete(key)
    pruned = true
  }
  return pruned
}

/** In-memory implementation for unit tests and non-persistent scenarios. Pure data operations + explicit flush. */
export function createMemoryStore(opts: MemoryStoreOptions = {}): ChannelStore {
  const seenLimit = opts.seenLimit ?? 10_000
  const seenTrimTo = opts.seenTrimTo ?? 5_000
  const seenTtlMs = opts.seenTtlMs ?? 24 * 60 * 60 * 1000
  const maxAttempts = opts.maxAttempts ?? 3
  const abandonMinAgeMs = opts.abandonMinAgeMs ?? 24 * 60 * 60 * 1000
  const deliveryRetentionMs = opts.deliveryRetentionMs ?? 24 * 60 * 60 * 1000

  const seen = new Map<string, { outcome: InboundOutcome; expiresAt: number }>()
  const mergeBuffers = new Map<string, string[]>()
  const bindings = new Map<string, string>()
  const deliveries = new Map<string, DeliveryRecord>()

  /** Amortized prune: TTL sweep, then trim the oldest entries back to `seenTrimTo`. */
  const pruneSeen = (now: number) => {
    for (const [id, entry] of seen) {
      if (entry.expiresAt <= now) seen.delete(id)
    }
    if (seen.size <= seenLimit) return
    for (const id of [...seen.keys()].slice(0, seen.size - seenTrimTo)) seen.delete(id)
  }

  /** Live outcome, or undefined when unseen/expired (the one place the TTL is enforced on read). */
  const liveOutcome = (messageId: string): InboundOutcome | undefined => {
    const entry = seen.get(messageId)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      seen.delete(messageId)
      return undefined
    }
    return entry.outcome
  }

  return {
    seenInbound(messageId: string) {
      return liveOutcome(messageId) !== undefined
    },
    inboundOutcome: liveOutcome,
    markInbound(messageId: string, outcome: InboundOutcome = 'done') {
      if (messageId === '') return
      const now = Date.now()
      const existing = seen.get(messageId)
      if (existing !== undefined && existing.expiresAt > now) {
        // Upgrade handling→done/failed; never downgrade a terminal outcome.
        if (existing.outcome === 'handling' || outcome !== 'handling') {
          existing.outcome = outcome
          existing.expiresAt = now + seenTtlMs
        }
        return
      }
      seen.set(messageId, { outcome, expiresAt: now + seenTtlMs })
      pruneSeen(now)
    },
    setMergeBuffer(chatKey: string, buffer: readonly string[]) {
      if (buffer.length === 0) {
        mergeBuffers.delete(chatKey)
      } else {
        mergeBuffers.set(chatKey, [...buffer])
      }
    },
    mergeBuffers() {
      return Object.fromEntries([...mergeBuffers.entries()].map(([k, v]) => [k, [...v] as readonly string[]]))
    },
    setBinding(chatKey: string, sessionId: string | undefined) {
      if (sessionId === undefined) {
        bindings.delete(chatKey)
      } else {
        bindings.set(chatKey, sessionId)
      }
    },
    bindings() {
      return Object.fromEntries(bindings)
    },
    recordDelivery(key: string, out: { chatKey: string; textHash: string }) {
      const now = Date.now()
      deliveries.set(key, {
        state: 'pending',
        chatKey: out.chatKey,
        textHash: out.textHash,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      })
    },
    markAttempting(key: string) {
      const record = deliveries.get(key)
      if (!record) return
      record.state = 'attempting'
      record.attempts += 1
      record.updatedAt = Date.now()
    },
    markDelivered(key: string, platformMessageIds: readonly string[]) {
      const record = deliveries.get(key)
      if (!record) return
      record.state = 'delivered'
      record.platformMessageIds = [...platformMessageIds]
      record.updatedAt = Date.now()
    },
    markFailed(key: string, error: string, errorKind?: SendErrorKind) {
      const record = deliveries.get(key)
      if (!record) return
      record.state = 'failed'
      record.error = error
      if (errorKind !== undefined) record.errorKind = errorKind
      record.updatedAt = Date.now()
    },
    sweepRecoverable(opts: { now?: number; minAgeMs?: number } = {}) {
      const now = opts.now ?? Date.now()
      const minAgeMs = opts.minAgeMs ?? abandonMinAgeMs
      pruneSettledDeliveries(deliveries, now, deliveryRetentionMs)
      const result: RecoverableDelivery[] = []
      for (const [key, record] of deliveries) {
        if (record.state === 'pending' || record.state === 'attempting' || record.state === 'failed') {
          if (record.attempts >= maxAttempts && now - record.createdAt >= minAgeMs) {
            record.state = 'abandoned'
            record.updatedAt = now
            continue
          }
          result.push({ key, state: record.state, chatKey: record.chatKey, attempts: record.attempts, errorKind: record.errorKind })
        }
      }
      return result
    },
    async flush() {},
  }
}
