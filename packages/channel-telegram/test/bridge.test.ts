import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ChannelRegistry, type InboundMessage } from 'dsh-channel'
import { createMemoryStore, hashText } from 'dsh-channel-kit'
import { TelegramBridge } from '../src/bridge.ts'
import { TelegramChannel } from '../src/channel.ts'
import type { TelegramClient, TelegramUpdate } from '../src/client.ts'
import { messageText } from '../src/client.ts'

interface RecordedUserMessage {
  text: string
  source: any
}

function createFakeClient(updates: TelegramUpdate[]): TelegramClient & {
  sends: Array<{ chatId: string; text: string }>
  edits: Array<{ chatId: string; messageId: number; text: string }>
  deletes: number[]
  reactions: Array<{ chatId: string; messageId: number; emoji: string }>
  calls: number
} {
  const sends: Array<{ chatId: string; text: string }> = []
  const edits: Array<{ chatId: string; messageId: number; text: string }> = []
  const deletes: number[] = []
  const reactions: Array<{ chatId: string; messageId: number; emoji: string }> = []
  let calls = 0
  return {
    sends,
    edits,
    deletes,
    reactions,
    calls: 0,
    async getMe(): Promise<{ id: number; username?: string }> {
      return { id: 777, username: 'test_bot' }
    },
    async getUpdates(_token: string, opts: { signal?: AbortSignal } = {}): Promise<TelegramUpdate[]> {
      calls++
      if (calls === 1) return updates
      // Subsequent long polls hang until abort exits.
      return new Promise<TelegramUpdate[]>((resolve, reject) => {
        const onAbort = () => {
          opts.signal?.removeEventListener('abort', onAbort)
          resolve([])
        }
        if (opts.signal?.aborted) {
          resolve([])
          return
        }
        opts.signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    async sendMessage(_token: string, chatId: string, text: string): Promise<{ message_id: number }> {
      sends.push({ chatId, text })
      return { message_id: sends.length }
    },
    async sendChatAction(): Promise<boolean> {
      return true
    },
    async answerCallbackQuery(): Promise<boolean> {
      return true
    },
    async setMessageReaction(_token: string, chatId: string, messageId: number, emoji: string): Promise<boolean> {
      reactions.push({ chatId, messageId, emoji })
      return true
    },
    async editMessageText(_token: string, chatId: string, messageId: number, text: string): Promise<{ message_id: number }> {
      edits.push({ chatId, messageId, text })
      return { message_id: messageId }
    },
    async deleteMessage(_token: string, _chatId: string, messageId: number): Promise<boolean> {
      deletes.push(messageId)
      return true
    },
  } as unknown as TelegramClient & {
    sends: Array<{ chatId: string; text: string }>
    edits: Array<{ chatId: string; messageId: number; text: string }>
    deletes: number[]
    reactions: Array<{ chatId: string; messageId: number; emoji: string }>
    calls: number
  }
}

test('bridge ingests, routes, merges, and dispatches to agent', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  const followed: RecordedUserMessage[] = []
  const steered: RecordedUserMessage[] = []
  const fakeAgent = {
    id: 'channel:telegram:42',
    status: 'idle' as const,
    session: { events: [] as any[] },
    followup(message: any) {
      followed.push({ text: messageTextFromContent(message), source: message.source })
    },
    steer(message: any) {
      steered.push({ text: messageTextFromContent(message), source: message.source })
    },
  }

  root.provide('agents', {
    list: () => [],
    get: () => undefined,
    resume: async () => {
      throw new Error('no persistence')
    },
    create: async () => ({
      agent: fakeAgent,
      dispose: async () => {},
    }),
  })
  root.provide('credentials', {
    resolve: async () => ({ value: 'test-token', source: 'test' }),
  })

  const updates: TelegramUpdate[] = [
    {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 123, is_bot: false, first_name: 'Alice' },
        chat: { id: 42, type: 'private' },
        date: 1_700_000_000,
        text: 'hello',
      },
    },
  ]
  const client = createFakeClient(updates)
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
    client,
  )

  const emitted: any[] = []
  root.on('channel/message', (msg) => { emitted.push(msg) })

  await bridge.start()
  await waitFor(() => followed.length === 1)
  await bridge.stop()

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].messageId, '100')
  assert.equal(followed.length, 1)
  assert.deepEqual(followed[0]!.text, 'hello')
  assert.equal(followed[0]!.source.kind, 'channel')
  assert.equal(followed[0]!.source.channel, 'telegram')
  assert.deepEqual(followed[0]!.source.messageIds, ['100'])
})

