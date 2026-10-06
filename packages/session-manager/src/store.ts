/**
 * The manager's four durable tables (sessions / tasks / subscriptions / outbox)
 * plus its id counter, behind one small synchronous-read interface.
 *
 * Three implementations: `createMemoryManagerStore` (tests), the JSON file
 * store (default; tmp+rename atomic writes mirroring the channel kit's state
 * file), and the `ctx.storageDomain` adapter (`store/domain.ts`) used when the
 * host composes the storage-domain form. The tables are small — a whole-file
 * rewrite per debounced flush is the intended write shape.
 *
 * Persistence discipline (R7): these tables are a handoff cache, never the
 * source of truth. Task state re-folds from the session log on restart; the
 * outbox is the one table whose `pending` rows carry real semantics (at-least-
 * once notification delivery).
 */
import type { ManagedSession, ManagerNotification, ManagerSubscription, ManagerTask } from './types.js'

export interface ManagerStore {
  // ---- sessions ----
  listSessions(): ManagedSession[]
  getSession(sessionId: string): ManagedSession | undefined
  putSession(session: ManagedSession): void
  deleteSession(sessionId: string): void

  // ---- tasks (key = taskId) ----
  listTasks(sessionId?: string): ManagerTask[]
  getTask(taskId: string): ManagerTask | undefined
  putTask(task: ManagerTask): void
  deleteTask(taskId: string): void

  // ---- subscriptions (key = subscriberKey + sessionId) ----
  listSubscriptions(): ManagerSubscription[]
  putSubscription(subscription: ManagerSubscription): void
  deleteSubscription(subscriberKey: string, sessionId?: string): void

  // ---- outbox (key = notification id) ----
  listOutbox(state?: 'pending' | 'acked'): ManagerNotification[]
  putNotification(notification: ManagerNotification): void
  deleteNotification(id: string): void

  /** Monotonic store-wide id (tasks and notifications share the sequence). */
  nextId(): string

  flush(): Promise<void>
  /** Release the medium (domain close / final flush). Idempotent. */
  close(): Promise<void>
}

/** Shared in-memory table logic; the file/domain stores reuse it and add durability. */
export function createTableState() {
  const sessions = new Map<string, ManagedSession>()
  const tasks = new Map<string, ManagerTask>()
  const subscriptions = new Map<string, ManagerSubscription>()
  const outbox = new Map<string, ManagerNotification>()
  let idCounter = 0

  const subscriptionKey = (subscriberKey: string, sessionId: string) => `${subscriberKey}\u0000${sessionId}`

  return {
    sessions,
    tasks,
    subscriptions,
    outbox,
    subscriptionKey,
    seedId(value: number) {
      if (Number.isSafeInteger(value) && value > idCounter) idCounter = value
    },
    /** High-water mark of the id sequence (for durable snapshots). */
    currentId(): number {
      return idCounter
    },
    nextId(): string {
      idCounter += 1
      return String(idCounter)
    },
    loadSessions(rows: readonly ManagedSession[]) {
      for (const row of rows) sessions.set(row.sessionId, row)
    },
    loadTasks(rows: readonly ManagerTask[]) {
      for (const row of rows) tasks.set(row.taskId, row)
    },
    loadSubscriptions(rows: readonly ManagerSubscription[]) {
      for (const row of rows) subscriptions.set(subscriptionKey(row.subscriberKey, row.sessionId), row)
    },
    loadOutbox(rows: readonly ManagerNotification[]) {
      for (const row of rows) outbox.set(row.id, row)
    },
  }
}

export type TableState = ReturnType<typeof createTableState>

/** The store operations over the shared table state (persistence hooked via `onChange`). */
export function bindTableOps(state: TableState, onChange: () => void): ManagerStore {
  return {
    listSessions() {
      return [...state.sessions.values()]
    },
    getSession(sessionId) {
      return state.sessions.get(sessionId)
    },
    putSession(session) {
      state.sessions.set(session.sessionId, session)
      onChange()
    },
    deleteSession(sessionId) {
      if (state.sessions.delete(sessionId)) onChange()
    },
    listTasks(sessionId) {
      const rows = [...state.tasks.values()]
      return sessionId === undefined ? rows : rows.filter((task) => task.sessionId === sessionId)
    },
    getTask(taskId) {
      return state.tasks.get(taskId)
    },
    putTask(task) {
      state.tasks.set(task.taskId, task)
      onChange()
    },
    deleteTask(taskId) {
      if (state.tasks.delete(taskId)) onChange()
    },
    listSubscriptions() {
      return [...state.subscriptions.values()]
    },
    putSubscription(subscription) {
      state.subscriptions.set(state.subscriptionKey(subscription.subscriberKey, subscription.sessionId), subscription)
      onChange()
    },
    deleteSubscription(subscriberKey, sessionId) {
      let changed = false
      for (const [key, row] of state.subscriptions) {
        if (row.subscriberKey !== subscriberKey) continue
        if (sessionId !== undefined && row.sessionId !== sessionId) continue
        state.subscriptions.delete(key)
        changed = true
      }
      if (changed) onChange()
    },
    listOutbox(outboxState) {
      const rows = [...state.outbox.values()]
      return outboxState === undefined ? rows : rows.filter((row) => row.state === outboxState)
    },
    putNotification(notification) {
      state.outbox.set(notification.id, notification)
      onChange()
    },
    deleteNotification(id) {
      if (state.outbox.delete(id)) onChange()
    },
    nextId() {
      const id = state.nextId()
      onChange()
      return id
    },
    async flush() {},
    async close() {},
  }
}

/** In-memory store for tests and non-persistent hosts. */
export function createMemoryManagerStore(): ManagerStore {
  return bindTableOps(createTableState(), () => {})
}

/** Drop `acked` outbox rows older than the retention window (the outbox is a handoff log, not an archive). */
export function pruneAckedNotifications(state: TableState, now: number, retentionMs: number): boolean {
  let pruned = false
  for (const [id, row] of state.outbox) {
    if (row.state !== 'acked') continue
    if (now - row.createdAt < retentionMs) continue
    state.outbox.delete(id)
    pruned = true
  }
  return pruned
}

/** Drop terminal tasks older than the retention window, keeping every session's newest few. */
export function pruneSettledTasks(state: TableState, now: number, retentionMs: number, keepPerSession: number): boolean {
  let pruned = false
  const bySession = new Map<string, ManagerTask[]>()
  for (const task of state.tasks.values()) {
    const list = bySession.get(task.sessionId) ?? []
    list.push(task)
    bySession.set(task.sessionId, list)
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => b.dispatchedAt - a.dispatchedAt)
    for (const task of list.slice(keepPerSession)) {
      if (task.state === 'queued' || task.state === 'running') continue
      if (now - task.dispatchedAt < retentionMs) continue
      state.tasks.delete(task.taskId)
      pruned = true
    }
  }
  return pruned
}
