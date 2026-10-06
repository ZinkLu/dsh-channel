/**
 * Optional `ctx.storageDomain` adapter: the same four tables as a declared
 * domain (`session-manager`, version 1), sharing the host's `$DSH_HOME/storages`
 * composition. dsh-storage-domain is NOT a dependency — the facility is
 * duck-typed through `ctx.get('storageDomain')`, and any absence or failure
 * degrades to `undefined` so the caller falls back to the JSON file store.
 *
 * Record schemas use schemastery (the dsh ecosystem's zod-compatible schema
 * lib — dsh-storage-domain itself declares its specs with it), kept lenient so
 * rows written by an older manager still load.
 *
 * Read model: the domain's KvTable reads are synchronous over its in-memory
 * state, but to keep one code path with the file store this adapter mirrors
 * rows into the shared TableState at open and fire-and-forgets each mutation
 * onto the domain's write chain (a rejected durable write is surfaced through
 * the caller's `onWriteError` hook, never thrown into a synchronous mutation).
 */
import Schema from '@deepseek-ai/schemastery'
import { bindTableOps, createTableState, type ManagerStore, type TableState } from '../store.js'
import type { ManagedSession, ManagerNotification, ManagerSubscription, ManagerTask } from '../types.js'

/** Duck type of dsh-storage-domain's KvTable (0.2). */
interface KvTableLike {
  get(key: string): unknown
  entries(): IterableIterator<[string, unknown]>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
}

/** Duck type of dsh-storage-domain's Domain handle (0.2). */
interface DomainLike {
  readonly name: string
  readonly global: { get(): unknown; set(value: unknown): Promise<void> }
  table(name: string): KvTableLike
  close(): Promise<void>
}

/** Duck type of dsh-storage-domain's DomainFacility (`ctx.storageDomain`). */
export interface DomainFacilityLike {
  open(spec: unknown): Promise<DomainLike>
}

export const MANAGER_DOMAIN_NAME = 'session-manager'

const sessionSchema = Schema.object({
  sessionId: Schema.string(),
  cwd: Schema.string(),
  workspaceId: Schema.string(),
  label: Schema.string(),
  createdBy: Schema.string().default(''),
  createdAt: Schema.number().default(0),
  adoptedAt: Schema.number(),
})

const taskSchema = Schema.object({
  taskId: Schema.string(),
  sessionId: Schema.string(),
  by: Schema.string().default(''),
  mode: Schema.string().default('followup'),
  summary: Schema.string().default(''),
  dispatchedAt: Schema.number().default(0),
  turn: Schema.number(),
  state: Schema.string().default('queued'),
  endedAt: Schema.number(),
  reason: Schema.string(),
})

const subscriptionSchema = Schema.object({
  subscriberKey: Schema.string(),
  sessionId: Schema.string(),
  kinds: Schema.array(Schema.string()).default([]),
})

const notificationSchema = Schema.object({
  id: Schema.string(),
  subscriberKey: Schema.string(),
  sessionId: Schema.string().default(''),
  kind: Schema.string().default('notify'),
  text: Schema.string().default(''),
  createdAt: Schema.number().default(0),
  state: Schema.string().default('pending'),
  deferred: Schema.boolean(),
})

const globalSchema = Schema.object({
  idCounter: Schema.number().default(0),
})

/** The declared domain spec, built without importing dsh-storage-domain. */
export function managerDomainSpec() {
  return {
    name: MANAGER_DOMAIN_NAME,
    version: 1,
    global: { schema: globalSchema as never, initial: { idCounter: 0 } },
    tables: {
      sessions: { valueSchema: sessionSchema as never },
      tasks: { valueSchema: taskSchema as never },
      subscriptions: { valueSchema: subscriptionSchema as never },
      outbox: { valueSchema: notificationSchema as never },
    },
  }
}

export interface DomainStoreOptions {
  /** Sink for durable-write rejections (logged, never thrown into a sync mutation). */
  onWriteError?: (message: string) => void
}

/**
 * Open the manager domain on the given facility and adapt it to ManagerStore.
 * Returns undefined when the facility is absent or anything about its shape
 * fails — the caller then falls back to the JSON file store.
 */
