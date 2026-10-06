import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createMemoryManagerStore } from '../src/index.ts'
import { createFakeAgent, createHarness, emitAssistantMessage, emitEvent, emitStatus, emitUserMessage, runTurn, userMsg } from './harness.ts'
import type { ManagerNotification, ManagerTask } from '../src/index.ts'

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

// ---- N2: create / adopt ----

test('create registers a managed session under a random id with cwd and preset meta', async () => {
  const h = await harness({ config: { provider: 'deepseek-official', model: 'deepseek-flash' }, presets: {} })

  const row = await h.manager.create({ cwd: '/tmp/project-a', by: 'channel:telegram:42', label: 'blog' })

  assert.match(row.sessionId, /^[0-9a-f-]{36}$/)
  assert.equal(row.cwd, '/tmp/project-a')
  assert.equal(row.createdBy, 'channel:telegram:42')
  assert.equal(row.label, 'blog')
  assert.equal(row.adoptedAt, undefined)

  const created = h.agents.created[0]!
  assert.equal(created.sessionId, row.sessionId)
  assert.equal(created.meta?.cwd, '/tmp/project-a')
  // Preset resolution: config unset → the registry default is pinned into meta.
  assert.equal(created.meta?.agentPreset, 'standard')
  assert.deepEqual(h.presetCalls.resolves, [undefined])
  // The manager owns the preset mount inside setup.
  assert.deepEqual(h.presetCalls.mounts, ['standard'])
  // agentOptions fall back to the plugin config.
  assert.deepEqual(created.agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash' })

  const [view] = await h.manager.list()
  assert.equal(view?.managed, true)
  assert.equal(view?.foreign, false)
})

test('create composes the per-agent notify tool, the caller setup, then the preset mount', async () => {
  const h = await harness({ presets: {}, tools: { definitions: [] } })

  // start() registered notify_user on the GLOBAL tool layer.
  assert.deepEqual(h.toolDefinitions.map((definition) => definition.name), ['notify_user'])

  await h.manager.create({
    cwd: '/tmp/p',
    by: 'test',
    setup: () => {
      h.setupOrder.push('caller')
    },
  })
  // Inside setup: the agent-layer notify_user fallback (V2) runs first, then
  // the caller's hook, then the preset mount the manager now owns.
  assert.deepEqual(h.setupOrder, ['agent-tool', 'caller', 'mount'])
  assert.deepEqual(h.agentToolDefinitions.map((definition) => definition.name), ['notify_user'])
})

test('adopt resumes a persisted session and reports resume failures verbatim', async () => {
  const h = await harness({ persistedStats: ['cold-1', 'cold-2'] })

  const row = await h.manager.adopt('cold-1', 'channel:telegram:42', { createIfMissing: true })
  assert.deepEqual(h.agents.resumed, ['cold-1'])
  assert.equal(row.sessionId, 'cold-1')
  assert.equal(row.cwd, '/persisted/cwd')
  assert.ok(row.adoptedAt !== undefined)

  // A real resume failure on a PERSISTED session propagates — never a silent re-create.
  h.agents.failResumeWith = new Error('session already owned by another process')
  await assert.rejects(() => h.manager.adopt('cold-2', 'x', { createIfMissing: true }), /another process/)
  assert.equal(h.agents.created.length, 0)
  h.agents.failResumeWith = undefined

  const owned = createHarness({ sessionQueryRecords: [{ header: { id: 'owned-1' }, persisted: true }] })
  await owned.manager.start()
  managers.push(owned.manager)
  owned.agents.failResumeWith = new Error('SessionAlreadyOwnedError')
  await assert.rejects(() => owned.manager.adopt('owned-1', 'x', { createIfMissing: true }), /SessionAlreadyOwnedError/)
  assert.equal(owned.agents.created.length, 0)
})

test('adopt creates under the exact id only with createIfMissing, and throws otherwise', async () => {
  const h = await harness({ persistedStats: [] })

  await assert.rejects(() => h.manager.adopt('channel:telegram:42', 'x'), /was not found/)
  assert.equal(h.agents.created.length, 0)

  const row = await h.manager.adopt('channel:telegram:42', 'x', { createIfMissing: true, cwd: '/tmp/ws' })
  assert.equal(row.sessionId, 'channel:telegram:42')
  assert.equal(h.agents.created[0]?.meta?.cwd, '/tmp/ws')

  // Idempotent: a second adopt returns the same row without re-creating.
  const again = await h.manager.adopt('channel:telegram:42', 'y', { createIfMissing: true })
  assert.equal(again.createdBy, 'x')
  assert.equal(h.agents.created.length, 1)

  // Without any probe service the resume error itself surfaces (an honest
  // failure beats a fabricated "not found").
  const blind = await harness()
  await assert.rejects(() => blind.manager.adopt('whatever', 'x'), /no persistence for whatever/)
})

test('sessionQuery is consulted before persistence, and a query hit marks foreign correctly', async () => {
  const h = await harness({
    sessionQueryRecords: [
      { header: { id: 'persisted-only', cwd: '/tmp/old', createdAt: 1000 }, persisted: true },
      { header: { id: 'live-elsewhere', cwd: '/tmp/x' }, live: true, persisted: true },
    ],
  })
  const views = await h.manager.list()
  const persistedOnly = views.find((view) => view.sessionId === 'persisted-only')
  assert.equal(persistedOnly?.foreign, true)
  assert.equal(persistedOnly?.cwd, '/tmp/old')
  assert.equal(persistedOnly?.running, false)

  await h.manager.adopt('persisted-only', 'me')
  const [after] = (await h.manager.list()).filter((view) => view.sessionId === 'persisted-only')
  assert.equal(after?.foreign, false)
  assert.equal(after?.managed, true)
})

// ---- N2: dispatch and task folding ----

test('dispatch on an idle session follows up and the task folds queued → running → done', async () => {
  const h = await harness()
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const agent = h.agents.agents.get('s1')!

  const taskEvents: ManagerTask[] = []
  h.root.on('manager/task', (task: ManagerTask) => taskEvents.push(task))

  const task = await h.manager.dispatch({ sessionId: 's1', message: userMsg('fix the merge window bug'), by: 'me' })
  assert.equal(task.state, 'queued')
  assert.equal(task.mode, 'followup')
  assert.equal(task.summary, 'fix the merge window bug')
  assert.equal(agent.followed.length, 1)

  runTurn(h.root, agent, 1, { assistantText: 'all fixed' })

  const done = taskEvents[taskEvents.length - 1]!
  assert.equal(done.taskId, task.taskId)
  assert.equal(done.state, 'done')
  assert.equal(done.reason, 'completed')
  assert.equal(done.turn, 1)
  assert.ok(done.endedAt !== undefined)
  assert.deepEqual(
    taskEvents.map((entry) => entry.state),
    ['queued', 'running', 'done'],
  )

  const detail = await h.manager.describe('s1')
  assert.equal(detail.lastAssistantText, 'all fixed')
  assert.equal(detail.tasks.length, 1)
})

test('dispatch on a running session steers and closes with the open turn', async () => {
  const h = await harness()
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const agent = h.agents.agents.get('s1')!

  const first = await h.manager.dispatch({ sessionId: 's1', message: userMsg('task one'), by: 'me' })
  emitStatus(h.root, agent, 'running')
  emitEvent(h.root, agent, 'turn/start', { turn: 1 })
  // The first task bound to turn 1.
  const bound = (await h.manager.describe('s1')).tasks.find((task) => task.taskId === first.taskId)
  assert.equal(bound?.state, 'running')

  const second = await h.manager.dispatch({ sessionId: 's1', message: userMsg('also this'), by: 'me', mode: 'auto' })
  assert.equal(second.mode, 'steer')
  assert.equal(second.state, 'running')
  assert.equal(second.turn, 1)
  assert.equal(agent.steered.length, 1)

  emitEvent(h.root, agent, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emitStatus(h.root, agent, 'idle')

  const tasks = (await h.manager.describe('s1')).tasks
  assert.equal(tasks.find((task) => task.taskId === first.taskId)?.state, 'done')
  assert.equal(tasks.find((task) => task.taskId === second.taskId)?.state, 'done')
})

test('steer dispatch to a session adopted mid-turn binds to the open turn and closes done', async () => {
  // A live agent the manager never folded (a channel-plugin restart re-adopt):
  // its log already carries turn/start with no turn/end.
  const agent = createFakeAgent('web-1', { cwd: '/tmp/p' })
  agent.status = 'running'
  agent.session.events.push({ type: 'turn/start', seq: 0, time: 1, data: { turn: 7 } })
  agent.session.events.push({ type: 'assistant/message', seq: 1, time: 2, data: { turn: 7, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } } })
  const h = await harness({ liveAgents: [agent] })

  await h.manager.adopt('web-1', 'me')
  // The lazy tracking seed also recovered the display fields from the log tail.
  assert.equal((await h.manager.describe('web-1')).lastAssistantText, 'working on it')

  const task = await h.manager.dispatch({ sessionId: 'web-1', message: userMsg('mid-turn steer'), by: 'me' })
  assert.equal(task.mode, 'steer')
  assert.equal(task.state, 'running')
  assert.equal(task.turn, 7)
  assert.equal(agent.steered.length, 1)

  emitEvent(h.root, agent, 'turn/end', { turn: 7, reason: { kind: 'completed' } })
  emitStatus(h.root, agent, 'idle')

  const stored = (await h.manager.describe('web-1')).tasks.find((entry) => entry.taskId === task.taskId)
  assert.equal(stored?.state, 'done')
  assert.equal(stored?.reason, 'completed')
})

test('adopting a settled live session shows its last turn-end reason without re-notifying it', async () => {
  const agent = createFakeAgent('web-2', { cwd: '/tmp/p' })
  agent.session.events.push({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })
  agent.session.events.push({ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  const h = await harness({ liveAgents: [agent] })

  await h.manager.adopt('web-2', 'me')
  h.manager.watch('channel:telegram:42', 'web-2')
  const seen: ManagerNotification[] = []
  h.manager.onNotification('channel:telegram:', (notification) => seen.push(notification))

  assert.equal((await h.manager.list()).find((view) => view.sessionId === 'web-2')?.lastReason, 'completed')
  // The ancient turn/end belonged to whoever ran it: the idle edge must not re-fanout it.
  emitStatus(h.root, agent, 'idle')
  assert.equal(seen.length, 0)
})

test('dispatch to a session without a live agent throws (adopt first)', async () => {
  const h = await harness()
  await assert.rejects(() => h.manager.dispatch({ sessionId: 'ghost', message: userMsg('hi'), by: 'me' }), /no live agent/)
})

test('turn/end error fails the task and pushes an error notification immediately', async () => {
  const h = await harness({ config: { defaultSubscribers: ['channel:telegram:42'] } })
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const agent = h.agents.agents.get('s1')!
  const seen: ManagerNotification[] = []
  h.manager.onNotification('channel:telegram:', (notification) => seen.push(notification))

  await h.manager.dispatch({ sessionId: 's1', message: userMsg('doomed'), by: 'me' })
  emitStatus(h.root, agent, 'running')
  emitEvent(h.root, agent, 'turn/start', { turn: 1 })
  emitEvent(h.root, agent, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'model exploded' } } })

  // The error notification does not wait for the idle edge.
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.kind, 'error')
  assert.match(seen[0]!.text, /model exploded/)
  assert.equal(seen[0]!.subscriberKey, 'channel:telegram:42')

  const tasks = (await h.manager.describe('s1')).tasks
  assert.equal(tasks[0]!.state, 'failed')
  assert.equal(tasks[0]!.reason, 'error')
  assert.equal((await h.manager.describe('s1')).lastError, 'model exploded')
})

