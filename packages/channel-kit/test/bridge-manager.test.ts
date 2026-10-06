/**
 * Bridge ⟷ SessionManager integration: the manager upstream (D4), the command
 * table, focus presentation, and the outbox → serial-queue → ack pipeline (D3).
 * Uses the REAL dsh-session-manager over the fake agent registry, so the fold
 * and outbox semantics under test are the shipped ones.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Channel, ChannelRegistry, type InboundMessage, type OutboundChoice, type SendErrorKind } from 'dsh-channel'
import { SessionManager, createMemoryManagerStore, type ManagerStore } from 'dsh-session-manager'
import { ChannelBridge, createMemoryStore, type BridgeConfig, type ChannelStore } from '../src/index.ts'

// ---- fakes ----

interface FakeSession {
  id: string
  header: { id: string; createdAt: number; cwd?: string; agentPreset?: string }
  events: Array<{ type: string; seq: number; time: number; data: unknown }>
  readonly seq: number
  snapshotEvents(): readonly { type: string; seq: number; time: number; data: unknown }[]
  eventAt(seq: number): { type: string; seq: number; time: number; data: unknown } | undefined
}

interface FakeAgent {
  id: string
  status: 'idle' | 'running'
  session: FakeSession
  inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] }
  followed: Array<{ text: string; source: unknown }>
  steered: Array<{ text: string; source: unknown }>
  cancels: unknown[]
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  cancel(cause: unknown): void
}

function createFakeAgent(id: string, cwd?: string): FakeAgent {
  const events: FakeSession['events'] = []
  return {
    id,
    status: 'idle',
    session: {
      id,
      header: { id, createdAt: Date.now(), ...(cwd !== undefined ? { cwd } : {}) },
      events,
      get seq() {
        return events.length
      },
      snapshotEvents: () => events,
      eventAt: (seq: number) => events[seq],
    },
    inbox: { nextTurn: [], nextStep: [] },
    followed: [],
    steered: [],
    cancels: [],
    followup(message) {
      this.followed.push({ text: textOf(message), source: message.source })
    },
    steer(message) {
      this.steered.push({ text: textOf(message), source: message.source })
    },
    cancel(cause) {
      this.cancels.push(cause)
    },
  }
}

function textOf(message: UserMessage): string {
  return (message.content as Array<{ type: string; text?: string }>).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
}

interface FakeAgents {
  agents: Map<string, FakeAgent>
  resumable: Set<string>
  service: Record<string, unknown>
}

function createFakeAgents(): FakeAgents {
  const fake: FakeAgents = { agents: new Map(), resumable: new Set(), service: {} }
  fake.service = {
    list: () => [...fake.agents.values()],
    get: (id: unknown) => fake.agents.get(String(id)),
    create: async (opts: { sessionId: string; meta?: { cwd?: string }; setup?: (agentCtx: unknown, agent: unknown) => unknown }) => {
      const id = String(opts.sessionId)
      const agent = createFakeAgent(id, opts.meta?.cwd)
      fake.agents.set(id, agent)
      if (opts.setup) await opts.setup({ get: () => undefined, on: () => () => {} }, agent)
      return { agent, dispose: async () => { fake.agents.delete(id) } }
    },
    resume: async (opts: { resumeSessionId: string; setup?: (agentCtx: unknown, agent: unknown) => unknown }) => {
      const id = String(opts.resumeSessionId)
      if (!fake.resumable.has(id)) throw new Error(`no persistence for ${id}`)
      const agent = fake.agents.get(id) ?? createFakeAgent(id, '/persisted/cwd')
      fake.agents.set(id, agent)
      if (opts.setup) await opts.setup({ get: () => undefined, on: () => () => {} }, agent)
      return { agent, dispose: async () => {} }
    },
  }
  return fake
}

class FakeChannel extends Channel {
  readonly id = 'fake'
  sent: Array<{ chatKey: string; text: string; choices?: readonly OutboundChoice[] }> = []
  failWith: { error: string; errorKind?: SendErrorKind } | undefined
  private messageSeq = 0

  async send(chatKey: string, text: string, opts?: { choices?: readonly OutboundChoice[] }): Promise<{ platformMessageId: string }> {
    if (this.failWith !== undefined) {
      const failure = new Error(this.failWith.error) as Error & { errorKind?: SendErrorKind }
      if (this.failWith.errorKind !== undefined) failure.errorKind = this.failWith.errorKind
      throw failure
    }
    this.sent.push({ chatKey, text, ...(opts?.choices !== undefined ? { choices: opts.choices } : {}) })
    return { platformMessageId: String(++this.messageSeq) }
  }
}

interface TestConfig extends BridgeConfig {}

class TestBridge extends ChannelBridge<TestConfig> {
  private readonly cfg: TestConfig
  constructor(ctx: Context, cfg: TestConfig, store: ChannelStore, channel: Channel) {
    super(ctx, channel, store)
    this.cfg = cfg
  }
  protected get config(): TestConfig {
    return this.cfg
  }
  protected async connect(): Promise<void> {
    this.ctx.emit('channel/status', this.channel.id, 'connected')
  }
  protected async disconnect(): Promise<void> {}
  protected isAllowed(): boolean {
    return true
  }
  async feedInbound(inbound: InboundMessage): Promise<void> {
    await this.handleInbound(inbound)
  }
  async focusChoice(sessionId: string, chatKey: string): Promise<'focused' | 'unavailable' | 'foreign'> {
    return this.applyFocusChoice(sessionId, chatKey)
  }
}

interface Harness {
  root: Context
  bridge: TestBridge
  channel: FakeChannel
  manager: SessionManager
  agents: FakeAgents
  channelStore: ChannelStore
  managerStore: ManagerStore
  inboundSeq: number
}

async function createBridgeHarness(opts: { managerStore?: ManagerStore; sessionQueryRecords?: Array<{ header: { id: string }; persisted?: boolean; live?: boolean }> } = {}): Promise<Harness> {
  const root = new Context()
  new ChannelRegistry(root)
  const agents = createFakeAgents()
  root.provide('agents', agents.service as never)
  if (opts.sessionQueryRecords !== undefined) {
    root.provide('sessionQuery', { listSessions: async () => opts.sessionQueryRecords } as never)
    for (const record of opts.sessionQueryRecords) {
      if (record.persisted) agents.resumable.add(record.header.id)
    }
  }

  const managerStore = opts.managerStore ?? createMemoryManagerStore()
  const manager = new SessionManager(root, {}, managerStore)
  await manager.start()

  const channel = new FakeChannel()
  root.channels.register(channel)
  const channelStore = createMemoryStore()
  const bridge = new TestBridge(
    root,
    { provider: 'deepseek-official', mergeWindowSec: 0.02, approvalTimeoutSec: 120, sessionTurnTimeoutSec: 5 },
    channelStore,
    channel,
  )
  await bridge.start()
  return { root, bridge, channel, manager, agents, channelStore, managerStore, inboundSeq: 0 }
}

let messageCounter = 0
function inbound(chatKey: string, text: string): InboundMessage {
  messageCounter += 1
  return { channel: 'fake', chatKey, senderId: '123', messageId: String(1000 + messageCounter), chatType: 'direct', text, timestamp: Date.now(), hasMedia: false }
}

function emitEvent(root: Context, agent: FakeAgent, type: string, data: unknown): void {
  const seq = agent.session.events.length
  agent.session.events.push({ type, seq, time: Date.now(), data })
  root.emit('session/event', agent.session as never, agent.session.events[seq] as never)
}

function emitStatus(root: Context, agent: FakeAgent, status: 'idle' | 'running'): void {
  agent.status = status
  root.emit('agent/status', { agent, status } as never)
}

function runTurn(root: Context, agent: FakeAgent, turn: number, opts: { assistantText?: string; reason?: string } = {}): void {
  emitStatus(root, agent, 'running')
  emitEvent(root, agent, 'turn/start', { turn })
  if (opts.assistantText !== undefined) {
    emitEvent(root, agent, 'assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: opts.assistantText }] }, stream: [] })
  }
  emitEvent(root, agent, 'turn/end', { turn, reason: { kind: opts.reason ?? 'completed' } })
  emitStatus(root, agent, 'idle')
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('condition not met within timeout')
}

async function teardown(h: Harness): Promise<void> {
  await h.bridge.stop()
  await h.manager.stop()
}

// ---- manager upstream ----

test('free text with a manager adopts the conventional session id byte-for-byte and dispatches through the manager', async () => {
  const h = await createBridgeHarness()
  try {
    await h.bridge.feedInbound(inbound('42', 'hello manager'))
    await waitFor(() => h.agents.agents.has('channel:fake:42'))
    const agent = h.agents.agents.get('channel:fake:42')!
    await waitFor(() => agent.followed.length === 1)

    // The conventional id is unchanged (D4) and now visible to the manager.
    assert.equal(agent.followed[0]!.text, 'hello manager')
    const views = await h.manager.list()
    assert.equal(views.length, 1)
    assert.equal(views[0]!.sessionId, 'channel:fake:42')
    assert.equal(views[0]!.managed, true)
    // dispatch watch:true subscribed the chat.
    assert.deepEqual(h.manager.subscribersOf('channel:fake:42'), ['channel:fake:42'])
    // The task was folded from the dispatch.
    const detail = await h.manager.describe('channel:fake:42')
    assert.equal(detail.tasks.length, 1)
    assert.equal(detail.tasks[0]!.summary, 'hello manager')

    // The focus session streams exactly like the manager-less past.
    runTurn(h.root, agent, 1, { assistantText: 'the answer' })
    await waitFor(() => h.channel.sent.some((send) => send.text === 'the answer'))
    // …and its idle-edge turn-end summary is silently acked, never double-delivered.
    await waitFor(() => h.manager.pending('').length === 0)
    assert.equal(h.channel.sent.filter((send) => send.text.includes('completed')).length, 0)
  } finally {
    await teardown(h)
  }
})

test('a running focus session steers through the manager task fold', async () => {
  const h = await createBridgeHarness()
  try {
    await h.bridge.feedInbound(inbound('42', 'first'))
    await waitFor(() => h.agents.agents.has('channel:fake:42'))
    const agent = h.agents.agents.get('channel:fake:42')!
    await waitFor(() => agent.followed.length === 1)

    emitStatus(h.root, agent, 'running')
    emitEvent(h.root, agent, 'turn/start', { turn: 1 })

    await h.bridge.feedInbound(inbound('42', 'while you are at it'))
    await waitFor(() => agent.steered.length === 1)
    assert.equal(agent.steered[0]!.text, 'while you are at it')

    const detail = await h.manager.describe('channel:fake:42')
    const steerTask = detail.tasks.find((task) => task.mode === 'steer')
    assert.ok(steerTask !== undefined)
    assert.equal(steerTask.state, 'running')
    assert.equal(steerTask.turn, 1)
  } finally {
    await teardown(h)
  }
})

// ---- commands ----

test('/ls numbers sessions and /use moves the focus pointer (bindings)', async () => {
  const h = await createBridgeHarness()
  try {
    await h.bridge.feedInbound(inbound('42', 'hello'))
    await waitFor(() => h.agents.agents.has('channel:fake:42'))
    await h.bridge.feedInbound(inbound('42', '/new'))
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('Created')))

    const created = [...h.agents.agents.keys()].find((id) => id !== 'channel:fake:42')!
    await h.bridge.feedInbound(inbound('42', '/ls'))
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('1') && send.text.includes('2')))

    // Focus moved to the new session: free text goes there, not to the old one.
    const oldAgent = h.agents.agents.get('channel:fake:42')!
    const newAgent = h.agents.agents.get(created)!
    await h.bridge.feedInbound(inbound('42', 'to the new one'))
    await waitFor(() => newAgent.followed.length === 1)
    assert.equal(oldAgent.followed.length, 1, 'the unfocused session receives nothing')
    assert.equal(h.channelStore.bindings()['42'], created)

    // /use 2 switches back by the /ls numbering (the focused session lists first).
    await h.bridge.feedInbound(inbound('42', '/use 2'))
    await waitFor(() => h.channel.sent.some((send) => send.text.startsWith('Focused #2')))
    assert.equal(h.channelStore.bindings()['42'], 'channel:fake:42')
    await h.bridge.feedInbound(inbound('42', 'back to the old one'))
    await waitFor(() => oldAgent.followed.length === 2)
  } finally {
    await teardown(h)
  }
})

test('/to dispatches one-shot without moving focus and delivers a badged turn-end summary', async () => {
  const h = await createBridgeHarness()
  try {
    await h.bridge.feedInbound(inbound('42', 'hello'))
    await waitFor(() => h.agents.agents.has('channel:fake:42'))
    const agentA = h.agents.agents.get('channel:fake:42')!
    runTurn(h.root, agentA, 1, { assistantText: 'first answer' })
    await waitFor(() => h.channel.sent.some((send) => send.text === 'first answer'))

    await h.bridge.feedInbound(inbound('42', '/new'))
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('Created')))
    const sessionB = [...h.agents.agents.keys()].find((id) => id !== 'channel:fake:42')!

    await h.bridge.feedInbound(inbound('42', '/ls'))
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('/use <n> focus')))

    // /to the OLD session by number (the focused B lists first, A is #2):
    // focus stays on B, A gets the work.
    const sentBefore = h.channel.sent.length
    const toCommand = inbound('42', '/to 2 fix the docs')
    await h.bridge.feedInbound(toCommand)
    await waitFor(() => agentA.followed.length === 2)
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('dispatched to #2')))
    assert.equal(h.channelStore.bindings()['42'], sessionB, 'focus did not move')
    // The dispatched user message is attributed to its inbound platform message (R7).
    const dispatchSource = agentA.followed[1]!.source as { messageIds?: string[]; senderId?: string }
    assert.deepEqual(dispatchSource.messageIds, [toCommand.messageId])
    assert.equal(dispatchSource.senderId, '123')

    // A finishes: the chat is watching but not focused → one BADGED summary, no stream.
    runTurn(h.root, agentA, 2, { assistantText: 'docs fixed' })
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('docs fixed') && send.text.includes('completed')))
    const summary = h.channel.sent.find((send) => send.text.includes('completed') && send.text.includes('docs fixed'))!
    assert.match(summary.text, /^\[#2 [^\]]+\] ✅ completed · docs fixed$/)
    // The unfocused session never streamed its assistant message as a final answer.
    assert.equal(h.channel.sent.slice(sentBefore).filter((send) => send.text === 'docs fixed').length, 0)
    // The notification was acked after delivery.
    await waitFor(() => h.manager.pending('').length === 0)
  } finally {
    await teardown(h)
  }
})

test('/status and /tail and /stop run against the manager', async () => {
  const h = await createBridgeHarness()
  try {
    await h.bridge.feedInbound(inbound('42', 'hello'))
    await waitFor(() => h.agents.agents.has('channel:fake:42'))
    const agent = h.agents.agents.get('channel:fake:42')!
    emitStatus(h.root, agent, 'running')
    emitEvent(h.root, agent, 'turn/start', { turn: 1 })
    emitEvent(h.root, agent, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{}' })
    emitEvent(h.root, agent, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'still working' }] }, stream: [] })

    await h.bridge.feedInbound(inbound('42', '/status'))
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('▶ running') && send.text.includes('tool: Bash')))

    await h.bridge.feedInbound(inbound('42', '/tail'))
    await waitFor(() => h.channel.sent.some((send) => send.text === 'still working'))

    await h.bridge.feedInbound(inbound('42', '/stop'))
    await waitFor(() => agent.cancels.length === 1)
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('stopped #1')))
  } finally {
    await teardown(h)
  }
})

test('/use on a foreign session confirms first and --take adopts it', async () => {
  const h = await createBridgeHarness({ sessionQueryRecords: [{ header: { id: 'tui-session-1' }, persisted: true }] })
  try {
    await h.bridge.feedInbound(inbound('42', '/ls'))
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('(foreign)')))

    await h.bridge.feedInbound(inbound('42', '/use 1'))
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('--take')))
    // Not adopted, not focused.
    assert.equal(h.channelStore.bindings()['42'], undefined)

    await h.bridge.feedInbound(inbound('42', '/use 1 --take'))
    await waitFor(() => h.channel.sent.some((send) => send.text.startsWith('Focused #1')))
    assert.equal(h.channelStore.bindings()['42'], 'tui-session-1')
    const views = await h.manager.list()
    assert.equal(views.find((view) => view.sessionId === 'tui-session-1')!.managed, true)

    // Free text now flows into the adopted session.
    const agent = h.agents.agents.get('tui-session-1')!
    await h.bridge.feedInbound(inbound('42', 'continue the refactor'))
    await waitFor(() => agent.followed.length === 1)
  } finally {
    await teardown(h)
  }
})

test('/to on a foreign session honors --take instead of looping the confirm', async () => {
  const h = await createBridgeHarness({ sessionQueryRecords: [{ header: { id: 'tui-session-1' }, persisted: true }] })
  try {
    await h.bridge.feedInbound(inbound('42', '/ls'))
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('(foreign)')))

    await h.bridge.feedInbound(inbound('42', '/to 1 fix the tests'))
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('--take')))
    assert.equal(h.agents.agents.has('tui-session-1'), false, 'not adopted without --take')

    await h.bridge.feedInbound(inbound('42', '/to 1 --take fix the tests'))
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('dispatched to #1')))
    const agent = h.agents.agents.get('tui-session-1')!
    await waitFor(() => agent.followed.length === 1)
    assert.equal(agent.followed[0]!.text, 'fix the tests')
    // One-shot semantics: focus did not move.
    assert.equal(h.channelStore.bindings()['42'], undefined)
  } finally {
    await teardown(h)
  }
})

test('/new with text attributes the first dispatch to the inbound platform message', async () => {
  const h = await createBridgeHarness()
  try {
    const command = inbound('42', '/new write the release notes')
    await h.bridge.feedInbound(command)
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('Created')))
    const agent = h.agents.agents.get(h.channelStore.bindings()['42']!)!
    await waitFor(() => agent.followed.length === 1)
    assert.equal(agent.followed[0]!.text, 'write the release notes')
    const source = agent.followed[0]!.source as { messageIds?: string[]; senderId?: string }
    assert.deepEqual(source.messageIds, [command.messageId])
    assert.equal(source.senderId, '123')
  } finally {
    await teardown(h)
  }
})

test('/unwatch is not undone by the next free-text dispatch, and /watch re-arms it', async () => {
  const h = await createBridgeHarness()
  try {
    await h.bridge.feedInbound(inbound('42', 'hello'))
    await waitFor(() => h.agents.agents.has('channel:fake:42'))
    const agent = h.agents.agents.get('channel:fake:42')!
    await waitFor(() => h.manager.subscribersOf('channel:fake:42').length === 1)

    await h.bridge.feedInbound(inbound('42', '/unwatch'))
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('Stopped watching')))
    assert.deepEqual(h.manager.subscribersOf('channel:fake:42'), [])

    // Free text still reaches the session, but must not silently re-subscribe it.
    await h.bridge.feedInbound(inbound('42', 'keep working'))
    await waitFor(() => agent.followed.length === 2)
    assert.deepEqual(h.manager.subscribersOf('channel:fake:42'), [])

    // An explicit /watch re-arms the dispatch-time subscription.
    await h.bridge.feedInbound(inbound('42', '/watch channel:fake:42'))
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('watching')))
    await h.bridge.feedInbound(inbound('42', 'and this'))
    await waitFor(() => agent.followed.length === 3)
    assert.deepEqual(h.manager.subscribersOf('channel:fake:42'), ['channel:fake:42'])
  } finally {
    await teardown(h)
  }
})

test('without a manager the historical command set is byte-identical', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  const agents = createFakeAgents()
  root.provide('agents', agents.service as never)
  const channel = new FakeChannel()
  root.channels.register(channel)
  const bridge = new TestBridge(
    root,
    { provider: 'deepseek-official', mergeWindowSec: 0.02, approvalTimeoutSec: 120 },
    createMemoryStore(),
    channel,
  )
  await bridge.start()
  try {
    await bridge.feedInbound(inbound('42', '/help'))
    await waitFor(() => channel.sent.length >= 1)
    assert.equal(channel.sent[0]!.text, 'Available commands:\n/start - Get started\n/new - New session\n/status - Session status\n/bind <sessionId> - Bind session\n/help - Help')

    await bridge.feedInbound(inbound('42', '/ls'))
    await waitFor(() => channel.sent.length >= 2)
    assert.equal(channel.sent[1]!.text, 'Unknown command: ls. Use /help for help.')

    await bridge.feedInbound(inbound('42', '/status'))
    await waitFor(() => channel.sent.length >= 3)
    assert.equal(channel.sent[2]!.text, 'Session channel:fake:42 is not running.')
  } finally {
    await bridge.stop()
  }
})

// ---- notification pipeline ----

test('notify_user text reaches a watched chat badged and is acked after delivery', async () => {
  const h = await createBridgeHarness()
  try {
    await h.bridge.feedInbound(inbound('42', 'hello'))
    await waitFor(() => h.agents.agents.has('channel:fake:42'))
    const agent = h.agents.agents.get('channel:fake:42')!
    await h.bridge.feedInbound(inbound('42', '/new'))
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('Created')))

    // The agent of the OLD session calls notify_user (when:'now').
    const delivered = await h.manager.notify('channel:fake:42', 'deploy finished')
    assert.equal(delivered, 1)
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('deploy finished')))
    const notification = h.channel.sent.find((send) => send.text.includes('deploy finished'))!
    // The new session took #1 when it was created, so the old one badges as #2.
    assert.match(notification.text, /^\[#2 [^\]]+\] deploy finished$/)
    await waitFor(() => h.manager.pending('').length === 0)
  } finally {
    await teardown(h)
  }
})

test('a crash between deliver and ack re-delivers once with the resumed-resend marker', async () => {
  const managerStore = createMemoryManagerStore()
  const first = await createBridgeHarness({ managerStore })
  const agent = createFakeAgent('channel:fake:42')
  first.agents.agents.set('channel:fake:42', agent)
  await first.manager.adopt('channel:fake:42', 'channel:fake:42')
  first.manager.watch('channel:fake:42', 'channel:fake:42')
  // The notification lands in the outbox while the bridge is already gone:
  // stopping first simulates the crash between deliver and ack.
  await first.bridge.stop()
  await first.manager.notify('channel:fake:42', 'long-running job done')
  assert.equal(first.manager.pending('').length, 1)
  await first.manager.stop()

  // Restart: same manager tables, fresh bridge — recovery must re-deliver.
  const root = new Context()
  new ChannelRegistry(root)
  const agents = createFakeAgents()
  agents.agents.set('channel:fake:42', agent)
  agents.resumable.add('channel:fake:42')
  root.provide('agents', agents.service as never)
  const manager = new SessionManager(root, {}, managerStore)
  await manager.start()
  const channel = new FakeChannel()
  root.channels.register(channel)
  const bridge = new TestBridge(
    root,
    { provider: 'deepseek-official', mergeWindowSec: 0.02, approvalTimeoutSec: 120 },
    createMemoryStore(),
    channel,
  )
  await bridge.start()
  try {
    await waitFor(() => channel.sent.some((send) => send.text.includes('long-running job done')))
    const resend = channel.sent.find((send) => send.text.includes('long-running job done'))!
    assert.ok(resend.text.startsWith('(resumed resend, may duplicate)'))
    await waitFor(() => manager.pending('').length === 0)
    // Exactly once.
    assert.equal(channel.sent.filter((send) => send.text.includes('long-running job done')).length, 1)
  } finally {
    await bridge.stop()
    await manager.stop()
  }
})

test('a forbidden notification target is acked and unwatched (dead-target cleanup, §7)', async () => {
  const h = await createBridgeHarness()
  try {
    await h.bridge.feedInbound(inbound('42', 'hello'))
    await waitFor(() => h.agents.agents.has('channel:fake:42'))
    await h.bridge.feedInbound(inbound('42', '/new'))
    await waitFor(() => h.channel.sent.some((send) => send.text.includes('Created')))
    assert.deepEqual(h.manager.subscribersOf('channel:fake:42'), ['channel:fake:42'])

    h.channel.failWith = { error: 'bot was blocked by the user', errorKind: 'forbidden' }
    await h.manager.notify('channel:fake:42', 'can you hear me')
    // The queue gives up immediately on a fatal kind → ack + unwatch.
    await waitFor(() => h.manager.subscribersOf('channel:fake:42').length === 0)
    await waitFor(() => h.manager.pending('').length === 0)
    assert.equal(h.channel.sent.filter((send) => send.text.includes('can you hear me')).length, 0)
  } finally {
    await teardown(h)
  }
})

// ---- approvals through subscribersOf ----

test('applyFocusChoice adopts, focuses, and watches the tapped session', async () => {
  const h = await createBridgeHarness({ sessionQueryRecords: [{ header: { id: 'listed-1' }, persisted: true }] })
  try {
    // The manager already knows the session (created or adopted here earlier),
    // so a tap is a re-focus, not a foreign takeover.
    await h.manager.adopt('listed-1', 'channel:fake:42')
    assert.equal(await h.bridge.focusChoice('listed-1', '42'), 'focused')
    assert.equal(h.channelStore.bindings()['42'], 'listed-1')
    assert.deepEqual(h.manager.subscribersOf('listed-1'), ['channel:fake:42'])
    assert.ok(h.agents.agents.has('listed-1'))

    // An id that is neither live nor persisted cannot be focused.
    assert.equal(await h.bridge.focusChoice('never-existed', '42'), 'unavailable')
    // The failed tap did not move the focus.
    assert.equal(h.channelStore.bindings()['42'], 'listed-1')
  } finally {
    await teardown(h)
  }
})

test('a focus tap on a foreign session refuses with the --take outcome instead of adopting', async () => {
  const h = await createBridgeHarness({ sessionQueryRecords: [{ header: { id: 'tui-session-1' }, persisted: true }] })
  try {
    assert.equal(await h.bridge.focusChoice('tui-session-1', '42'), 'foreign')
    // Not adopted, not focused, not watched.
    assert.equal(h.channelStore.bindings()['42'], undefined)
    assert.equal(h.agents.agents.has('tui-session-1'), false)
    const views = await h.manager.list()
    assert.equal(views.find((view) => view.sessionId === 'tui-session-1')!.managed, false)
    assert.deepEqual(h.manager.subscribersOf('tui-session-1'), [])

    // An explicit /use --take still adopts it.
    await h.bridge.feedInbound(inbound('42', '/use tui-session-1 --take'))
    await waitFor(() => h.channel.sent.some((send) => send.text.startsWith('Focused')))
    assert.equal(h.channelStore.bindings()['42'], 'tui-session-1')
  } finally {
    await teardown(h)
  }
})

test('an approval for a watched session reaches every subscriber chat and the first answer wins', async () => {
  const h = await createBridgeHarness()
  try {
    await h.bridge.feedInbound(inbound('42', 'hello'))
    await waitFor(() => h.agents.agents.has('channel:fake:42'))
    await waitFor(() => h.manager.subscribersOf('channel:fake:42').length === 1)
    // A second chat subscribes to the same session (e.g. via its own /watch).
    h.manager.watch('channel:fake:77', 'channel:fake:42')

    const verdict = h.root.waterfall('approval/request', { agent: { id: 'channel:fake:42' }, toolName: 'Bash', reason: 'rm -rf build' } as never, async () => 'unavailable' as const)
    await waitFor(() => h.channel.sent.filter((send) => send.text.includes('Bash')).length >= 2)
    const promptChats = h.channel.sent.filter((send) => send.text.includes('Bash')).map((send) => send.chatKey).sort()
    assert.deepEqual(promptChats, ['42', '77'])

    // The second chat answers; its reply resolves the single pending approval.
    await h.bridge.feedInbound(inbound('77', 'approve'))
    assert.equal(await verdict, 'allowed-once')
  } finally {
    await teardown(h)
  }
})