test('bridge rejects non-allowlisted sender with a local reply', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  root.provide('agents', { list: () => [], get: () => undefined, resume: async () => { throw new Error('no persistence') }, create: async () => { throw new Error('should not create') } })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const updates: TelegramUpdate[] = [
    {
      update_id: 5,
      message: {
        message_id: 200,
        from: { id: 999, is_bot: false, first_name: 'Mallory' },
        chat: { id: 42, type: 'private' },
        date: 1_700_000_000,
        text: 'hi',
      },
    },
  ]
  const client = createFakeClient(updates)
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
    client,
  )

  await bridge.start()
  await waitFor(() => client.sends.length >= 1)
  await bridge.stop()

  assert.ok(client.sends.some((send) => send.text.includes('You are not authorized to use this bot.')))
})

function messageTextFromContent(message: any): string {
  return message.content?.map((block: any) => block.text ?? '').join('\n') ?? ''
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('condition not met within timeout')
}

test('approval answerer defers to next for non-owned agents and times out for owned agents', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  root.provide('agents', {
    list: () => [],
    get: () => undefined,
    resume: async () => { throw new Error('no persistence') },
    create: async () => { throw new Error('not used') },
  })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const store = createMemoryStore()
  store.setBinding('42', 'channel:telegram:42')

  const client = createFakeClient([])
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)

  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 0.05 }),
    store,
    channel,
    client,
  )
  await bridge.start()

  const foreign = await root.waterfall('approval/request', { agent: { id: 'foreign' }, toolName: 'Bash' }, async () => 'unavailable')
  assert.equal(foreign, 'unavailable')

  const own = await root.waterfall('approval/request', { agent: { id: 'channel:telegram:42' }, toolName: 'Bash' }, async () => 'unavailable')
  assert.equal(own, 'unavailable')

  await bridge.stop()
})

test('bridge escapes HTML specials in approval prompts before HTML delivery', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  root.provide('agents', {
    list: () => [],
    get: () => undefined,
    resume: async () => { throw new Error('no persistence') },
    create: async () => { throw new Error('not used') },
  })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const store = createMemoryStore()
  store.setBinding('42', 'channel:telegram:42')

  const client = createFakeClient([])
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)

  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 0.05 }),
    store,
    channel,
    client,
  )
  await bridge.start()

  await root.waterfall(
    'approval/request',
    { agent: { id: 'channel:telegram:42' }, toolName: 'Bash', reason: 'run <script> && exit 1 > /dev/null' },
    async () => 'unavailable',
  )

  await waitFor(() => client.sends.length >= 1)
  await bridge.stop()

  const sent = client.sends.map((send) => send.text).join('\n')
  assert.ok(sent.includes('Bash'))
  assert.ok(sent.includes('&lt;script&gt;'), `expected escaped reason, got: ${JSON.stringify(sent)}`)
  assert.ok(!sent.includes('<script>'))
})

test('bridge strips leaked <tool_calls> markup before delivering assistant text', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  const sessionId = 'channel:telegram:42'
  const fakeAgent = { id: sessionId, status: 'idle' as const, session: { events: [] as any[] } }
  root.provide('agents', {
    list: () => [],
    get: () => fakeAgent,
    resume: async () => { throw new Error('not used') },
    create: async () => { throw new Error('not used') },
  })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const store = createMemoryStore()
  store.setBinding('42', sessionId)

  const client = createFakeClient([])
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)

  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 }),
    store,
    channel,
    client,
  )
  await bridge.start()

  root.emit('session/event', { id: sessionId }, {
    type: 'assistant/message',
    seq: 1,
    time: Date.now(),
    data: {
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Sorry, the result may not have displayed correctly just now. Let me check again:\n<tool_calls>\n<invoke name="Bash">\n<parameter name="command" string="true">date</parameter>\n</invoke>\n</tool_calls>',
          },
        ],
      },
    },
  })

  await waitFor(() => client.sends.length >= 1)
  await bridge.stop()

  const sent = client.sends.map((send) => send.text).join('\n')
  assert.ok(sent.includes('Sorry'))
  assert.ok(!sent.includes('<tool_calls>'))
  assert.ok(!sent.includes('<invoke'))
  assert.ok(!sent.includes('<parameter'))
  assert.ok(!sent.includes('date'))
})