test('turn/end interrupted marks the task crashed', async () => {
  const h = await harness()
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const agent = h.agents.agents.get('s1')!
  const task = await h.manager.dispatch({ sessionId: 's1', message: userMsg('long refactor'), by: 'me' })
  runTurn(h.root, agent, 1, { reason: 'interrupted' })
  const [stored] = (await h.manager.describe('s1')).tasks
  assert.equal(stored?.taskId, task.taskId)
  assert.equal(stored?.state, 'crashed')
})

test('cancel forwards to the live agent and is a no-op for a cold session', async () => {
  const h = await harness()
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const agent = h.agents.agents.get('s1')!
  await h.manager.cancel('s1')
  await h.manager.cancel('s1', 'user asked')
  assert.deepEqual(agent.cancels, [{ kind: 'user' }, { kind: 'hook', reason: 'user asked' }])
  await h.manager.cancel('never-existed')
})

test('queued tasks orphaned by a cancel fail at the idle edge', async () => {
  const h = await harness()
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const agent = h.agents.agents.get('s1')!
  const task = await h.manager.dispatch({ sessionId: 's1', message: userMsg('will be canceled'), by: 'me' })
  assert.equal(task.state, 'queued')
  // The inbox work was canceled away: no turn ever starts, the agent settles idle.
  emitStatus(h.root, agent, 'idle')
  const [stored] = (await h.manager.describe('s1')).tasks
  assert.equal(stored?.state, 'failed')
  assert.equal(stored?.reason, 'canceled')
})

