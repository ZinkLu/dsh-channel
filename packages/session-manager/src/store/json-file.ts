/**
 * JSON file store: tmp+rename atomic writes, 500ms debounce — the same write
 * shape as the channel kit's `state.json`, owned by the manager because the
 * manager must not depend on any channel package (D1).
 */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  bindTableOps,
  createTableState,
  pruneAckedNotifications,
  pruneSettledTasks,
  type ManagerStore,
  type TableState,
} from '../store.js'
import type { ManagedSession, ManagerNotification, ManagerSubscription, ManagerTask } from '../types.js'

const WRITE_DEBOUNCE_MS = 500
const OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000
const TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const TASKS_KEPT_PER_SESSION = 20

interface JsonFileData {
  version: 1
  idCounter: number
  sessions: ManagedSession[]
  tasks: ManagerTask[]
  subscriptions: ManagerSubscription[]
  outbox: ManagerNotification[]
}

function emptyData(): JsonFileData {
  return { version: 1, idCounter: 0, sessions: [], tasks: [], subscriptions: [], outbox: [] }
}

function objectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeSessions(value: unknown): ManagedSession[] {
  return objectArray(value)
    .filter((row) => str(row.sessionId) !== '')
    .map((row) => ({
      sessionId: str(row.sessionId),
      ...(str(row.cwd) !== '' ? { cwd: str(row.cwd) } : {}),
      ...(str(row.workspaceId) !== '' ? { workspaceId: str(row.workspaceId) } : {}),
      ...(str(row.label) !== '' ? { label: str(row.label) } : {}),
      createdBy: str(row.createdBy),
      createdAt: num(row.createdAt, Date.now()),
      ...(num(row.adoptedAt, 0) > 0 ? { adoptedAt: num(row.adoptedAt) } : {}),
    }))
}

function normalizeTasks(value: unknown): ManagerTask[] {
  const states = new Set(['queued', 'running', 'done', 'failed', 'crashed'])
  return objectArray(value)
    .filter((row) => str(row.taskId) !== '' && str(row.sessionId) !== '' && states.has(str(row.state)))
    .map((row) => ({
      taskId: str(row.taskId),
      sessionId: str(row.sessionId),
      by: str(row.by),
      mode: row.mode === 'steer' ? ('steer' as const) : ('followup' as const),
      summary: str(row.summary),
      dispatchedAt: num(row.dispatchedAt, Date.now()),
      ...(num(row.turn, -1) >= 0 ? { turn: num(row.turn) } : {}),
      state: str(row.state) as ManagerTask['state'],
      ...(num(row.endedAt, 0) > 0 ? { endedAt: num(row.endedAt) } : {}),
      ...(str(row.reason) !== '' ? { reason: str(row.reason) } : {}),
    }))
}

function normalizeSubscriptions(value: unknown): ManagerSubscription[] {
  const kinds = new Set(['turn-end', 'approval', 'question', 'notify', 'error'])
  return objectArray(value)
    .filter((row) => str(row.subscriberKey) !== '' && str(row.sessionId) !== '')
    .map((row) => ({
      subscriberKey: str(row.subscriberKey),
      sessionId: str(row.sessionId),
      kinds: Array.isArray(row.kinds) ? row.kinds.filter((kind): kind is ManagerSubscription['kinds'][number] => kinds.has(String(kind))) : [],
    }))
}

function normalizeOutbox(value: unknown): ManagerNotification[] {
  const kinds = new Set(['turn-end', 'approval', 'question', 'notify', 'error'])
  return objectArray(value)
    .filter((row) => str(row.id) !== '' && str(row.subscriberKey) !== '' && kinds.has(str(row.kind)))
    .map((row) => ({
      id: str(row.id),
      subscriberKey: str(row.subscriberKey),
      sessionId: str(row.sessionId),
      kind: str(row.kind) as ManagerNotification['kind'],
      text: str(row.text),
      createdAt: num(row.createdAt, Date.now()),
      state: row.state === 'acked' ? ('acked' as const) : ('pending' as const),
      ...(row.deferred === true ? { deferred: true } : {}),
    }))
}

function normalize(data: Partial<JsonFileData> | null | undefined): JsonFileData {
  if (!data || typeof data !== 'object') return emptyData()
  return {
    version: 1,
    idCounter: num(data.idCounter),
    sessions: normalizeSessions(data.sessions),
    tasks: normalizeTasks(data.tasks),
    subscriptions: normalizeSubscriptions(data.subscriptions),
    outbox: normalizeOutbox(data.outbox),
  }
}

export function createJsonFileManagerStore(path: string): ManagerStore {
  const state: TableState = createTableState()
  let writeTimer: NodeJS.Timeout | undefined
  let writeChain: Promise<void> = Promise.resolve()
  let dirty = false

  const scheduleWrite = () => {
    dirty = true
    if (writeTimer !== undefined) return
    writeTimer = setTimeout(() => {
      writeTimer = undefined
      // The rejection surfaces to explicit flush()/close() callers; the
      // debounce path stays quiet (the failed snapshot is re-dirtied, so the
      // next mutation or close retries it).
      void flush().catch(() => {})
    }, WRITE_DEBOUNCE_MS)
    writeTimer.unref?.()
  }

  const snapshot = (): JsonFileData => ({
    version: 1,
    idCounter: state.currentId(),
    sessions: [...state.sessions.values()],
    tasks: [...state.tasks.values()],
    subscriptions: [...state.subscriptions.values()],
    outbox: [...state.outbox.values()],
  })

  const flush = async (): Promise<void> => {
    if (writeTimer !== undefined) {
      clearTimeout(writeTimer)
      writeTimer = undefined
    }
    if (!dirty) return
    dirty = false
    // Self-healing chain: one failed write must neither poison later flushes
    // (the chain is drained before the next write body) nor lose the snapshot
    // (a failure re-dirties, so the next flush retries it).
    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        try {
          const now = Date.now()
          pruneAckedNotifications(state, now, OUTBOX_RETENTION_MS)
          pruneSettledTasks(state, now, TASK_RETENTION_MS, TASKS_KEPT_PER_SESSION)
          await mkdir(dirname(path), { recursive: true })
          const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
          await writeFile(tmp, JSON.stringify(snapshot(), null, 2), 'utf8')
          await rename(tmp, path)
        } catch (error) {
          dirty = true
          throw error
        }
      })
    await writeChain
  }

  const loadSync = (): void => {
    try {
      const raw = readFileSync(path, 'utf8')
      const data = normalize(JSON.parse(raw))
      state.seedId(data.idCounter)
      state.loadSessions(data.sessions)
      state.loadTasks(data.tasks)
      state.loadSubscriptions(data.subscriptions)
      state.loadOutbox(data.outbox)
    } catch (error) {
      // A missing or corrupt file must not block startup: tables start empty
      // (the session log remains the source of truth; only unacked outbox rows
      // are lost, and a corrupt file is renamed aside so the next start is clean).
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        try {
          renameSync(path, `${path}.bak`)
        } catch {
          // noop
        }
      }
    }
  }

  const store = bindTableOps(state, scheduleWrite)
  loadSync()

  return {
    ...store,
    async flush() {
      await flush()
    },
    async close() {
      await flush()
    },
  }
}
