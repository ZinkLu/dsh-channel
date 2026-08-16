import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SendErrorKind } from 'dsh-channel'
import type { RecoverableDelivery } from '../../policy/recovery.js'
import { pruneSettledDeliveries, type ChannelStore, type DeliveryRecord, type InboundOutcome } from '../store.js'

const WRITE_DEBOUNCE_MS = 500

interface JsonFileData {
  version: 1
  seenInbound: string[]
  inboundOutcomes: Record<string, InboundOutcome>
  mergeBuffers: Record<string, string[]>
  bindings: Record<string, string>
  deliveries: Record<string, DeliveryRecord>
}

function emptyData(): JsonFileData {
  return { version: 1, seenInbound: [], inboundOutcomes: {}, mergeBuffers: {}, bindings: {}, deliveries: {} }
}

function normalize(data: Partial<JsonFileData> | null | undefined): JsonFileData {
  if (!data || typeof data !== 'object') return emptyData()
  return {
    version: 1,
    seenInbound: Array.isArray(data.seenInbound) ? data.seenInbound.filter((x): x is string => typeof x === 'string') : [],
    inboundOutcomes: normalizeOutcomes(data.inboundOutcomes),
    mergeBuffers: normalizeStringArrayRecord(data.mergeBuffers),
    bindings: normalizeStringRecord(data.bindings),
    deliveries: normalizeDeliveries(data.deliveries),
  }
}

function normalizeStringArrayRecord(record: unknown): Record<string, string[]> {
  if (!record || typeof record !== 'object') return {}
  const result: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      result[key] = value.filter((item): item is string => typeof item === 'string')
    }
  }
  return result
}