test('bridge joins the host default agent preset when creating an agent', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  const resolveCalls: Array<string | undefined> = []
  const mountCalls: Array<string | undefined> = []
  const metaPresets: Array<string | undefined> = []

  const fakeAgentCtx = {
    get: (name: string) => (name === 'agentPresets' ? presetsFake : undefined),
    on: () => () => {},
  }
  root.provide('agents', {
    list: () => [],
    get: () => undefined,
    resume: async () => { throw new Error('no persistence') },
    create: async (opts: any) => {
      metaPresets.push(opts.meta?.agentPreset)
      // The factory writes meta.agentPreset into the durable session header;
      // setup then mounts the preset recorded there.
      const fakeAgent = {
        id: 'channel:telegram:42',
        status: 'idle' as const,
        session: { events: [] as any[], header: { agentPreset: opts.meta?.agentPreset } },
        followup() {},
        steer() {},
      }
      if (opts.setup) await opts.setup(fakeAgentCtx, fakeAgent)
      return { agent: fakeAgent, dispose: async () => {} }
    },
  })
  const presetsFake = {
    resolve: async (id?: string) => {
      resolveCalls.push(id)
      return { id: 'standard' }
    },
    mount: async (_agentCtx: any, id?: string) => {
      mountCalls.push(id)
    },
  }
  root.provide('agentPresets', presetsFake)
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const updates: TelegramUpdate[] = [
    {
      update_id: 7,
      message: {
        message_id: 300,
        from: { id: 123, is_bot: false, first_name: 'Alice' },
        chat: { id: 42, type: 'private' },
        date: 1_700_000_000,
        text: 'hello',
      },
    },
  ]
  const client = createFakeClient(updates)
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
    client,
  )

  await bridge.start()
  await waitFor(() => mountCalls.length >= 1)
  await bridge.stop()

  // config.agentPreset unset → resolve receives undefined → use the host default preset.
  assert.deepEqual(resolveCalls, [undefined])
  // The preset id lands in the session header (meta.agentPreset) so resume can rebuild capabilities.
  assert.deepEqual(metaPresets, ['standard'])
  // The preset was actually mounted in setup.
  assert.deepEqual(mountCalls, ['standard'])
})

test('bridge shows a progress draft for tool calls and finalizes it on the answer', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  const sessionId = 'channel:telegram:42'
  const fakeAgent = { id: sessionId, status: 'idle' as const, session: { events: [] as any[] } }
  root.provide('agents', { list: () => [], get: () => fakeAgent, resume: async () => { throw new Error('not used') }, create: async () => { throw new Error('not used') } })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const store = createMemoryStore()
  store.setBinding('42', sessionId)
  const client = createFakeClient([])
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 }),
    store,
    channel,
    client,
  )
  await bridge.start()

  root.emit('session/event', { id: sessionId }, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
  root.emit('session/event', { id: sessionId }, { type: 'tool/call', seq: 2, time: Date.now(), data: { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{"command":"npm test"}' } })

  // Gated 1500ms: the draft is only created when the timer fires.
  await waitFor(() => client.sends.some((s) => s.text.includes('Working…')), 2500)
  assert.ok(client.sends.some((s) => s.text.includes('🛠️ Bash')))

  root.emit('session/event', { id: sessionId }, { type: 'tool/result', seq: 3, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [] } } })
  await waitFor(() => client.edits.length >= 1, 2000)

  root.emit('session/event', { id: sessionId }, { type: 'assistant/message', seq: 4, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } })
  await waitFor(() => client.sends.some((s) => s.text === 'done'), 2000)
  await waitFor(() => client.deletes.length >= 1, 2000)

  await bridge.stop()
})