// ---- N3: subscriptions and the outbox ----

test('the idle edge pushes exactly one turn-end summary per settling, not one per turn', async () => {
  const h = await harness()
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const agent = h.agents.agents.get('s1')!
  h.manager.watch('channel:telegram:42', 's1')

  const seen: ManagerNotification[] = []
  h.manager.onNotification('channel:telegram:42', (notification) => seen.push(notification))

  await h.manager.dispatch({ sessionId: 's1', message: userMsg('one'), by: 'me' })
  emitStatus(h.root, agent, 'running')
  emitEvent(h.root, agent, 'turn/start', { turn: 1 })
  emitAssistantMessage(h.root, agent, 'first answer', 1)
  emitEvent(h.root, agent, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  // A chained followup keeps the agent running: NO notification yet.
  emitEvent(h.root, agent, 'turn/start', { turn: 2 })
  emitAssistantMessage(h.root, agent, 'second answer', 2)
  emitEvent(h.root, agent, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal(seen.length, 0)

  emitStatus(h.root, agent, 'idle')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.kind, 'turn-end')
  assert.match(seen[0]!.text, /✅ completed · second answer/)
  assert.ok(!seen[0]!.text.includes('first answer'), 'only the last turn is summarized')

  // A later idle with no new turn/end does not repeat the notification.
  emitStatus(h.root, agent, 'idle')
  assert.equal(seen.length, 1)
})

test('dispatch watch:true subscribes to all kinds and subscribersOf filters by kind', async () => {
  const h = await harness()
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  await h.manager.dispatch({ sessionId: 's1', message: userMsg('x'), by: 'channel:telegram:42', watch: true })

  assert.deepEqual(h.manager.subscribersOf('s1'), ['channel:telegram:42'])
  assert.deepEqual(h.manager.subscribersOf('s1', 'turn-end'), ['channel:telegram:42'])
  assert.deepEqual(h.manager.subscribersOf('s1', 'approval'), ['channel:telegram:42'])
  assert.deepEqual(h.manager.subscribersOf('s2', 'notify'), [])

  h.manager.watch('channel:wechat:a', 's1', ['notify'])
  assert.deepEqual(h.manager.subscribersOf('s1', 'notify').sort(), ['channel:telegram:42', 'channel:wechat:a'])
  assert.deepEqual(h.manager.subscribersOf('s1', 'turn-end'), ['channel:telegram:42'])

  h.manager.unwatch('channel:wechat:a', 's1')
  assert.deepEqual(h.manager.subscribersOf('s1'), ['channel:telegram:42'])
  h.manager.unwatch('channel:telegram:42')
  assert.deepEqual(h.manager.subscribersOf('s1'), [])
})

test('watch disposer removes only the kinds its own call added', async () => {
  const h = await harness()
  h.manager.watch('me', 's1', ['notify'])
  const dispose = h.manager.watch('me', 's1', ['turn-end'])
  assert.deepEqual(h.manager.subscribersOf('s1', 'turn-end'), ['me'])
  assert.deepEqual(h.manager.subscribersOf('s1', 'notify'), ['me'])
  dispose()
  assert.deepEqual(h.manager.subscribersOf('s1', 'turn-end'), [])
  assert.deepEqual(h.manager.subscribersOf('s1', 'notify'), ['me'])
  dispose() // idempotent
  assert.deepEqual(h.manager.subscribersOf('s1', 'notify'), ['me'])
})

test('watch disposers are order-insensitive under non-LIFO disposal', async () => {
  const h = await harness()
  const disposeA = h.manager.watch('me', 's1', ['notify'])
  const disposeB = h.manager.watch('me', 's1', ['turn-end'])

  // Out of order: disposing the FIRST watch removes its kinds but keeps the row...
  disposeA()
  assert.deepEqual(h.manager.subscribersOf('s1', 'notify'), [])
  assert.deepEqual(h.manager.subscribersOf('s1', 'turn-end'), ['me'])
  // ...and disposing the second leaves no zombie of the first.
  disposeB()
  assert.deepEqual(h.manager.subscribersOf('s1'), [])

  // A watch whose kinds were all already present adds nothing; its disposer is a no-op.
  const first = h.manager.watch('me', 's1', ['notify'])
  const duplicate = h.manager.watch('me', 's1', ['notify'])
  duplicate()
  assert.deepEqual(h.manager.subscribersOf('s1', 'notify'), ['me'])
  first()
  assert.deepEqual(h.manager.subscribersOf('s1'), [])
})

test('notify now fans out to watchers, falls back to defaultSubscribers, and acks leave pending', async () => {
  const h = await harness({ config: { defaultSubscribers: ['channel:telegram:owner'] } })
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })

  // No watcher → the default subscriber receives it.
  const delivered = await h.manager.notify('s1', 'deploy finished')
  assert.equal(delivered, 1)
  let pending = h.manager.pending('channel:telegram:')
  assert.equal(pending.length, 1)
  assert.equal(pending[0]!.kind, 'notify')
  assert.equal(pending[0]!.text, 'deploy finished')
  assert.equal(pending[0]!.subscriberKey, 'channel:telegram:owner')

  // A watcher of its own replaces the default.
  h.manager.watch('channel:wechat:a', 's1')
  await h.manager.notify('s1', 'second')
  pending = h.manager.pending('')
  assert.equal(pending.length, 2)
  assert.equal(pending[1]!.subscriberKey, 'channel:wechat:a')

  // Prefix filtering + ack.
  assert.equal(h.manager.pending('channel:wechat:').length, 1)
  h.manager.ack(pending[1]!.id)
  assert.equal(h.manager.pending('channel:wechat:').length, 0)
  assert.equal(h.manager.pending('channel:telegram:').length, 1)
  // Unknown id ack is a no-op.
  h.manager.ack('999999')
})

