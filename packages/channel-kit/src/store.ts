export type DeliveryState = 'pending' | 'attempting' | 'delivered' | 'failed' | 'abandoned'

export interface DeliveryRecord {
  state: DeliveryState
  chatKey: string
  textHash: string
  attempts: number
  platformMessageIds?: readonly string[]
  error?: string
  createdAt: number
  updatedAt: number
}

export interface RecoverableDelivery {
  key: string
  state: 'pending' | 'attempting' | 'failed'
  chatKey: string
}

export interface ChannelStore {
  // 入站去重（环形上限）
  seenInbound(messageId: string): boolean
  markInbound(messageId: string): void
  // merge 崩溃恢复
  setMergeBuffer(chatKey: string, buffer: readonly string[]): void
  mergeBuffers(): Readonly<Record<string, readonly string[]>>
  // 显式绑定（/bind 例外路径）
  setBinding(chatKey: string, sessionId: string | undefined): void
  bindings(): Readonly<Record<string, string>>
  // 出站 ledger
  recordDelivery(key: string, out: { chatKey: string; textHash: string }): void
  markAttempting(key: string): void
  markDelivered(key: string, platformMessageIds: readonly string[]): void
  markFailed(key: string, error: string): void
  /** 启动时回收：pending=直接重投；attempting/failed=重投但带"恢复重发"标记；超限→abandoned */
  sweepRecoverable(): Array<RecoverableDelivery>
  flush(): Promise<void>
}

export interface MemoryStoreOptions {
  /** seen 环上限；默认 1000 */
  seenLimit?: number
  /** 环裁剪时保留的条数；默认 500 */
  seenTrimTo?: number
  /** delivery 最大尝试次数；超过 sweep 时转 abandoned */
  maxAttempts?: number
}

/** 单测与无持久化场景用的内存实现。纯数据操作 + 显式 flush。 */
export function createMemoryStore(opts: MemoryStoreOptions = {}): ChannelStore {
  const seenLimit = opts.seenLimit ?? 1000
  const seenTrimTo = opts.seenTrimTo ?? 500
  const maxAttempts = opts.maxAttempts ?? 3

  const seen = new Set<string>()
  const seenOrder: string[] = []
  const mergeBuffers = new Map<string, string[]>()
  const bindings = new Map<string, string>()
  const deliveries = new Map<string, DeliveryRecord>()

  const trimSeen = () => {
    while (seenOrder.length > seenLimit) {
      const removed = seenOrder.splice(0, seenOrder.length - seenTrimTo)
      for (const id of removed) seen.delete(id)
    }
  }

  return {
    seenInbound(messageId: string) {
      return seen.has(messageId)
    },
    markInbound(messageId: string) {
      if (seen.has(messageId)) return
      seen.add(messageId)
      seenOrder.push(messageId)
      trimSeen()
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
    markFailed(key: string, error: string) {
      const record = deliveries.get(key)
      if (!record) return
      record.state = 'failed'
      record.error = error
      record.updatedAt = Date.now()
    },
    sweepRecoverable() {
      const result: RecoverableDelivery[] = []
      for (const [key, record] of deliveries) {
        if (record.state === 'pending' || record.state === 'attempting' || record.state === 'failed') {
          if (record.attempts >= maxAttempts) {
            record.state = 'abandoned'
            record.updatedAt = Date.now()
            continue
          }
          result.push({ key, state: record.state, chatKey: record.chatKey })
        }
      }
      return result
    },
    async flush() {},
  }
}