test('bridge retains the preview instead of deleting it when edit-in-place died', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  const sessionId = 'channel:telegram:42'
  const fakeAgent = { id: sessionId, status: 'idle' as const, session: { events: [] as any[] } }
  root.provide('agents', { list: () => [], get: () => fakeAgent, resume: async () => { throw new Error('not used') }, create: async () => { throw new Error('not used') } })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const store = createMemoryStore()
  store.setBinding('42', sessionId)
  const client = createFakeClient([])
  // Edit-in-place is dead: the preview holds the prefix the user already saw.
  client.editMessageText = async () => { throw new Error('message is not modified') }
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 }),
    store,
    channel,
    client,
  )
  await bridge.start()

  root.emit('session/event', { id: sessionId }, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
  root.emit('session/event', { id: sessionId }, { type: 'tool/call', seq: 2, time: Date.now(), data: { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{"command":"npm test"}' } })
  await waitFor(() => client.sends.some((s) => s.text.includes('Working…')), 2500)

  // The follow-up draft update fails, flipping the reducer to append-tail mode.
  root.emit('session/event', { id: sessionId }, { type: 'tool/result', seq: 3, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [] } } })
  await waitFor(() => client.sends.some((s) => s.text.includes('✅ Bash')), 3000)

  root.emit('session/event', { id: sessionId }, { type: 'assistant/message', seq: 4, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } })
  await waitFor(() => client.sends.some((s) => s.text === 'done'), 2000)
  await bridge.stop()

  assert.deepEqual(client.deletes, [], 'the retained preview must not be deleted')
})

test('bridge answers the user-questions waterfall and renders an option prompt', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  const sessionId = 'channel:telegram:42'

  let answerer: ((request: any, next: () => Promise<any>) => Promise<any>) | null = null
  const fakeAgentCtx = {
    get: () => undefined,
    on: (event: string, handler: any) => {
      if (event === 'user-questions/request') answerer = handler
      return () => {}
    },
  }
  const fakeAgent = { id: sessionId, status: 'idle' as const, session: { events: [] as any[] }, followup() {}, steer() {} }

  root.provide('agents', {
    list: () => [],
    get: () => undefined,
    resume: async () => { throw new Error('no persistence') },
    create: async (opts: any) => {
      if (opts.setup) await opts.setup(fakeAgentCtx, fakeAgent)
      return { agent: fakeAgent, dispose: async () => {} }
    },
  })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const updates: TelegramUpdate[] = [
    { update_id: 1, message: { message_id: 100, from: { id: 123, is_bot: false, first_name: 'Alice' }, chat: { id: 42, type: 'private' }, date: 1_700_000_000, text: 'hello' } },
  ]
  const client = createFakeClient(updates)
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
    client,
  )
  await bridge.start()
  await waitFor(() => answerer !== null, 2000)

  // Agent created → answerer registered on the agent scope; the request renders the option prompt.
  const answerPromise = answerer!(
    { questions: [{ id: 'q1', question: 'pick <a> or <b>', options: [{ label: 'A' }, { label: 'B' }] }], agent: { id: sessionId } },
    async () => { throw new Error('the bridge owns this agent and must not delegate') },
  )
  // bridge.stop() rejects the pending question; the test never answers it.
  answerPromise.catch(() => {})
  await waitFor(() => client.sends.some((s) => s.text.includes('pick')), 2000)

  // Text reply "2" → parsed to the prompt → returns selected ['B'].
  // Going through a second getUpdates batch is too roundabout; here we just assert rendering completed; reply parsing is covered by kit unit tests + resolvePrompt.
  assert.ok(client.sends.some((s) => s.text.includes('pick')))
  // Question text is LLM-generated and must be HTML-escaped before HTML delivery.
  assert.ok(client.sends.some((s) => s.text.includes('&lt;a&gt; or &lt;b&gt;')))
  assert.ok(!client.sends.some((s) => s.text.includes('<a> or <b>')))
  await bridge.stop()
})

test('bridge ingests media facts and downloads an inbound photo into an image block', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  const followed: Array<{ content: any[] }> = []
  const fakeAgent = {
    id: 'channel:telegram:42',
    status: 'idle' as const,
    session: { events: [] as any[] },
    followup(message: any) {
      followed.push({ content: message.content })
    },
    steer(message: any) {
      followed.push({ content: message.content })
    },
  }

  root.provide('agents', {
    list: () => [],
    get: () => undefined,
    resume: async () => { throw new Error('no persistence') },
    create: async () => ({ agent: fakeAgent, dispose: async () => {} }),
  })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })
  root.provide('attachments', {
    async saveImage(input: { data: Uint8Array; mediaType: string }) {
      assert.equal(input.mediaType, 'image/jpeg')
      assert.deepEqual([...input.data], [0xff, 0xd8, 0xff])
      return { attachmentId: 'att-1', mediaType: 'image/jpeg', bytes: 3, width: 1, height: 1 }
    },
  })

  const updates: TelegramUpdate[] = [
    {
      update_id: 1,
      message: {
        message_id: 900,
        from: { id: 123, is_bot: false, first_name: 'Alice' },
        chat: { id: 42, type: 'private' },
        date: 1_700_000_000,
        caption: 'look at this',
        photo: [{ file_id: 'photo_big', file_unique_id: 'u1', width: 10, height: 10, file_size: 99 }],
      },
    },
  ]

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff])
  const client = createFakeClient(updates)
  ;(client as any).getFile = async () => ({ bytes: jpeg, filePath: 'photos/1.jpg' })

  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
    client,
  )

  const emitted: any[] = []
  root.on('channel/message', (msg) => { emitted.push(msg) })

  await bridge.start()
  await waitFor(() => followed.length === 1)
  await bridge.stop()

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].media.length, 1)
  assert.equal(emitted[0].media[0].kind, 'image')
  assert.equal(emitted[0].media[0].fileRef, 'photo_big')

  // The image becomes an image block and enters content together with the caption text.
  const content = followed[0]!.content
  assert.equal(content.length, 2)
  assert.equal(content[0].type, 'text')
  assert.equal(content[0].text, 'look at this')
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].attachment.attachmentId, 'att-1')
})