function normalizeStringRecord(record: unknown): Record<string, string> {
  if (!record || typeof record !== 'object') return {}
  return Object.fromEntries(
    Object.entries(record as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function normalizeOutcomes(record: unknown): Record<string, InboundOutcome> {
  if (!record || typeof record !== 'object') return {}
  const result: Record<string, InboundOutcome> = {}
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (value === 'handling' || value === 'done' || value === 'failed') result[key] = value
  }
  return result
}

function normalizeDeliveries(record: unknown): Record<string, DeliveryRecord> {
  if (!record || typeof record !== 'object') return {}
  const result: Record<string, DeliveryRecord> = {}
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const item = value as Partial<DeliveryRecord>
    if (typeof item.state !== 'string' || typeof item.chatKey !== 'string') continue
    result[key] = {
      state: item.state as DeliveryRecord['state'],
      chatKey: item.chatKey,
      textHash: typeof item.textHash === 'string' ? item.textHash : '',
      attempts: typeof item.attempts === 'number' ? item.attempts : 0,
      platformMessageIds: Array.isArray(item.platformMessageIds) ? [...item.platformMessageIds] : undefined,
      error: typeof item.error === 'string' ? item.error : undefined,
      errorKind: item.errorKind,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
    }
  }
  return result
}

/**
 * JSON file implementation: tmp+rename atomic writes, 500ms debounce.
 * The only file in the package that touches the filesystem; the interface stays pure
 * data operations + explicit flush.
 */
export function createJsonFileStore(path: string): ChannelStore {
  const seenLimit = 1000
  const seenTrimTo = 500
  const maxAttempts = 3
  const abandonMinAgeMs = 24 * 60 * 60 * 1000
  const deliveryRetentionMs = 24 * 60 * 60 * 1000

  /** messageId → outcome. A Map is insertion-ordered, so it is also the LRU trim order. */
  const seen = new Map<string, InboundOutcome>()
  const mergeBuffers = new Map<string, string[]>()
  const bindings = new Map<string, string>()
  const deliveries = new Map<string, DeliveryRecord>()

  let writeTimer: NodeJS.Timeout | undefined
  let writeChain: Promise<void> = Promise.resolve()
  let dirty = false

  const trimSeen = () => {
    if (seen.size <= seenLimit) return
    for (const id of [...seen.keys()].slice(0, seen.size - seenTrimTo)) seen.delete(id)
  }

  const scheduleWrite = () => {
    dirty = true
    if (writeTimer !== undefined) return
    writeTimer = setTimeout(() => {
      writeTimer = undefined
      void flush()
    }, WRITE_DEBOUNCE_MS)
    // Don't let the timer keep the Node process alive on exit.
    writeTimer.unref?.()
  }

  const loadSync = (): void => {
    try {
      const raw = readFileSync(path, 'utf8')
      const data = normalize(JSON.parse(raw))
      for (const id of data.seenInbound) {
        if (!seen.has(id)) seen.set(id, data.inboundOutcomes[id] ?? 'done')
      }
      trimSeen()
      for (const [k, v] of Object.entries(data.mergeBuffers)) mergeBuffers.set(k, [...v])
      for (const [k, v] of Object.entries(data.bindings)) bindings.set(k, v)
      for (const [k, v] of Object.entries(data.deliveries)) deliveries.set(k, { ...v })
    } catch (error) {
      // A missing or corrupt file must not block the channel: ledger/seen start from scratch, with log folding as the fallback.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Rename the corrupt file to .bak so not every startup fails.
        try { renameSync(path, `${path}.bak`) } catch { /* noop */ }
      }
    }
  }

  const snapshot = (): JsonFileData => ({
    version: 1,
    seenInbound: [...seen.keys()],
    inboundOutcomes: Object.fromEntries(seen),
    mergeBuffers: Object.fromEntries([...mergeBuffers.entries()].map(([k, v]) => [k, [...v]])),
    bindings: Object.fromEntries(bindings),
    deliveries: Object.fromEntries(
      [...deliveries.entries()].map(([k, v]) => [k, { ...v, platformMessageIds: v.platformMessageIds ? [...v.platformMessageIds] : undefined }]),
    ),
  })

  const flush = async (): Promise<void> => {
    if (writeTimer !== undefined) {
      clearTimeout(writeTimer)
      writeTimer = undefined
    }
    if (!dirty) return
    dirty = false
    writeChain = writeChain.then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
      await writeFile(tmp, JSON.stringify(snapshot(), null, 2), 'utf8')
      await rename(tmp, path)
    })
    await writeChain
  }

  const store: ChannelStore = {
    seenInbound(messageId: string) {
      return seen.has(messageId)
    },
    inboundOutcome(messageId: string) {
      return seen.get(messageId)
    },
    markInbound(messageId: string, outcome: InboundOutcome = 'done') {
      if (messageId === '') return
      const existing = seen.get(messageId)
      // Upgrade handling→done/failed; never downgrade a terminal outcome.
      if (existing === undefined || existing === 'handling' || outcome !== 'handling') {
        seen.set(messageId, outcome)
      }
      trimSeen()
      scheduleWrite()
    },
    setMergeBuffer(chatKey: string, buffer: readonly string[]) {
      if (buffer.length === 0) {
        mergeBuffers.delete(chatKey)
      } else {
        mergeBuffers.set(chatKey, [...buffer])
      }
      scheduleWrite()
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
      scheduleWrite()
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
      scheduleWrite()
    },
    markAttempting(key: string) {
      const record = deliveries.get(key)
      if (!record) return
      record.state = 'attempting'
      record.attempts += 1
      record.updatedAt = Date.now()
      scheduleWrite()
    },
    markDelivered(key: string, platformMessageIds: readonly string[]) {
      const record = deliveries.get(key)
      if (!record) return
      record.state = 'delivered'
      record.platformMessageIds = [...platformMessageIds]
      record.updatedAt = Date.now()
      scheduleWrite()
    },
    markFailed(key: string, error: string, errorKind?: SendErrorKind) {
      const record = deliveries.get(key)
      if (!record) return
      record.state = 'failed'
      record.error = error
      if (errorKind !== undefined) record.errorKind = errorKind
      record.updatedAt = Date.now()
      scheduleWrite()
    },
    sweepRecoverable(opts: { now?: number; minAgeMs?: number } = {}): RecoverableDelivery[] {
      const now = opts.now ?? Date.now()
      const minAgeMs = opts.minAgeMs ?? abandonMinAgeMs
      if (pruneSettledDeliveries(deliveries, now, deliveryRetentionMs)) scheduleWrite()
      const result: RecoverableDelivery[] = []
      for (const [key, record] of deliveries) {
        if (record.state === 'pending' || record.state === 'attempting' || record.state === 'failed') {
          if (record.attempts >= maxAttempts && now - record.createdAt >= minAgeMs) {
            record.state = 'abandoned'
            record.updatedAt = now
            scheduleWrite()
            continue
          }
          result.push({ key, state: record.state, chatKey: record.chatKey, attempts: record.attempts, errorKind: record.errorKind })
        }
      }
      return result
    },
    async flush() {
      await flush()
    },
  }

  loadSync()
  return store
}