test('turn-end notifications never reach defaultSubscribers (notify and error only)', async () => {
  const h = await harness({ config: { defaultSubscribers: ['channel:telegram:owner'] } })
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const agent = h.agents.agents.get('s1')!
  runTurn(h.root, agent, 1, { assistantText: 'done here' })
  assert.equal(h.manager.pending('').length, 0)
})

test('notify when:done defers to the idle edge with the outcome attached', async () => {
  const h = await harness()
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const agent = h.agents.agents.get('s1')!
  h.manager.watch('channel:telegram:42', 's1')

  const promised = await h.manager.notify('s1', 'the report is ready', { when: 'done' })
  assert.equal(promised, 1)
  assert.equal(h.manager.pending('').length, 0, 'nothing is queued before the idle edge')

  emitStatus(h.root, agent, 'running')
  emitEvent(h.root, agent, 'turn/start', { turn: 1 })
  emitEvent(h.root, agent, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(h.manager.pending('').length, 0, 'turn/end alone does not flush')

  emitStatus(h.root, agent, 'idle')
  const pending = h.manager.pending('')
  // One turn-end summary + the deferred notify.
  assert.equal(pending.length, 2)
  const deferred = pending.find((row) => row.text.includes('the report is ready'))
  assert.ok(deferred !== undefined)
  assert.match(deferred!.text, /the report is ready · completed/)
})

test('notify when:done survives a crash before the idle edge and releases exactly once after restart', async () => {
  const store = createMemoryManagerStore()
  const first = createHarness({ store })
  await first.manager.start()
  await first.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  first.manager.watch('channel:telegram:42', 's1')

  const promised = await first.manager.notify('s1', 'job finished', { when: 'done' })
  assert.equal(promised, 1, 'the snapshot count of current targets')
  // Durable but not deliverable: the row is in the outbox, hidden from pending().
  const [raw] = store.listOutbox('pending')
  assert.equal(raw?.deferred, true)
  assert.equal(first.manager.pending('').length, 0)
  // The process dies before the idle edge (the tool had already reported success).
  await first.manager.stop()

  // Second process over the same store: still not deliverable...
  const second = createHarness({ store, liveAgents: [createFakeAgent('s1', { cwd: '/tmp/p' })] })
  await second.manager.start()
  managers.push(second.manager)
  assert.equal(second.manager.pending('').length, 0)

  // ...until the session settles: the idle edge releases it, exactly once.
  const seen: ManagerNotification[] = []
  second.manager.onNotification('channel:telegram:', (notification) => seen.push(notification))
  const agent = second.agents.agents.get('s1')!
  runTurn(second.root, agent, 1, { assistantText: 'wrapped up' })

  const released = seen.filter((row) => row.kind === 'notify')
  assert.equal(released.length, 1)
  assert.equal(released[0]!.subscriberKey, 'channel:telegram:42')
  assert.match(released[0]!.text, /job finished · completed/)

  emitStatus(second.root, agent, 'idle')
  assert.equal(seen.filter((row) => row.kind === 'notify').length, 1, 'a later idle does not re-deliver')

  // An ordinary pending row now: the subscriber pulls and acks it.
  const pending = second.manager.pending('channel:telegram:')
  const row = pending.find((candidate) => candidate.text.includes('job finished'))
  assert.ok(row !== undefined)
  second.manager.ack(row!.id)
  assert.equal(second.manager.pending('channel:telegram:').filter((candidate) => candidate.text.includes('job finished')).length, 0)
})

test('onNotification only fires for the subscriber prefix and stops after its disposer', async () => {
  const h = await harness()
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  h.manager.watch('channel:telegram:42', 's1')
  h.manager.watch('channel:wechat:b', 's1')

  const telegram: string[] = []
  const dispose = h.manager.onNotification('channel:telegram:', (notification) => telegram.push(notification.text))
  await h.manager.notify('s1', 'hello')
  assert.deepEqual(telegram, ['hello'])
  dispose()
  await h.manager.notify('s1', 'again')
  assert.deepEqual(telegram, ['hello'])
})

test('manager/notification is emitted for observers', async () => {
  const h = await harness()
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  h.manager.watch('sub:1', 's1')
  const emitted: ManagerNotification[] = []
  h.root.on('manager/notification', (notification: ManagerNotification) => emitted.push(notification))
  await h.manager.notify('s1', 'observed')
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0]!.text, 'observed')
  assert.equal(emitted[0]!.state, 'pending')
})