test('bridge observes group mentionsBot via a text_mention entity', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  root.provide('agents', {
    list: () => [],
    get: () => undefined,
    resume: async () => { throw new Error('no persistence') },
    create: async () => { throw new Error('group chats do not create agents') },
  })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const updates: TelegramUpdate[] = [
    {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 123, is_bot: false, first_name: 'Alice' },
        chat: { id: -100, type: 'group' },
        date: 1_700_000_000,
        text: 'hi @bot',
        entities: [{ type: 'text_mention', offset: 3, length: 4, user: { id: 777, is_bot: true, username: 'test_bot' } }],
      },
    },
  ]
  const client = createFakeClient(updates)
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
    client,
  )

  const emitted: any[] = []
  root.on('channel/message', (msg) => { emitted.push(msg) })

  await bridge.start()
  await waitFor(() => emitted.length === 1)
  await bridge.stop()

  assert.equal(emitted[0].chatType, 'group')
  assert.equal(emitted[0].mentionsBot, true)
})

test('bridge reacts to a long message instead of a text ack', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  const followed: any[] = []
  const fakeAgent = { id: 'channel:telegram:42', status: 'idle' as const, session: { events: [] as any[] }, followup(m: any) { followed.push(m) }, steer(m: any) { followed.push(m) } }
  root.provide('agents', {
    list: () => [],
    get: () => undefined,
    resume: async () => { throw new Error('no persistence') },
    create: async () => ({ agent: fakeAgent, dispose: async () => {} }),
  })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const updates: TelegramUpdate[] = [
    {
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 123, is_bot: false, first_name: 'Alice' },
        chat: { id: 42, type: 'private' },
        date: 1_700_000_000,
        text: 'a'.repeat(4000),
      },
    },
  ]
  const client = createFakeClient(updates)
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
    client,
  )

  await bridge.start()
  await waitFor(() => client.reactions.length >= 1)
  await bridge.stop()

  assert.deepEqual(client.reactions, [{ chatId: '42', messageId: 100, emoji: '👀' }])
  assert.ok(!client.sends.some((s) => s.text.includes('Received, working on it…')))
})

test('bridge observes inbound replyToMessageId', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  root.provide('agents', { list: () => [], get: () => undefined, resume: async () => { throw new Error('no persistence') }, create: async () => { throw new Error('group chats do not create agents') } })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const updates: TelegramUpdate[] = [
    {
      update_id: 1,
      message: {
        message_id: 200,
        from: { id: 123, is_bot: false, first_name: 'Alice' },
        chat: { id: -100, type: 'group' },
        date: 1_700_000_000,
        text: 'quote me',
        reply_to_message: { message_id: 150 },
      },
    },
  ]
  const client = createFakeClient(updates)
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
    client,
  )

  const emitted: any[] = []
  root.on('channel/message', (msg) => { emitted.push(msg) })

  await bridge.start()
  await waitFor(() => emitted.length === 1)
  await bridge.stop()

  assert.equal(emitted[0].replyToMessageId, '150')
})

class ReconcilingTelegramChannel extends TelegramChannel {
  reconciled: Array<{ chatKey: string; key: string }> = []
  get supportsReconciliation(): boolean {
    return true
  }
  async reconcile(chatKey: string, key: string, _textHash: string): Promise<'confirmed-sent'> {
    this.reconciled.push({ chatKey, key })
    return 'confirmed-sent'
  }
}

