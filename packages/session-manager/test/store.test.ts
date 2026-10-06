import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createJsonFileManagerStore,
  createMemoryManagerStore,
  managerDomainSpec,
  openDomainManagerStore,
  type ManagerNotification,
} from '../src/index.ts'
import type { ManagedSession, ManagerTask } from '../src/index.ts'

const session: ManagedSession = { sessionId: 's1', cwd: '/tmp/p', createdBy: 'me', createdAt: 100 }
const task: ManagerTask = { taskId: '1', sessionId: 's1', by: 'me', mode: 'followup', summary: 'do it', dispatchedAt: 200, state: 'queued' }
const notification: ManagerNotification = { id: '2', subscriberKey: 'channel:telegram:42', sessionId: 's1', kind: 'notify', text: 'hello', createdAt: 300, state: 'pending' }

function seed(store: ReturnType<typeof createMemoryManagerStore>) {
  store.putSession(session)
  store.putTask(task)
  store.putSubscription({ subscriberKey: 'channel:telegram:42', sessionId: 's1', kinds: ['notify', 'turn-end'] })
  store.putNotification(notification)
}

test('memory store round-trips all four tables and filters', () => {
  const store = createMemoryManagerStore()
  seed(store)

  assert.deepEqual(store.getSession('s1'), session)
  assert.equal(store.listSessions().length, 1)
  assert.deepEqual(store.getTask('1'), task)
  assert.equal(store.listTasks('s1').length, 1)
  assert.equal(store.listTasks('other').length, 0)
  assert.equal(store.listSubscriptions().length, 1)
  assert.deepEqual(store.listOutbox('pending'), [notification])
  assert.deepEqual(store.listOutbox('acked'), [])

  store.deleteSubscription('channel:telegram:42', 's1')
  assert.equal(store.listSubscriptions().length, 0)
  store.deleteSession('s1')
  store.deleteTask('1')
  store.deleteNotification('2')
  assert.equal(store.listSessions().length, 0)
  assert.equal(store.listTasks().length, 0)
  assert.equal(store.listOutbox().length, 0)
})

test('ids are monotonic strings from one shared sequence', () => {
  const store = createMemoryManagerStore()
  const ids = [store.nextId(), store.nextId(), store.nextId()]
  assert.deepEqual(ids, ['1', '2', '3'])
})

test('json file store persists rows and reloads them byte-for-byte', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-manager-store-'))
  const path = join(dir, 'nested', 'state.json')

  const first = createJsonFileManagerStore(path)
  seed(first)
  const id = first.nextId()
  await first.flush()

  const raw = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(Number(raw.idCounter), Number(id))

  const second = createJsonFileManagerStore(path)
  assert.deepEqual(second.getSession('s1'), session)
  assert.deepEqual(second.getTask('1'), task)
  assert.deepEqual(second.listSubscriptions(), [{ subscriberKey: 'channel:telegram:42', sessionId: 's1', kinds: ['notify', 'turn-end'] }])
  assert.deepEqual(second.listOutbox('pending'), [notification])
  // The id sequence continues where the file left off.
  assert.ok(Number(second.nextId()) > Number(id))
  await second.close()
})

test('json file store survives a corrupt file by renaming it aside', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-manager-store-'))
  const path = join(dir, 'state.json')
  await writeFile(path, '{{{ not json', 'utf8')

  const store = createJsonFileManagerStore(path)
  assert.deepEqual(store.listSessions(), [])
  store.putSession(session)
  await store.flush()

  const backup = await readFile(`${path}.bak`, 'utf8')
  assert.equal(backup, '{{{ not json')
  const fresh = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(fresh.sessions.length, 1)
})

test('json file store recovers a failed write on the next flush instead of stalling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-manager-store-'))
  const path = join(dir, 'state.json')
  const store = createJsonFileManagerStore(path)
  // Block the atomic rename: a non-empty directory sits where the state file
  // belongs (created after open so load does not rename it aside as corrupt).
  await mkdir(path)
  await writeFile(join(path, 'blocker'), 'x', 'utf8')

  store.putSession(session)
  await assert.rejects(() => store.flush())

  // Clearing the blockage alone must be enough: the failed snapshot was
  // re-dirtied, so this flush retries it with no new mutation.
  await rm(path, { recursive: true })
  await store.flush()
  const raw = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(raw.sessions.length, 1)

  // And later flushes keep working off the healed write chain.
  store.putTask(task)
  await store.flush()
  const after = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(after.tasks.length, 1)
  await store.close()
})

test('json file store normalizes junk rows away and keeps valid ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-manager-store-'))
  const path = join(dir, 'state.json')
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      idCounter: 'junk',
      sessions: [{ sessionId: 'ok', createdBy: 'me', createdAt: 1 }, { nonsense: true }, 'string'],
      tasks: [{ taskId: 't1', sessionId: 'ok', state: 'done', mode: 'steer', by: 'me', summary: '', dispatchedAt: 2 }, { taskId: 't2', sessionId: 'ok', state: 'bogus' }],
      subscriptions: [{ subscriberKey: 'a', sessionId: 'ok', kinds: ['notify', 'bogus'] }],
      outbox: [{ id: 'n1', subscriberKey: 'a', sessionId: 'ok', kind: 'notify', text: 'x', createdAt: 3, state: 'weird' }],
    }),
    'utf8',
  )

  const store = createJsonFileManagerStore(path)
  assert.equal(store.listSessions().length, 1)
  const tasks = store.listTasks()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.mode, 'steer')
  assert.deepEqual(store.listSubscriptions(), [{ subscriberKey: 'a', sessionId: 'ok', kinds: ['notify'] }])
  // An unknown state normalizes to pending (the conservative reading: deliver it).
  assert.deepEqual(store.listOutbox('pending').map((row) => row.id), ['n1'])
})