// ---- interaction observation ----

test('approval observation records pendingInteraction and always passes through (R8)', async () => {
  const h = await harness()
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })

  let during: string | undefined
  const verdict = await h.root.waterfall('approval/request', { agent: { id: 's1' }, toolName: 'Bash' } as never, async () => {
    during = (await h.manager.describe('s1')).pendingInteraction
    return 'allowed-once' as const
  })
  assert.equal(verdict, 'allowed-once')
  assert.equal(during, 'approval')
  assert.equal((await h.manager.describe('s1')).pendingInteraction, undefined)
})

test('user-questions observation records pendingInteraction and rejections still clear it', async () => {
  const h = await harness()
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })

  await assert.rejects(
    () =>
      h.root.waterfall('user-questions/request', { agent: { id: 's1' }, questions: [] } as never, async () => {
        assert.equal((await h.manager.describe('s1')).pendingInteraction, 'question')
        throw new Error('ASK_TIMED_OUT')
      }),
    /ASK_TIMED_OUT/,
  )
  assert.equal((await h.manager.describe('s1')).pendingInteraction, undefined)
})

// ---- N1: list / describe / workspaces ----

test('list merges live agents, managed rows, and cold records with running/watchers/queued', async () => {
  const h = await harness({
    sessionQueryRecords: [{ header: { id: 'cold-1', cwd: '/tmp/cold', createdAt: 500 }, persisted: true }],
  })
  await h.manager.adopt('live-1', 'me', { createIfMissing: true, cwd: '/tmp/hot' })
  const agent = h.agents.agents.get('live-1')!
  emitUserMessage(h.root, agent, 'hello')
  agent.inbox.nextTurn.push(userMsg('waiting'))
  h.manager.watch('a', 'live-1')
  h.manager.watch('b', 'live-1')
  emitStatus(h.root, agent, 'running')

  const views = await h.manager.list()
  const live = views.find((view) => view.sessionId === 'live-1')!
  assert.equal(live.running, true)
  assert.equal(live.blank, false)
  assert.equal(live.managed, true)
  assert.equal(live.watchers, 2)
  assert.equal(live.queued, 1)

  const cold = views.find((view) => view.sessionId === 'cold-1')!
  assert.equal(cold.foreign, true)
  assert.equal(cold.running, false)
  assert.equal(cold.updatedAt, 500)

  // includeForeign:false hides the cold record.
  const managedOnly = await h.manager.list({ includeForeign: false })
  assert.equal(managedOnly.some((view) => view.sessionId === 'cold-1'), false)

  // A fresh session with no user message is blank.
  await h.manager.adopt('fresh', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const fresh = (await h.manager.list()).find((view) => view.sessionId === 'fresh')!
  assert.equal(fresh.blank, true)
})

test('list shows titles from projections and labels as the fallback title', async () => {
  const h = await harness({ projections: { s1: { title: { title: 'fix merge window' } } } })
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  await h.manager.create({ cwd: '/tmp/p', by: 'me', label: 'blog draft' })

  const views = await h.manager.list()
  assert.equal(views.find((view) => view.sessionId === 's1')?.title, 'fix merge window')
  assert.equal(views.find((view) => view.sessionId !== 's1')?.title, 'blog draft')
})

test('describe folds currentTool from unpaired tool calls (live tracking and lazy log scan)', async () => {
  const h = await harness()
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const agent = h.agents.agents.get('s1')!

  emitEvent(h.root, agent, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{}' })
  emitEvent(h.root, agent, 'tool/call', { turn: 1, step: 2, callId: 'c2', name: 'Read', arguments: '{}' })
  emitEvent(h.root, agent, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [] } })
  let detail = await h.manager.describe('s1')
  assert.equal(detail.currentTool, 'Read')

  emitEvent(h.root, agent, 'tool/result', { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'c2', content: [] } })
  detail = await h.manager.describe('s1')
  assert.equal(detail.currentTool, undefined)

  // An untracked live session (web-opened) derives the same facts lazily from its log.
  const webAgent = createFakeAgent('web-1', { cwd: '/tmp/web' })
  h.agents.agents.set('web-1', webAgent)
  emitEvent(h.root, webAgent, 'tool/call', { turn: 1, step: 1, callId: 'w1', name: 'Grep', arguments: '{}' })
  emitEvent(h.root, webAgent, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'web answer' }] }, stream: [] })
  const webDetail = await h.manager.describe('web-1')
  assert.equal(webDetail.currentTool, 'Grep')
  assert.equal(webDetail.lastAssistantText, 'web answer')
  assert.equal(webDetail.managed, false)
})

