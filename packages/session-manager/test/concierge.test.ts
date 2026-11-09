/**
 * Concierge suite (design §15, M19): the toolset against a fake host, the
 * birth/lazy-spawn special case, the C4 subscriber copy, and the C3 re-awaken
 * loop (guard, exactly-once in-process, at-least-once across a restart).
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  CONCIERGE_SESSION_ID,
  CONCIERGE_SECTION_NAME,
  CONCIERGE_SECTION_ORDER,
  CONCIERGE_TOOL_NAMES,
  DEFAULT_WAKE_LIMIT,
  INITIAL_WAKE_BUDGET,
  conciergeTools,
  reawakenText,
  resolveSessionRef,
  wakeBudgetReduce,
  type ConciergeToolDefinition,
  type ConciergeToolHost,
} from '../src/index.ts'
import { createMemoryManagerStore, type ManagerTask, type SessionDetail, type SessionView } from '../src/index.ts'
import { createHarness, emitEvent, runTurn, userMsg, type Harness } from './harness.ts'

const managers: Array<{ stop(): Promise<void> }> = []

async function harness(opts: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const created = createHarness(opts)
  await created.manager.start()
  managers.push(created.manager)
  return created
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.stop()
  }
})

const ENABLED = { concierge: { enable: true } }

// ---- §15.3 birth: the pre-written row ----

test('disabled by default: no concierge row, nothing spawned, global layer unchanged', async () => {
  const h = await harness({ presets: {}, tools: { definitions: [] } })

  assert.equal(h.manager['store'].getSession(CONCIERGE_SESSION_ID), undefined)
  assert.equal(h.agents.created.length, 0)
  assert.deepEqual(h.toolDefinitions.map((definition) => definition.name), ['notify_user'])
})

test('enabled: start() pre-writes exactly one row and spawns nothing', async () => {
  const h = await harness({ config: { ...ENABLED, cwd: '/tmp/root' }, presets: {} })

  const row = h.manager['store'].getSession(CONCIERGE_SESSION_ID)
  assert.notEqual(row, undefined)
  assert.equal(row!.label, 'concierge')
  assert.equal(row!.createdBy, 'manager')
  assert.equal(row!.cwd, '/tmp/root')
  assert.equal(h.agents.created.length, 0, 'the row is data only — no agent, no model resources')
})

test('an existing row wins over a later config change (restart stability)', async () => {
  const store = createMemoryManagerStore()
  const first = createHarness({ config: { concierge: { enable: true, label: 'alice' } }, presets: {}, store })
  await first.manager.start()
  await first.manager.stop()

  const second = createHarness({ config: { concierge: { enable: true, label: 'bob' } }, presets: {}, store })
  await second.manager.start()
  managers.push(second.manager)

  assert.equal(second.manager['store'].getSession(CONCIERGE_SESSION_ID)?.label, 'alice')
})

// ---- §15.3 lazy spawn + forced composition ----

test('adopt(createIfMissing:false) spawns the concierge lazily with the forced composition', async () => {
  const h = await harness({
    config: { concierge: { enable: true, agentPreset: 'concierge-preset' }, provider: 'manager-provider' },
    presets: {},
    tools: { definitions: [] },
  })
  await h.manager.adopt(CONCIERGE_SESSION_ID, 'channel:telegram:1', {
    createIfMissing: false, // the ladder forces creation anyway (§15.3)
    agentPreset: 'caller-preset', // dropped: the concierge config wins
    cwd: '/tmp/caller', // dropped: the concierge/manager ladder applies
    agentOptions: { provider: 'bridge-provider', model: 'bridge-model' }, // kept
    setup: () => {
      h.setupOrder.push('caller')
    },
  })

  // Spawned under the well-known id with the forced preset, mounted once.
  assert.equal(h.agents.created.length, 1)
  const created = h.agents.created[0]!
  assert.equal(created.sessionId, CONCIERGE_SESSION_ID)
  assert.equal(created.meta?.agentPreset, 'concierge-preset')
  assert.deepEqual(h.presetCalls.mounts, ['concierge-preset'])
  // Caller agentOptions (the bridge's provider/model) pass through.
  assert.deepEqual(created.agentOptions, { provider: 'bridge-provider', model: 'bridge-model' })

  // C1: notify_user + the 8 concierge tools on the AGENT scope, then the
  // caller setup, then exactly one preset mount. Never the global layer.
  assert.deepEqual(h.agentToolDefinitions.map((definition) => definition.name), ['notify_user', ...CONCIERGE_TOOL_NAMES])
  assert.deepEqual(h.setupOrder, [...Array.from({ length: 16 }, () => 'agent-tool'), 'caller', 'mount'])
  assert.deepEqual(h.toolDefinitions.map((definition) => definition.name), ['notify_user'])
})

test('without a concierge preset the host default ladder applies', async () => {
  const h = await harness({ config: ENABLED, presets: {} })
  await h.manager.adopt(CONCIERGE_SESSION_ID, 'x')
  assert.equal(h.agents.created[0]!.meta?.agentPreset, 'standard')
  assert.deepEqual(h.presetCalls.resolves, [undefined])
})

test('the instructions register as an agent-scoped prompt section when systemPrompt is present', async () => {
  const sections: Array<{ name: string; order: number; text: string }> = []
  const h = createHarness({ config: { concierge: { enable: true, instructions: 'Be terse.' } }, presets: {} })
  h.root.provide('systemPrompt', {
    section: (section: { name: string; order: number; text: string }) => {
      sections.push(section)
      return () => {}
    },
  } as never)
  await h.manager.start()
  managers.push(h.manager)

  await h.manager.adopt(CONCIERGE_SESSION_ID, 'x')
  assert.equal(sections.length, 1)
  assert.equal(sections[0]!.name, CONCIERGE_SECTION_NAME)
  assert.equal(sections[0]!.order, CONCIERGE_SECTION_ORDER)
  assert.equal(sections[0]!.text, 'Be terse.')
})

test('without the systemPrompt seam, composition still succeeds', async () => {
  const h = await harness({ config: ENABLED, presets: {} })
  await h.manager.adopt(CONCIERGE_SESSION_ID, 'x')
  assert.equal(h.agentToolDefinitions.length, 16)
})

// ---- §15.2 the toolset against a fake host ----

interface FakeHostCalls {
  dispatched: Array<{ sessionId: string; by: string; watch: boolean | undefined; mode?: string }>
  watched: Array<{ key: string; sessionId: string }>
  unwatched: Array<{ key: string; sessionId: string }>
  canceled: Array<{ sessionId: string; cause?: string }>
  created: Array<Record<string, unknown>>
}

function fakeHost(views: SessionView[] = []): { host: ConciergeToolHost; calls: FakeHostCalls } {
  const calls: FakeHostCalls = { dispatched: [], watched: [], unwatched: [], canceled: [], created: [] }
  const host: ConciergeToolHost = {
    list: async () => views,
    describe: async (sessionId) => {
      const view = views.find((candidate) => candidate.sessionId === sessionId)
      if (view === undefined) throw new Error(`session ${sessionId} not found`)
      return { ...view, tasks: [] } as SessionDetail
    },
    workspaces: () => [],
    create: async (opts) => {
      calls.created.push(opts)
      return { sessionId: 'worker-new', createdBy: opts.by, createdAt: 0 }
    },
    dispatch: async (opts) => {
      calls.dispatched.push({ sessionId: opts.sessionId, by: opts.by, watch: opts.watch, mode: opts.mode })
      const task: ManagerTask = {
        taskId: '41', sessionId: opts.sessionId, by: opts.by, mode: 'followup', summary: 'x', dispatchedAt: 0, state: 'queued',
      }
      return task
    },
    cancel: async (sessionId, cause) => {
      calls.canceled.push({ sessionId, cause })
    },
    watch: (key, sessionId) => {
      calls.watched.push({ key, sessionId })
    },
    unwatch: (key, sessionId) => {
      calls.unwatched.push({ key, sessionId })
    },
    subscribersOf: () => ['channel:telegram:7'],
  }
  return { host, calls }
}

function toolOf(tools: ConciergeToolDefinition[], name: string): ConciergeToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.notEqual(tool, undefined)
  return tool!
}

function view(partial: Partial<SessionView> & { sessionId: string }): SessionView {
  return {
    running: false, blank: false, updatedAt: 0, managed: true, foreign: false, watchers: 0,
    ...partial,
  } as SessionView
}

const EXEC = { agent: { id: CONCIERGE_SESSION_ID } }

test('the toolset has exactly the eight session-management tools', () => {
  const { host } = fakeHost()
  assert.deepEqual(conciergeTools(host).map((tool) => tool.name), [...CONCIERGE_TOOL_NAMES])
})

test('list_sessions passes its filters through and maps compact rows', async () => {
  const listCalls: Array<Record<string, unknown> | undefined> = []
  const { host } = fakeHost()
  const wrapped: ConciergeToolHost = {
    ...host,
    list: async (opts) => {
      listCalls.push(opts as Record<string, unknown> | undefined)
      return [view({ sessionId: 's1', label: 'docs', running: true, activeTask: { taskId: '2', sessionId: 's1', by: 'x', mode: 'followup', summary: '', dispatchedAt: 0, state: 'running' } })]
    },
  }
  const result = await toolOf(conciergeTools(wrapped), 'list_sessions').execute({ workspaceId: 'ws1', includeForeign: false }, EXEC)
  assert.deepEqual(listCalls, [{ workspaceId: 'ws1', includeForeign: false }])
  assert.equal((result as { sessions: Array<Record<string, unknown>> }).sessions.length, 1)
  assert.deepEqual(result.sessions?.[0], {
    sessionId: 's1', label: 'docs', running: true, blank: false, task: 'running', watchers: 0,
    updatedAt: new Date(0).toISOString(), managed: true, foreign: false,
  })
})

test('describe_session resolves by id, by unique label, and fails deterministically otherwise', async () => {
  const views = [view({ sessionId: 's1', label: 'docs' }), view({ sessionId: 's2', label: 'dup' }), view({ sessionId: 's3', label: 'dup' })]
  const { host } = fakeHost(views)
  const tool = toolOf(conciergeTools(host), 'describe_session')

  const byId = await tool.execute({ session: 's1' }, EXEC) as { session?: { sessionId?: string } }
  assert.equal(byId.session?.sessionId, 's1')
  const byLabel = await tool.execute({ session: 'docs' }, EXEC) as { session?: { sessionId?: string } }
  assert.equal(byLabel.session?.sessionId, 's1')
  const ambiguous = await tool.execute({ session: 'dup' }, EXEC) as { error?: string }
  assert.match(ambiguous.error!, /matches 2 sessions/)
  const missing = await tool.execute({ session: 'nope' }, EXEC) as { error?: string }
  assert.match(missing.error!, /list_sessions/)
})

test('resolveSessionRef prefers the exact id over a colliding label', async () => {
  const { host } = fakeHost([view({ sessionId: 'docs', label: 'docs' })])
  assert.deepEqual(await resolveSessionRef(host, 'docs'), { sessionId: 'docs' })
})

test('dispatch_message rejects self, empty text, and reports no-live-agent with guidance', async () => {
  const { host, calls } = fakeHost([view({ sessionId: 'worker-1' })])
  const tool = toolOf(conciergeTools(host), 'dispatch_message')

  const self = await tool.execute({ session: CONCIERGE_SESSION_ID, text: 'hi' }, EXEC) as { dispatched?: boolean; error?: string }
  assert.equal(self.dispatched, false)
  assert.match(self.error!, /your own session/)

  const empty = await tool.execute({ session: 'worker-1', text: '  ' }, EXEC) as { error?: string }
  assert.match(empty.error!, /text is required/)

  const throwing: ConciergeToolHost = {
    ...host,
    dispatch: async () => {
      throw new Error('session worker-x has no live agent; adopt or create it first')
    },
  }
  const failed = await toolOf(conciergeTools(throwing), 'dispatch_message').execute({ session: 'worker-1', text: 'go' }, EXEC) as { dispatched?: boolean; error?: string }
  assert.equal(failed.dispatched, false)
  assert.match(failed.error!, /create_session/)
  assert.equal(calls.dispatched.length, 0)
})

test('dispatch_message: by=self + watch:false + the C4 subscriber copy', async () => {
  const { host, calls } = fakeHost([view({ sessionId: 'worker-1' })])
  const tool = toolOf(conciergeTools(host), 'dispatch_message')

  const result = await tool.execute({ session: 'worker-1', text: 'fix the README' }, EXEC) as { dispatched?: boolean; taskId?: string }
  assert.equal(result.dispatched, true)
  assert.equal(result.taskId, '41')
  assert.deepEqual(calls.dispatched, [{ sessionId: 'worker-1', by: CONCIERGE_SESSION_ID, watch: false, mode: undefined }])
  // The concierge's own subscribers (chats) were copied onto the worker...
  assert.deepEqual(calls.watched, [{ key: 'channel:telegram:7', sessionId: 'worker-1' }])
  // ...and the concierge itself is never among them (C4: no orphan outbox rows).
  assert.ok(!calls.watched.some((entry) => entry.key === CONCIERGE_SESSION_ID))
})

test('dispatch_message carries manager provenance, not user or channel', async () => {
  const seen: unknown[] = []
  const { host } = fakeHost([view({ sessionId: 'worker-1' })])
  const wrapped: ConciergeToolHost = {
    ...host,
    dispatch: async (opts) => {
      seen.push(opts.message.source)
      return { taskId: '1', sessionId: opts.sessionId, by: opts.by, mode: 'followup', summary: '', dispatchedAt: 0, state: 'queued' }
    },
  }
  await toolOf(conciergeTools(wrapped), 'dispatch_message').execute({ session: 'worker-1', text: 'go' }, EXEC)
  assert.deepEqual(seen, [{ kind: 'manager', origin: 'concierge-tool' }])
})

test('create_session optionally dispatches the first instruction with the copy', async () => {
  const { host, calls } = fakeHost()
  const tool = toolOf(conciergeTools(host), 'create_session')

  const quiet = await tool.execute({ label: 'docs sync' }, EXEC) as { sessionId?: string; dispatched?: boolean }
  assert.equal(quiet.sessionId, 'worker-new')
  assert.equal(quiet.dispatched, false)
  assert.equal(calls.dispatched.length, 0)

  const busy = await tool.execute({ label: 'docs sync', cwd: '/tmp/docs', text: 'fix the header' }, EXEC) as { dispatched?: boolean }
  assert.equal(busy.dispatched, true)
  assert.deepEqual(calls.created.at(-1), { cwd: '/tmp/docs', label: 'docs sync', by: CONCIERGE_SESSION_ID })
  assert.deepEqual(calls.dispatched, [{ sessionId: 'worker-new', by: CONCIERGE_SESSION_ID, watch: false, mode: undefined }])
  assert.deepEqual(calls.watched, [{ key: 'channel:telegram:7', sessionId: 'worker-new' }])
})

test('cancel/watch/unwatch: resolve the ref and act on the copied keys', async () => {
  const { host, calls } = fakeHost([view({ sessionId: 'worker-1', label: 'docs' })])
  const tools = conciergeTools(host)

  const canceled = await toolOf(tools, 'cancel_session').execute({ session: 'docs', cause: 'stuck' }, EXEC)
  assert.deepEqual(canceled, { canceled: true })
  assert.deepEqual(calls.canceled, [{ sessionId: 'worker-1', cause: 'stuck' }])

  const watching = await toolOf(tools, 'watch_session').execute({ session: 'docs' }, EXEC)
  assert.deepEqual(watching, { watching: 1 })
  assert.deepEqual(calls.watched, [{ key: 'channel:telegram:7', sessionId: 'worker-1' }])

  const removed = await toolOf(tools, 'unwatch_session').execute({ session: 'docs' }, EXEC)
  assert.deepEqual(removed, { removed: 1 })
  assert.deepEqual(calls.unwatched, [{ key: 'channel:telegram:7', sessionId: 'worker-1' }])
})

test('every tool fails closed outside an agent context', async () => {
  const { host } = fakeHost([view({ sessionId: 'worker-1' })])
  const noExec = {}
  const dispatch = await toolOf(conciergeTools(host), 'dispatch_message').execute({ session: 'worker-1', text: 'x' }, noExec) as { error?: string }
  assert.match(dispatch.error!, /no agent context/)
  const create = await toolOf(conciergeTools(host), 'create_session').execute({}, noExec) as { error?: string }
  assert.match(create.error!, /no agent context/)
})

// ---- §15.4 the closed loop (integration, in-memory fakes) ----

async function conciergeWithWorker(h: Harness): Promise<{ concierge: ReturnType<Harness['agents']['agents']['get']> }> {
  await h.manager.adopt(CONCIERGE_SESSION_ID, 'channel:telegram:1')
  const worker = await h.manager.create({ cwd: '/tmp/w', by: 'channel:telegram:1', label: 'docs' })
  return { concierge: h.agents.agents.get(CONCIERGE_SESSION_ID) }
}

/** The wake path is fire-and-forget async; let its microtask chain settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('a worker task dispatched by the concierge re-awakens it exactly once', async () => {
  const h = await harness({ config: ENABLED, presets: {} })
  await conciergeWithWorker(h)
  const concierge = h.agents.agents.get(CONCIERGE_SESSION_ID)!
  const worker = (await h.manager.list()).find((entry) => entry.label === 'docs')!

  await h.manager.dispatch({ sessionId: worker.sessionId, message: userMsg('fix the README'), by: CONCIERGE_SESSION_ID })
  runTurn(h.root, h.agents.agents.get(worker.sessionId)!, 1, { assistantText: 'done' })
  await flush()

  // Exactly one synthetic followup reached the concierge...
  assert.equal(concierge.followed.length, 1)
  const text = (concierge.followed[0]!.content[0] as { text: string }).text
  assert.match(text, /Task #\d+ on "docs"/)
  assert.match(text, /ended: done/)
  // ...with manager provenance, and the task row is stamped.
  assert.deepEqual((concierge.followed[0]! as unknown as { source?: unknown }).source, { kind: 'manager', origin: 'concierge-wake' })
  const woken = h.manager['store'].listTasks(worker.sessionId).filter((task) => task.wokeAt !== undefined)
  assert.equal(woken.length, 1)

  // Closing the wake's own turn on the concierge session must NOT re-trigger.
  runTurn(h.root, concierge, 1, { assistantText: 'reported' })
  assert.equal(concierge.followed.length, 1)
})

test('tasks not dispatched by the concierge never wake it', async () => {
  const h = await harness({ config: ENABLED, presets: {} })
  await conciergeWithWorker(h)
  const worker = (await h.manager.list()).find((entry) => entry.label === 'docs')!

  await h.manager.dispatch({ sessionId: worker.sessionId, message: userMsg('from a chat'), by: 'channel:telegram:1' })
  runTurn(h.root, h.agents.agents.get(worker.sessionId)!, 1)

  assert.equal(h.agents.agents.get(CONCIERGE_SESSION_ID)!.followed.length, 0)
})

test('non-terminal transitions do not wake (state guard)', async () => {
  const h = await harness({ config: ENABLED, presets: {} })
  await conciergeWithWorker(h)
  const worker = (await h.manager.list()).find((entry) => entry.label === 'docs')!
  const concierge = h.agents.agents.get(CONCIERGE_SESSION_ID)!

  const task = await h.manager.dispatch({ sessionId: worker.sessionId, message: userMsg('go'), by: CONCIERGE_SESSION_ID })
  h.root.emit('manager/task', { ...task, state: 'running', turn: 1 } as never)
  h.root.emit('manager/task', { ...task, state: 'queued' } as never)
  assert.equal(concierge.followed.length, 0)
})

test('a live-process wake never spawns the concierge (skip with a warning)', async () => {
  const h = await harness({ config: ENABLED, presets: {} })
  // No adopt of the concierge: only a worker exists.
  const worker = await h.manager.create({ cwd: '/tmp/w', by: 'channel:telegram:1', label: 'docs' })

  await h.manager.dispatch({ sessionId: worker.sessionId, message: userMsg('go'), by: CONCIERGE_SESSION_ID })
  runTurn(h.root, h.agents.agents.get(worker.sessionId)!, 1)

  assert.equal(h.agents.agents.get(CONCIERGE_SESSION_ID), undefined, 'no spawn from a wake')
  const tasks = h.manager['store'].listTasks(worker.sessionId)
  assert.ok(tasks.every((task) => task.wokeAt === undefined), 'the wake was skipped, not stamped')
})

test('an error turn folds to failed and the wake carries the reason', async () => {
  const h = await harness({ config: ENABLED, presets: {} })
  await conciergeWithWorker(h)
  const workerView = (await h.manager.list()).find((entry) => entry.label === 'docs')!
  const worker = h.agents.agents.get(workerView.sessionId)!
  const concierge = h.agents.agents.get(CONCIERGE_SESSION_ID)!

  await h.manager.dispatch({ sessionId: workerView.sessionId, message: userMsg('go'), by: CONCIERGE_SESSION_ID })
  worker.status = 'running'
  emitEvent(h.root, worker, 'turn/start', { turn: 1 })
  emitEvent(h.root, worker, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } })
  worker.status = 'idle'
  h.root.emit('agent/status', { agent: worker, status: 'idle' } as never)
  await flush()

  assert.equal(concierge.followed.length, 1)
  assert.match((concierge.followed[0]!.content[0] as { text: string }).text, /ended: failed/)
})

// ---- §15.4 crash recovery (at-least-once across a restart) ----

test('restart recovery: an unwoken terminal task adopts the concierge and wakes it once', async () => {
  const store = createMemoryManagerStore()
  const first = createHarness({ config: ENABLED, presets: {}, store })
  await first.manager.start()

  // Simulate the crash window: the fold wrote the terminal task, the wake
  // never ran (no wokeAt), the process died before the followup.
  const worker = await first.manager.create({ cwd: '/tmp/w', by: 'channel:telegram:1', label: 'docs' })
  store.putTask({
    taskId: '9', sessionId: worker.sessionId, by: CONCIERGE_SESSION_ID, mode: 'followup',
    summary: 'fix the README', dispatchedAt: 1, state: 'done', reason: 'completed', endedAt: 2,
  })
  await first.manager.stop()

  const second = createHarness({ config: ENABLED, presets: {}, store })
  await second.manager.start()
  managers.push(second.manager)

  // Startup recovery spawned the concierge (the manager owns its existence)
  // and delivered exactly one wake.
  const concierge = second.agents.agents.get(CONCIERGE_SESSION_ID)
  assert.notEqual(concierge, undefined)
  assert.equal(concierge!.followed.length, 1)
  assert.match((concierge!.followed[0]!.content[0] as { text: string }).text, /Task #9 on "docs".*ended: done/)

  // A third restart (the task now stamped) wakes nobody again.
  await second.manager.stop()
  const third = createHarness({ config: ENABLED, presets: {}, store })
  await third.manager.start()
  managers.push(third.manager)
  assert.equal(third.agents.agents.get(CONCIERGE_SESSION_ID)?.followed.length ?? 0, 0)
})

test('restart recovery leaves chat-dispatched tasks alone', async () => {
  const store = createMemoryManagerStore()
  const first = createHarness({ config: ENABLED, presets: {}, store })
  await first.manager.start()
  const worker = await first.manager.create({ cwd: '/tmp/w', by: 'channel:telegram:1' })
  store.putTask({
    taskId: '7', sessionId: worker.sessionId, by: 'channel:telegram:1', mode: 'followup',
    summary: 'x', dispatchedAt: 1, state: 'done', reason: 'completed', endedAt: 2,
  })
  await first.manager.stop()

  const second = createHarness({ config: ENABLED, presets: {}, store })
  await second.manager.start()
  managers.push(second.manager)
  assert.equal(second.agents.created.length, 0, 'no concierge spawn for a chat-dispatched task')
})

test('startup recovery folds its own turn: the wake task binds to a turn and closes', async () => {
  const store = createMemoryManagerStore()
  const first = createHarness({ config: ENABLED, presets: {}, store })
  await first.manager.start()
  const worker = await first.manager.create({ cwd: '/tmp/w', by: 'channel:telegram:1', label: 'docs' })
  store.putTask({
    taskId: '9', sessionId: worker.sessionId, by: CONCIERGE_SESSION_ID, mode: 'followup',
    summary: 'fix the README', dispatchedAt: 1, state: 'done', reason: 'completed', endedAt: 2,
  })
  await first.manager.stop()

  // autoTurn: the recovery followup opens a real turn the moment it lands,
  // like dsh's driver. This only holds if the fold listeners were already up
  // when the scan ran — otherwise the wake task never leaves `queued`.
  const second = createHarness({ config: ENABLED, presets: {}, store, autoTurn: true })
  await second.manager.start()
  managers.push(second.manager)

  const concierge = second.agents.agents.get(CONCIERGE_SESSION_ID)!
  const wakeTask = second.manager['store'].listTasks(CONCIERGE_SESSION_ID)[0]!
  assert.equal(wakeTask.state, 'running', 'the recovery wake bound to a turn instead of lingering queued')
  assert.equal(wakeTask.turn, 1)

  runTurn(second.root, concierge, 1, { assistantText: 'reported' })
  const closed = second.manager['store'].listTasks(CONCIERGE_SESSION_ID)[0]!
  assert.equal(closed.state, 'done')
  assert.equal(closed.reason, 'completed')
})

test('a wake lost while the process is live is retried at the concierge\'s next idle edge', async () => {
  const h = await harness({ config: ENABLED, presets: {} })
  await conciergeWithWorker(h)
  const concierge = h.agents.agents.get(CONCIERGE_SESSION_ID)!
  const worker = (await h.manager.list()).find((entry) => entry.label === 'docs')!

  // The live twin of the crash window: terminal, concierge-dispatched,
  // unstamped — but nothing emitted, so only the sweep can find it.
  h.manager['store'].putTask({
    taskId: '42', sessionId: worker.sessionId, by: CONCIERGE_SESSION_ID, mode: 'followup',
    summary: 'fix the README', dispatchedAt: 1, state: 'done', reason: 'completed', endedAt: 2,
  })

  runTurn(h.root, concierge, 1, { assistantText: 'ok' })
  await flush()

  assert.equal(concierge.followed.length, 1)
  assert.match((concierge.followed[0]!.content[0] as { text: string }).text, /Task #42/)
})

// ---- §15.4 the loop's own brake (no crash ping-pong) ----

test('wakeBudgetReduce: progress re-arms the loop, a streak cuts the wake and warns once', () => {
  const crash = { state: 'crashed' as const, limit: 3, sessionId: 'w1' }

  const first = wakeBudgetReduce(INITIAL_WAKE_BUDGET, crash)
  assert.equal(first.action, 'wake')
  const second = wakeBudgetReduce(first.next, crash)
  assert.equal(second.action, 'wake')

  const third = wakeBudgetReduce(second.next, crash)
  assert.equal(third.action, 'cut')
  assert.equal(third.next.cut, true)
  assert.match(third.notice!, /w1/)
  assert.match(third.notice!, /resumes/)

  // Already cut: silent. A stuck loop must not spam the chat once per task.
  const fourth = wakeBudgetReduce(third.next, crash)
  assert.equal(fourth.action, 'cut')
  assert.equal(fourth.notice, undefined)

  // One success clears the streak and re-arms it.
  assert.deepEqual(
    wakeBudgetReduce(fourth.next, { state: 'done', limit: 3, sessionId: 'w1' }),
    { action: 'wake', next: INITIAL_WAKE_BUDGET },
  )
  assert.equal(wakeBudgetReduce(INITIAL_WAKE_BUDGET, { state: 'done', limit: 3, sessionId: 'w1' }).action, 'wake')

  // limit 0 is the escape hatch: the pre-brake behavior, forever.
  assert.equal(wakeBudgetReduce(third.next, { ...crash, limit: 0 }).action, 'wake')

  // A label reads better than a raw id in the notice.
  assert.match(
    (wakeBudgetReduce({ streak: 2, cut: false }, { state: 'failed', limit: 3, sessionId: 'w1', label: 'docs' }).notice) ?? '',
    /"docs"/,
  )
})

test('a session that keeps failing stops being woken after the limit, and the humans are told', async () => {
  const h = await harness({ config: ENABLED, presets: {} })
  await conciergeWithWorker(h)
  const concierge = h.agents.agents.get(CONCIERGE_SESSION_ID)!
  const worker = (await h.manager.list()).find((entry) => entry.label === 'docs')!
  const agent = h.agents.agents.get(worker.sessionId)!
  h.manager.watch('channel:telegram:1', CONCIERGE_SESSION_ID, ['notify'])

  for (let i = 0; i < 4; i++) {
    await h.manager.dispatch({ sessionId: worker.sessionId, message: userMsg('go'), by: CONCIERGE_SESSION_ID })
    runTurn(h.root, agent, i + 1, { reason: 'interrupted' })
    await flush()
  }

  // The brake engages ON the third failure, so exactly two followups land.
  assert.equal(concierge.followed.length, DEFAULT_WAKE_LIMIT - 1, 'the last task is settled without a followup')
  const notices = h.manager.pending('channel:telegram:1').filter((row) => row.text.includes('re-awakening stopped'))
  assert.equal(notices.length, 1)
  assert.match(notices[0]!.text, /"docs"/)
  // Every task is stamped, so a restart re-decides none of them.
  assert.ok(h.manager['store'].listTasks(worker.sessionId).every((task) => task.wokeAt !== undefined))
})

test('the brake is per session: one broken session never silences a healthy one', async () => {
  const h = await harness({ config: ENABLED, presets: {} })
  await conciergeWithWorker(h)
  const concierge = h.agents.agents.get(CONCIERGE_SESSION_ID)!
  const broken = (await h.manager.list()).find((entry) => entry.label === 'docs')!
  const healthy = await h.manager.create({ cwd: '/tmp/w2', by: CONCIERGE_SESSION_ID, label: 'tests' })

  for (let i = 0; i < DEFAULT_WAKE_LIMIT + 1; i++) {
    await h.manager.dispatch({ sessionId: broken.sessionId, message: userMsg('go'), by: CONCIERGE_SESSION_ID })
    runTurn(h.root, h.agents.agents.get(broken.sessionId)!, i + 1, { reason: 'interrupted' })
    await flush()
  }
  const afterBroken = concierge.followed.length

  await h.manager.dispatch({ sessionId: healthy.sessionId, message: userMsg('go'), by: CONCIERGE_SESSION_ID })
  runTurn(h.root, h.agents.agents.get(healthy.sessionId)!, 1)
  await flush()

  assert.equal(afterBroken, DEFAULT_WAKE_LIMIT - 1)
  assert.equal(concierge.followed.length, afterBroken + 1)
  assert.match((concierge.followed.at(-1)!.content[0] as { text: string }).text, /ended: done/)
})

// ---- the real manager as tool host (C4 through the real dispatch path) ----

test('the real manager serves as the tool host: dispatch + subscriber copy end to end', async () => {
  const h = await harness({ config: ENABLED, presets: {} })
  await h.manager.adopt(CONCIERGE_SESSION_ID, 'channel:telegram:1')
  const worker = await h.manager.create({ cwd: '/tmp/w', by: 'channel:telegram:1', label: 'docs' })

  // A chat is watching the concierge (the bridge's focus flow does this).
  h.manager.watch('channel:telegram:1', CONCIERGE_SESSION_ID)

  const tool = toolOf(conciergeTools(h.manager as unknown as ConciergeToolHost), 'dispatch_message')
  const result = await tool.execute({ session: 'docs', text: 'fix the README' }, EXEC) as { dispatched?: boolean }
  assert.equal(result.dispatched, true)

  assert.deepEqual(h.manager.subscribersOf(worker.sessionId), ['channel:telegram:1'])
  // And the concierge itself was not subscribed to its worker (C4).
  assert.ok(!h.manager.subscribersOf(worker.sessionId).includes(CONCIERGE_SESSION_ID))
})

// ---- M20: the full resource-management plane ----

test('tasks(): the cross-fleet task view, newest first, filtered by state and session', async () => {
  const h = await harness({ presets: {} })
  const a = await h.manager.create({ cwd: '/tmp/a', by: 'x', label: 'a' })
  const b = await h.manager.create({ cwd: '/tmp/b', by: 'x', label: 'b' })
  const agentA = h.agents.agents.get(a.sessionId)!
  const agentB = h.agents.agents.get(b.sessionId)!

  await h.manager.dispatch({ sessionId: a.sessionId, message: userMsg('one'), by: 'x' })
  runTurn(h.root, agentA, 1)
  await h.manager.dispatch({ sessionId: b.sessionId, message: userMsg('two'), by: 'x' })

  const running = h.manager.tasks({ state: ['queued'] })
  assert.equal(running.length, 1)
  assert.equal(running[0]!.sessionId, b.sessionId)

  const all = h.manager.tasks()
  assert.equal(all.length, 2)
  assert.ok(all[0]!.dispatchedAt >= all[1]!.dispatchedAt, 'newest first')
  assert.equal(h.manager.tasks({ sessionId: a.sessionId })[0]!.state, 'done')
})

test('tail(): live log tail bounded 1..100, cold sessions throw', async () => {
  const h = await harness({ presets: {} })
  const row = await h.manager.create({ cwd: '/tmp/a', by: 'x' })
  const agent = h.agents.agents.get(row.sessionId)!
  runTurn(h.root, agent, 1, { assistantText: 'hi' })

  const tail = h.manager.tail(row.sessionId, 3)
  assert.equal(tail.length, 3)
  assert.deepEqual(tail.map((event) => event.type), ['turn/start', 'assistant/message', 'turn/end'])
  assert.equal(h.manager.tail(row.sessionId, 500).length <= 100, true)

  await h.manager.disposeSession(row.sessionId)
  assert.throws(() => h.manager.tail(row.sessionId), /no live agent/)
})

test('setSessionLabel(): relabel and clear managed rows; foreign ids throw', async () => {
  const h = await harness({ presets: {} })
  const row = await h.manager.create({ cwd: '/tmp/a', by: 'x', label: 'old' })

  assert.equal(h.manager.setSessionLabel(row.sessionId, 'new').label, 'new')
  assert.equal(h.manager.setSessionLabel(row.sessionId, '').label, undefined)
  assert.throws(() => h.manager.setSessionLabel('nope', 'x'), /not managed here/)
})

test('disposeSession(): releases the owned agent, keeps the row, later adopt resumes', async () => {
  const h = await harness({ presets: {} })
  const row = await h.manager.create({ cwd: '/tmp/a', by: 'x', label: 'keep' })

  assert.equal(await h.manager.disposeSession(row.sessionId), true)
  assert.equal(h.agents.agents.get(row.sessionId), undefined, 'agent released')
  assert.notEqual(h.manager['store'].getSession(row.sessionId), undefined, 'row kept')
  assert.equal(await h.manager.disposeSession(row.sessionId), false, 'second dispose is a no-op')

  await h.manager.adopt(row.sessionId, 'x', { createIfMissing: true })
  assert.notEqual(h.agents.agents.get(row.sessionId), undefined, 'resumed on next touch')
})

test('workspace writes: create/rename/archive through the registry seam, errors without one', async () => {
  const h = await harness({ presets: {} }) // no workspaceRegistry option
  const calls: Array<{ op: string; args: unknown[] }> = []
  h.root.provide('workspaceRegistry', {
    list: () => [],
    create: async (path: string, title?: string) => {
      calls.push({ op: 'create', args: [path, title] })
      return { id: 'ws-1', title: title ?? 'proj', path }
    },
    get: (id: string) => ({
      id, title: 'old', path: '/tmp/p', setTitle: async (title: string) => {
        calls.push({ op: 'setTitle', args: [id, title] })
      },
    }),
    archiveSession: async (id: unknown) => {
      calls.push({ op: 'archive', args: [String(id)] })
    },
    unarchiveSession: async (id: unknown) => {
      calls.push({ op: 'unarchive', args: [String(id)] })
    },
  } as never)

  const created = await h.manager.createWorkspace('/tmp/proj', 'proj')
  assert.equal(created.id, 'ws-1')
  const renamed = await h.manager.renameWorkspace('ws-1', 'renamed')
  assert.equal(renamed.title, 'renamed')
  await h.manager.archiveSession('some-session', true)
  await h.manager.archiveSession('some-session', false)
  assert.deepEqual(calls.map((call) => call.op), ['create', 'setTitle', 'archive', 'unarchive'])

  const bare = await harness({ presets: {} }) // no registry at all
  await assert.rejects(() => bare.manager.createWorkspace('/tmp/x'), /no workspace registry/)
  await assert.rejects(() => bare.manager.renameWorkspace('ws-1', 't'), /no workspace/)
  await assert.rejects(() => bare.manager.archiveSession('s', true), /no workspace registry/)
})

test('the M20 tools against a fake host: filters, caps, and error shapes', async () => {
  const { host, calls } = fakeHost([view({ sessionId: 's1', label: 'docs' })])
  const tools = conciergeTools({
    ...host,
    tasks: (opts) => [
      { taskId: '1', sessionId: 's1', by: 'x', mode: 'followup', summary: 'a', dispatchedAt: 2, state: 'done', reason: 'completed', endedAt: 3 },
      { taskId: '2', sessionId: 's2', by: 'y', mode: 'followup', summary: 'b', dispatchedAt: 1, state: 'running' },
    ].filter((task) => opts?.state === undefined || opts.state.includes(task.state)),
    tail: () => [{ seq: 5, type: 'turn/end', time: 0 }],
    setSessionLabel: (sessionId, label) => {
      calls.created.push({ op: 'label', sessionId, label })
    },
    disposeSession: async () => true,
    createWorkspace: async () => ({ id: 'ws', title: 'p', sessionCount: 0 }),
    renameWorkspace: async (_workspaceId, title) => ({ id: 'ws', title, sessionCount: 0 }),
    archiveSession: async (sessionId, archived) => {
      calls.created.push({ op: 'archive', sessionId, archived })
    },
  })

  const tasks = await toolOf(tools, 'list_tasks').execute({ state: ['running'] }, EXEC) as { tasks?: Array<{ taskId: string }> }
  assert.deepEqual(tasks.tasks?.map((task) => task.taskId), ['2'])

  const tail = await toolOf(tools, 'tail_session').execute({ session: 's1', limit: 5 }, EXEC) as { events?: Array<{ type: string }> }
  assert.deepEqual(tail.events, [{ seq: 5, type: 'turn/end', at: new Date(0).toISOString() }])

  const labeled = await toolOf(tools, 'set_session_label').execute({ session: 's1', label: 'docs' }, EXEC)
  assert.deepEqual(labeled, { relabeled: true })
  assert.deepEqual(calls.created.at(-1), { op: 'label', sessionId: 's1', label: 'docs' })

  assert.deepEqual(await toolOf(tools, 'dispose_session').execute({ session: 's1' }, EXEC), { disposed: true })
  assert.deepEqual((await toolOf(tools, 'create_workspace').execute({ path: '/tmp/p', title: 'P' }, EXEC) as { workspace?: { id: string } }).workspace, { id: 'ws', title: 'p', sessionCount: 0 })
  assert.deepEqual((await toolOf(tools, 'rename_workspace').execute({ workspace: 'ws', title: 'T' }, EXEC) as { workspace?: { title: string } }).workspace?.title, 'T')
  assert.deepEqual(await toolOf(tools, 'archive_session').execute({ session: 's1' }, EXEC), { archived: true })
  assert.deepEqual(await toolOf(tools, 'archive_session').execute({ session: 's1', archived: false }, EXEC), { archived: false })
})

test('the real manager serves the M20 tools: tasks + tail + dispose end to end', async () => {
  const h = await harness({ config: ENABLED, presets: {} })
  await h.manager.adopt(CONCIERGE_SESSION_ID, 'channel:telegram:1')
  const worker = await h.manager.create({ cwd: '/tmp/w', by: 'channel:telegram:1', label: 'docs' })

  await h.manager.dispatch({ sessionId: worker.sessionId, message: userMsg('go'), by: CONCIERGE_SESSION_ID })
  runTurn(h.root, h.agents.agents.get(worker.sessionId)!, 1, { assistantText: 'done' })
  await new Promise<void>((resolve) => setImmediate(resolve))

  const tools = conciergeTools(h.manager as unknown as ConciergeToolHost)
  const done = await toolOf(tools, 'list_tasks').execute({ state: ['done'] }, EXEC) as { tasks?: Array<{ sessionId: string }> }
  assert.deepEqual(done.tasks?.map((task) => task.sessionId), [worker.sessionId], 'the worker task folded done')

  const queued = await toolOf(tools, 'list_tasks').execute({ state: ['queued'] }, EXEC) as { tasks?: Array<{ sessionId: string }> }
  assert.deepEqual(queued.tasks?.map((task) => task.sessionId), [CONCIERGE_SESSION_ID], 'the wake task sits queued on the concierge')

  const tail = await toolOf(tools, 'tail_session').execute({ session: 'docs' }, EXEC) as { events?: unknown[] }
  assert.ok((tail.events?.length ?? 0) > 0, 'label resolution reaches the live log')

  const disposed = await toolOf(tools, 'dispose_session').execute({ session: 'docs' }, EXEC) as { disposed?: boolean }
  assert.equal(disposed.disposed, true)
  assert.equal(h.agents.agents.get(worker.sessionId), undefined)
})

// ---- pure helpers ----

test('reawakenText carries id, state, reason, and the original instruction', () => {
  const task: ManagerTask = {
    taskId: '12', sessionId: 's9', by: CONCIERGE_SESSION_ID, mode: 'followup',
    summary: 'fix the README', dispatchedAt: 0, state: 'failed', reason: 'error',
  }
  const text = reawakenText(task, 'docs')
  assert.match(text, /Task #12 on "docs" \(s9\) ended: failed \(reason: error\)/)
  assert.match(text, /fix the README/)
  assert.doesNotMatch(reawakenText({ ...task, summary: '' }), /Its instruction/)
})