test('bridge consults reconcile before resending a failed delivery', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  const sessionId = 'channel:telegram:42'
  const events: any[] = []
  events[1] = { type: 'assistant/message', seq: 1, time: Date.now(), data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } }
  const fakeAgent = {
    id: sessionId,
    status: 'idle' as const,
    session: { events, snapshotEvents: () => events, eventAt: (seq: number) => events[seq] },
  }
  root.provide('agents', {
    list: () => [],
    get: () => fakeAgent,
    resume: async () => { throw new Error('not used') },
    create: async () => { throw new Error('not used') },
  })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const store = createMemoryStore()
  store.setBinding('42', sessionId)
  store.recordDelivery(`${sessionId}:1`, { chatKey: '42', textHash: 'abc' })
  store.markFailed(`${sessionId}:1`, 'boom')

  const client = createFakeClient([])
  const channel = new ReconcilingTelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 }),
    store,
    channel,
    client,
  )

  await bridge.start()
  await bridge.stop()

  assert.equal(channel.reconciled.length, 1)
  assert.equal(channel.reconciled[0]!.key, `${sessionId}:1`)
  // Reconcile reported confirmed-sent → no blind resend.
  assert.equal(client.sends.length, 0)
})

/** Test-only bridge that exposes the protected approval hook and inbound entry. */
class AnswerableBridge extends TelegramBridge {
  answerApproval(num: number, outcome: 'allowed-once' | 'rejected'): void {
    this.resolveApproval(num, outcome)
  }

  async feedInbound(inbound: InboundMessage): Promise<void> {
    await this.handleInbound(inbound)
  }
}

test('recovery resumes a conventional session before deciding, instead of abandoning it', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  const sessionId = 'channel:telegram:42'
  // Dense log per the rc.6 seq = log.length contiguity contract.
  const events: any[] = [
    { type: 'user/message', seq: 0, time: Date.now(), data: { role: 'user', content: [{ type: 'text', text: 'q' }], source: { kind: 'channel', channel: 'telegram', chatKey: '42', senderId: '123', messageIds: ['77'] } } },
    { type: 'turn/start', seq: 1, time: Date.now(), data: {} },
    { type: 'assistant/message', seq: 2, time: Date.now(), data: { message: { role: 'assistant', content: [{ type: 'text', text: 'the lost answer' }] } } },
  ]
  const fakeAgent = { id: sessionId, status: 'idle' as const, session: { events, snapshotEvents: () => events, eventAt: (seq: number) => events[seq] } }
  let resumedWith: string | undefined
  root.provide('agents', {
    list: () => (resumedWith !== undefined ? [fakeAgent] : []),
    get: () => (resumedWith !== undefined ? fakeAgent : undefined),
    resume: async (opts: any) => {
      resumedWith = String(opts.resumeSessionId)
      return { agent: fakeAgent, dispose: async () => {} }
    },
    create: async () => {
      throw new Error('recovery must never create a session')
    },
  })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  // No explicit /bind entry: the session exists only by the channel:<id>:<chatKey> convention.
  const store = createMemoryStore()
  store.recordDelivery(`${sessionId}:2`, { chatKey: '42', textHash: hashText('the lost answer') })
  store.markFailed(`${sessionId}:2`, 'boom')

  const client = createFakeClient([])
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 }),
    store,
    channel,
    client,
  )

  await bridge.start()
  await waitFor(() => client.sends.length === 1)
  await bridge.stop()

  assert.equal(resumedWith, sessionId)
  assert.ok(client.sends[0]!.text.includes('the lost answer'))
  assert.ok(client.sends[0]!.text.includes('resumed resend'))
  // The resumed log was refolded into the seen set (R7).
  assert.equal(store.seenInbound('77'), true)
})