export async function openDomainManagerStore(facility: DomainFacilityLike | undefined, opts: DomainStoreOptions = {}): Promise<ManagerStore | undefined> {
  if (facility === undefined || typeof facility.open !== 'function') return undefined
  let domain: DomainLike
  try {
    domain = await facility.open(managerDomainSpec())
  } catch {
    return undefined
  }
  try {
    const tables = {
      sessions: domain.table('sessions'),
      tasks: domain.table('tasks'),
      subscriptions: domain.table('subscriptions'),
      outbox: domain.table('outbox'),
    }
    const state: TableState = createTableState()

    const taskRows = [...tables.tasks.entries()].map(([, row]) => row as ManagerTask)
    const outboxRows = [...tables.outbox.entries()].map(([, row]) => row as ManagerNotification)
    const globalValue = domain.global.get() as { idCounter?: number } | undefined
    // The persisted counter can lag the tables: its write is fire-and-forget
    // and unordered with row puts, so a crash can reopen with a stale value.
    // Seed from the rows too — nextId must never re-mint an id a task or
    // outbox row already holds (that would silently overwrite the row).
    state.seedId(Number(globalValue?.idCounter ?? 0))
    state.seedId(maxNumericId([...taskRows.map((row) => row.taskId), ...outboxRows.map((row) => row.id)]))
    state.loadSessions([...tables.sessions.entries()].map(([, row]) => row as ManagedSession))
    state.loadTasks(taskRows)
    state.loadSubscriptions([...tables.subscriptions.entries()].map(([, row]) => row as ManagerSubscription))
    state.loadOutbox(outboxRows)

    const fail = (what: string) => (error: unknown) => {
      opts.onWriteError?.(`storage-domain write failed (${what}): ${error instanceof Error ? error.message : String(error)}`)
    }
    let idMirror = state.currentId()
    const persistCounter = () => {
      if (state.currentId() === idMirror) return
      idMirror = state.currentId()
      void domain.global.set({ idCounter: idMirror }).catch(fail('idCounter'))
    }

    const base = bindTableOps(state, () => {})
    const store: ManagerStore = {
      ...base,
      putSession(session) {
        base.putSession(session)
        void tables.sessions.put(session.sessionId, { ...session }).catch(fail('sessions'))
      },
      deleteSession(sessionId) {
        base.deleteSession(sessionId)
        void tables.sessions.delete(sessionId).catch(fail('sessions'))
      },
      putTask(task) {
        base.putTask(task)
        void tables.tasks.put(task.taskId, { ...task }).catch(fail('tasks'))
      },
      deleteTask(taskId) {
        base.deleteTask(taskId)
        void tables.tasks.delete(taskId).catch(fail('tasks'))
      },
      putSubscription(subscription) {
        base.putSubscription(subscription)
        const key = `${subscription.subscriberKey}\u0000${subscription.sessionId}`
        void tables.subscriptions.put(key, { ...subscription, kinds: [...subscription.kinds] }).catch(fail('subscriptions'))
      },
      deleteSubscription(subscriberKey, sessionId) {
        const doomed = base
          .listSubscriptions()
          .filter((row) => row.subscriberKey === subscriberKey && (sessionId === undefined || row.sessionId === sessionId))
        base.deleteSubscription(subscriberKey, sessionId)
        for (const row of doomed) {
          void tables.subscriptions.delete(`${row.subscriberKey}\u0000${row.sessionId}`).catch(fail('subscriptions'))
        }
      },
      putNotification(notification) {
        base.putNotification(notification)
        void tables.outbox.put(notification.id, { ...notification }).catch(fail('outbox'))
      },
      deleteNotification(id) {
        base.deleteNotification(id)
        void tables.outbox.delete(id).catch(fail('outbox'))
      },
      nextId() {
        const id = base.nextId()
        persistCounter()
        return id
      },
      async flush() {
        // The domain owns durability on its write chain; nothing to debounce here.
      },
      async close() {
        await domain.close()
      },
    }
    return store
  } catch {
    try {
      await domain.close()
    } catch {
      // noop
    }
    return undefined
  }
}

/** Highest safe-integer id among the minted ids found in the loaded rows (0 when none parse). */
function maxNumericId(ids: readonly string[]): number {
  let max = 0
  for (const id of ids) {
    const value = Number(id)
    if (Number.isSafeInteger(value) && value > max) max = value
  }
  return max
}