test('workspaces come from the registry when composed, else group managed cwds', async () => {
  const withRegistry = await harness({
    workspaces: [{ id: 'ws-1', path: '/tmp/p', title: 'project', sessionIds: ['a', 'b'] }],
  })
  assert.deepEqual(withRegistry.manager.workspaces(), [{ id: 'ws-1', title: 'project', path: '/tmp/p', sessionCount: 2 }])
  await withRegistry.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const [view] = await withRegistry.manager.list()
  assert.equal(view?.workspaceId, 'ws-1')

  const without = await harness()
  await without.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/blog' })
  await without.manager.adopt('s2', 'me', { createIfMissing: true, cwd: '/tmp/blog' })
  const rows = without.manager.workspaces()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.title, 'blog')
  assert.equal(rows[0]!.sessionCount, 2)
})

test('a broken sessionQuery degrades to managed + live sessions', async () => {
  const h = await harness({ sessionQueryFails: true })
  await h.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const views = await h.manager.list()
  assert.equal(views.length, 1)
  assert.equal(views[0]!.sessionId, 's1')
})

// ---- restart rebuild (R7) ----

test('restart folds open tasks: crashed without a live log, done when the log shows the turn ended', async () => {
  const store = createMemoryManagerStore()
  const first = createHarness({ store })
  await first.manager.start()

  // s1: dispatched, never even reached turn/start — the process died mid-flight.
  await first.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const openTask = await first.manager.dispatch({ sessionId: 's1', message: userMsg('mid-flight'), by: 'me' })

  // s2: the turn started (task bound and running) but the end never arrived.
  await first.manager.adopt('s2', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  const agent2 = first.agents.agents.get('s2')!
  const boundTask = await first.manager.dispatch({ sessionId: 's2', message: userMsg('actually finished'), by: 'me' })
  emitStatus(first.root, agent2, 'running')
  emitEvent(first.root, agent2, 'turn/start', { turn: 1 })
  const bound = store.getTask(boundTask.taskId)!
  assert.equal(bound.state, 'running')
  assert.equal(bound.turn, 1)
  await first.manager.stop()

  // Second process: the host resumed s2 (its repaired log carries the turn/end); s1 stays cold.
  const resurrected = createFakeAgent('s2', { cwd: '/tmp/p' })
  resurrected.session.events.push({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })
  resurrected.session.events.push({ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  const second = createHarness({ store, liveAgents: [resurrected] })
  await second.manager.start()
  managers.push(second.manager)

  const crashed = store.getTask(openTask.taskId)!
  assert.equal(crashed.state, 'crashed')
  assert.equal(crashed.reason, 'interrupted')
  const folded = store.getTask(boundTask.taskId)!
  assert.equal(folded.state, 'done')
  assert.equal(folded.reason, 'completed')
})

test('pending outbox rows survive a restart for the subscriber to pull', async () => {
  const store = createMemoryManagerStore()
  const first = createHarness({ store })
  await first.manager.start()
  await first.manager.adopt('s1', 'me', { createIfMissing: true, cwd: '/tmp/p' })
  first.manager.watch('channel:telegram:42', 's1')
  await first.manager.notify('s1', 'before the crash')
  await first.manager.stop()

  const second = createHarness({ store })
  await second.manager.start()
  managers.push(second.manager)
  const pending = second.manager.pending('channel:telegram:')
  assert.equal(pending.length, 1)
  assert.equal(pending[0]!.text, 'before the crash')
  second.manager.ack(pending[0]!.id)
  assert.equal(second.manager.pending('channel:telegram:').length, 0)
})