test('domain store adapter writes through to the facility tables', async () => {
  const tables: Record<string, Map<string, unknown>> = {}
  const globals: unknown[] = []
  const store = await openDomainManagerStore({
    async open() {
      const table = (name: string) => {
        const rows = (tables[name] ??= new Map<string, unknown>())
        return {
          get: (key: string) => rows.get(key),
          entries: () => rows.entries(),
          keys: () => rows.keys(),
          get size() {
            return rows.size
          },
          put: async (key: string, value: unknown) => {
            rows.set(key, value)
          },
          delete: async (key: string) => rows.delete(key),
        }
      }
      return {
        name: 'session-manager',
        global: {
          get: () => globals[globals.length - 1] ?? { idCounter: 0 },
          set: async (value: unknown) => {
            globals.push(value)
          },
        },
        table,
        close: async () => {},
      }
    },
  })
  assert.ok(store !== undefined)

  seed(store)
  const minted = store.nextId()
  assert.equal(minted, '1')
  await store.flush()
  // Give the fire-and-forget write chain a tick to land.
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.deepEqual(tables.sessions!.get('s1'), session)
  assert.deepEqual(tables.tasks!.get('1'), task)
  assert.equal(tables.subscriptions!.size, 1)
  assert.deepEqual(tables.outbox!.get('2'), notification)
  assert.deepEqual(globals[globals.length - 1], { idCounter: 1 })

  // Reopening over the same tables reloads every row and continues the id sequence.
  const facility = {
    async open() {
      const table = (name: string) => {
        const rows = tables[name]!
        return {
          get: (key: string) => rows.get(key),
          entries: () => rows.entries(),
          keys: () => rows.keys(),
          get size() {
            return rows.size
          },
          put: async (key: string, value: unknown) => {
            rows.set(key, value)
          },
          delete: async (key: string) => rows.delete(key),
        }
      }
      return {
        name: 'session-manager',
        global: {
          get: () => globals[globals.length - 1] ?? { idCounter: 0 },
          set: async (value: unknown) => {
            globals.push(value)
          },
        },
        table,
        close: async () => {},
      }
    },
  }
  const reopened = await openDomainManagerStore(facility)
  assert.deepEqual(reopened!.getSession('s1'), session)
  // The reopened counter continues past every id the rows already hold: the
  // persisted counter says 1, but the seeded notification row holds id '2'.
  assert.equal(reopened!.nextId(), '3')
})

test('domain store seeds the id counter from the loaded rows (the stale-counter crash window)', async () => {
  // The crash landed after the row puts but before the fire-and-forget counter
  // write: the persisted counter (2) lags the ids already minted (7, 9).
  const tables: Record<string, Map<string, unknown>> = {
    tasks: new Map([['7', { ...task, taskId: '7', state: 'queued' }]]),
    outbox: new Map([['9', { ...notification, id: '9' }]]),
  }
  const globals: unknown[] = [{ idCounter: 2 }]

  const store = await openDomainManagerStore(fakeDomainFacility(tables, globals))
  assert.ok(store !== undefined)
  // nextId must continue past every id already in the tables, never re-mint one.
  assert.equal(store.nextId(), '10')
  assert.equal(store.getTask('7')?.state, 'queued')
  assert.deepEqual(store.listOutbox('pending').map((row) => row.id), ['9'])
})

test('domain store adapter degrades to undefined on a missing or failing facility', async () => {
  assert.equal(await openDomainManagerStore(undefined), undefined)
  assert.equal(await openDomainManagerStore({ open: async () => { throw new Error('no backend') } }), undefined)
  // A facility whose domain shape is wrong also degrades instead of throwing.
  assert.equal(await openDomainManagerStore({ open: async () => ({ name: 'x' }) as never }), undefined)
})

/** A minimal in-memory DomainFacility over the given tables/globals (pre-seeded by the caller). */
function fakeDomainFacility(tables: Record<string, Map<string, unknown>>, globals: unknown[]) {
  return {
    async open() {
      const table = (name: string) => {
        const rows = (tables[name] ??= new Map<string, unknown>())
        return {
          get: (key: string) => rows.get(key),
          entries: () => rows.entries(),
          keys: () => rows.keys(),
          get size() {
            return rows.size
          },
          put: async (key: string, value: unknown) => {
            rows.set(key, value)
          },
          delete: async (key: string) => rows.delete(key),
        }
      }
      return {
        name: 'session-manager',
        global: {
          get: () => globals[globals.length - 1] ?? { idCounter: 0 },
          set: async (value: unknown) => {
            globals.push(value)
          },
        },
        table,
        close: async () => {},
      }
    },
  }
}

test('the domain spec declares the four tables and version 1', () => {
  const spec = managerDomainSpec()
  assert.equal(spec.name, 'session-manager')
  assert.equal(spec.version, 1)
  assert.deepEqual(Object.keys(spec.tables).sort(), ['outbox', 'sessions', 'subscriptions', 'tasks'])
})