test('recovery abandons a resend whose recorded hash no longer matches the session text', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  const sessionId = 'channel:telegram:42'
  const events: any[] = [
    { type: 'turn/start', seq: 0, time: Date.now(), data: {} },
    { type: 'assistant/message', seq: 1, time: Date.now(), data: { message: { role: 'assistant', content: [{ type: 'text', text: 'the current text' }] } } },
  ]
  const fakeAgent = { id: sessionId, status: 'idle' as const, session: { events, snapshotEvents: () => events, eventAt: (seq: number) => events[seq] } }
  root.provide('agents', {
    list: () => [fakeAgent],
    get: () => fakeAgent,
    resume: async () => ({ agent: fakeAgent, dispose: async () => {} }),
    create: async () => {
      throw new Error('not used')
    },
  })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  // The recorded hash names a *different* text — what a seq-renumbering log
  // migration (0.2 v0→v4) does to a `sessionId:seq` ledger key.
  const store = createMemoryStore()
  store.recordDelivery(`${sessionId}:1`, { chatKey: '42', textHash: hashText('the pre-migration text') })
  store.markFailed(`${sessionId}:1`, 'boom')

  const client = createFakeClient([])
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 }),
    store,
    channel,
    client,
  )

  // start() awaits the startup sweep, so the abandonment has settled by now.
  await bridge.start()
  await bridge.stop()

  assert.equal(client.sends.length, 0, 'a hash-mismatched entry must not be resent')
  assert.equal(store.sweepRecoverable().length, 0, 'the entry was abandoned, not left recoverable')
})

test('an approval answered while the prompt send is in flight is honored, not dropped', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  root.provide('agents', { list: () => [], get: () => undefined, resume: async () => { throw new Error('no persistence') }, create: async () => { throw new Error('not used') } })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const store = createMemoryStore()
  store.setBinding('42', 'channel:telegram:42')

  const client = createFakeClient([])
  // Hold the prompt send open until the test releases it.
  let releaseSend!: () => void
  const sendGate = new Promise<void>((resolve) => { releaseSend = resolve })
  const originalSend = client.sendMessage.bind(client)
  ;(client as any).sendMessage = async (token: string, chatId: string, text: string, opts?: unknown) => {
    const result = await originalSend(token, chatId, text, opts as never)
    await sendGate
    return result
  }

  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new AnswerableBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 }),
    store,
    channel,
    client,
  )
  await bridge.start()

  const verdict = root.waterfall('approval/request', { agent: { id: 'channel:telegram:42' }, toolName: 'Bash' }, async () => 'unavailable' as const)
  await waitFor(() => client.sends.length === 1)
  bridge.answerApproval(1, 'allowed-once')
  releaseSend()

  assert.equal(await verdict, 'allowed-once')
  await bridge.stop()
})

test('a redelivered unauthorized message is rejected only once (dedupe before allowlist)', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  root.provide('agents', { list: () => [], get: () => undefined, resume: async () => { throw new Error('no persistence') }, create: async () => { throw new Error('should not create') } })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const duplicated = {
    message_id: 200,
    from: { id: 999, is_bot: false, first_name: 'Mallory' },
    chat: { id: 42, type: 'private' as const },
    date: 1_700_000_000,
    text: 'hi',
  }
  const client = createFakeClient([
    { update_id: 5, message: duplicated },
    { update_id: 6, message: duplicated },
  ])
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
    client,
  )

  await bridge.start()
  await waitFor(() => client.sends.length >= 1)
  await new Promise((resolve) => setTimeout(resolve, 150))
  await bridge.stop()

  const rejects = client.sends.filter((send) => send.text.includes('not authorized'))
  assert.equal(rejects.length, 1)
})

test('inbound order per §5.2: approval replies are ingested, group messages broadcast once', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  root.provide('agents', { list: () => [], get: () => undefined, resume: async () => { throw new Error('no persistence') }, create: async () => { throw new Error('not used') } })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const store = createMemoryStore()
  store.setBinding('42', 'channel:telegram:42')

  const client = createFakeClient([])
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new AnswerableBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 }),
    store,
    channel,
    client,
  )

  const emitted: any[] = []
  root.on('channel/message', (msg) => { emitted.push(msg) })

  await bridge.start()

  // A group message is broadcast for audit exactly once, behind the same dedupe.
  const group = { channel: 'telegram', chatKey: '-100', senderId: '999', messageId: '300', chatType: 'group' as const, text: 'group hello', timestamp: Date.now(), hasMedia: false }
  await bridge.feedInbound(group)
  await bridge.feedInbound(group)
  assert.equal(emitted.filter((msg) => msg.messageId === '300').length, 1)

  // An approval reply passes through ingest before the broker resolves it.
  const verdict = root.waterfall('approval/request', { agent: { id: 'channel:telegram:42' }, toolName: 'Bash' }, async () => 'unavailable' as const)
  await waitFor(() => client.sends.length === 1)
  await bridge.feedInbound({ channel: 'telegram', chatKey: '42', senderId: '123', messageId: '900', chatType: 'direct', text: 'approve', timestamp: Date.now(), hasMedia: false })
  assert.equal(await verdict, 'allowed-once')
  assert.equal(emitted.filter((msg) => msg.messageId === '900').length, 1)

  await bridge.stop()
})

