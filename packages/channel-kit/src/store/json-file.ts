import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChannelStore, DeliveryRecord, RecoverableDelivery } from '../store.js'

const WRITE_DEBOUNCE_MS = 500

interface JsonFileData {
  version: 1
  seenInbound: string[]
  mergeBuffers: Record<string, string[]>
  bindings: Record<string, string>
  deliveries: Record<string, DeliveryRecord>
}

function emptyData(): JsonFileData {
  return { version: 1, seenInbound: [], mergeBuffers: {}, bindings: {}, deliveries: {} }
}

function normalize(data: Partial<JsonFileData> | null | undefined): JsonFileData {
  if (!data || typeof data !== 'object') return emptyData()
  return {
    version: 1,
    seenInbound: Array.isArray(data.seenInbound) ? data.seenInbound.filter((x): x is string => typeof x === 'string') : [],
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
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
    }
  }
  return result
}

/**
 * JSON 文件实现：tmp+rename 原子写，500ms 防抖。
 * 包内唯一碰文件系统的文件；接口保持纯数据操作 + 显式 flush。
 */
export function createJsonFileStore(path: string): ChannelStore {
  const seenLimit = 1000
  const seenTrimTo = 500
  const maxAttempts = 3

  const seen = new Set<string>()
  const seenOrder: string[] = []
  const mergeBuffers = new Map<string, string[]>()
  const bindings = new Map<string, string>()
  const deliveries = new Map<string, DeliveryRecord>()

  let writeTimer: NodeJS.Timeout | undefined
  let writeChain: Promise<void> = Promise.resolve()
  let dirty = false

  const trimSeen = () => {
    while (seenOrder.length > seenLimit) {
      const removed = seenOrder.splice(0, seenOrder.length - seenTrimTo)
      for (const id of removed) seen.delete(id)
    }
  }

  const scheduleWrite = () => {
    dirty = true
    if (writeTimer !== undefined) return
    writeTimer = setTimeout(() => {
      writeTimer = undefined
      void flush()
    }, WRITE_DEBOUNCE_MS)
    // 不让计时器拖住 Node 进程退出。
    writeTimer.unref?.()
  }

  const loadSync = (): void => {
    try {
      const raw = readFileSync(path, 'utf8')
      const data = normalize(JSON.parse(raw))
      for (const id of data.seenInbound) {
        if (!seen.has(id)) {
          seen.add(id)
          seenOrder.push(id)
        }
      }
      trimSeen()
      for (const [k, v] of Object.entries(data.mergeBuffers)) mergeBuffers.set(k, [...v])
      for (const [k, v] of Object.entries(data.bindings)) bindings.set(k, v)
      for (const [k, v] of Object.entries(data.deliveries)) deliveries.set(k, { ...v })
    } catch (error) {
      // 文件不存在或损坏都不阻塞渠道：ledger/seen 从头开始，日志折叠兜底。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // 损坏文件改名为 .bak，避免每次启动都失败。
        try { renameSync(path, `${path}.bak`) } catch { /* noop */ }
      }
    }
  }

  const snapshot = (): JsonFileData => ({
    version: 1,
    seenInbound: [...seenOrder],
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
    markInbound(messageId: string) {
      if (seen.has(messageId)) return
      seen.add(messageId)
      seenOrder.push(messageId)
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
    markFailed(key: string, error: string) {
      const record = deliveries.get(key)
      if (!record) return
      record.state = 'failed'
      record.error = error
      record.updatedAt = Date.now()
      scheduleWrite()
    },
    sweepRecoverable(): RecoverableDelivery[] {
      const result: RecoverableDelivery[] = []
      for (const [key, record] of deliveries) {
        if (record.state === 'pending' || record.state === 'attempting' || record.state === 'failed') {
          if (record.attempts >= maxAttempts) {
            record.state = 'abandoned'
            record.updatedAt = Date.now()
            scheduleWrite()
            continue
          }
          result.push({ key, state: record.state, chatKey: record.chatKey })
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
