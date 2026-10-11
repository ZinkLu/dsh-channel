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
  conciergeTools,
  reawakenText,
  resolveSessionRef,
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
  assert.deepEqual(h.setupOrder, [...Array.from({ length: 9 }, () => 'agent-tool'), 'caller', 'mount'])
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
  assert.equal(h.agentToolDefinitions.length, 9)
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