test('poll loop re-announces connected after a transient failure', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  root.provide('agents', {
    list: () => [],
    get: () => undefined,
    resume: async () => {
      throw new Error('no persistence')
    },
    create: async () => ({ agent: { id: 'x', status: 'idle' as const, session: { events: [] } }, dispose: async () => {} }),
  })
  root.provide('credentials', {
    resolve: async () => ({ value: 'test-token', source: 'test' }),
  })

  const client = createFakeClient([])
  let calls = 0
  client.getUpdates = async (_token: string, opts: { signal?: AbortSignal } = {}) => {
    calls++
    if (calls === 1) return []
    if (calls === 2) throw new Error('transient network failure')
    if (calls === 3) return []
    return new Promise<TelegramUpdate[]>((resolve) => {
      const onAbort = () => resolve([])
      if (opts.signal?.aborted) return resolve([])
      opts.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
    client,
  )

  const statuses: string[] = []
  root.on('channel/status', (_id: string, status: string) => { statuses.push(status) })

  await bridge.start()
  // Failure → backoff (~1-1.5s) → successful poll must re-announce connected.
  await waitFor(() => statuses.filter((s) => s === 'connected').length === 2, 5000)
  await bridge.stop()

  const relevant = statuses.filter((s) => s !== 'connecting')
  assert.deepEqual(relevant, ['connected', 'disconnected', 'connected'])
})

test('a hung host resume cannot wedge the recovery sweep', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  const sessionId = 'channel:telegram:42'
  root.provide('agents', {
    list: () => [],
    get: () => undefined,
    // The host resume never settles — recovery must abandon past the deadline, not hang.
    resume: () => new Promise(() => {}),
    create: async () => {
      throw new Error('recovery must never create a session')
    },
  })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const store = createMemoryStore()
  store.recordDelivery(`${sessionId}:2`, { chatKey: '42', textHash: 'abc' })
  store.markFailed(`${sessionId}:2`, 'channel not connected', 'transient')
  const marked: string[] = []
  const originalMarkFailed = store.markFailed.bind(store)
  store.markFailed = (key: string, error: string, errorKind?: 'transient' | 'permanent' | 'retryable') => {
    marked.push(error)
    originalMarkFailed(key, error, errorKind as never)
  }

  const client = createFakeClient([])
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 }),
    store,
    channel,
    client,
  )
  ;(bridge as unknown as { resumeTimeoutMs: number }).resumeTimeoutMs = 50

  await bridge.start()
  // The sweep completed despite the wedged resume: the policy abandoned the entry visibly.
  await waitFor(() => marked.some((reason) => reason.includes('unavailable')))
  await bridge.stop()

  assert.equal(client.sends.length, 0)
})

test('a delivery failed mid-run is re-swept on reconnect, not only at startup', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  const sessionId = 'channel:telegram:42'
  const events: any[] = [
    { type: 'turn/start', seq: 0, time: Date.now(), data: {} },
    { type: 'assistant/message', seq: 1, time: Date.now(), data: { message: { role: 'assistant', content: [{ type: 'text', text: 'the lost mid-run answer' }] } } },
  ]
  const fakeAgent = { id: sessionId, status: 'idle' as const, session: { events, snapshotEvents: () => events, eventAt: (seq: number) => events[seq] } }
  root.provide('agents', {
    list: () => [fakeAgent],
    get: () => fakeAgent,
    resume: async () => ({ agent: fakeAgent, dispose: async () => {} }),
    create: async () => {
      throw new Error('not used')
    },
  })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const store = createMemoryStore()
  const client = createFakeClient([])
  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new TelegramBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 }),
    store,
    channel,
    client,
  )

  await bridge.start()

  // Mid-run: a disconnect window burned this delivery's retries into `failed`.
  store.recordDelivery(`${sessionId}:1`, { chatKey: '42', textHash: hashText('the lost mid-run answer') })
  store.markFailed(`${sessionId}:1`, 'channel not connected', 'transient')

  // The reconnect must trigger a fresh sweep that resends it.
  root.emit('channel/status', 'telegram', 'disconnected', new Error('transient'))
  root.emit('channel/status', 'telegram', 'connected')
  await waitFor(() => client.sends.some((send) => send.text.includes('the lost mid-run answer')))
  await bridge.stop()
})
