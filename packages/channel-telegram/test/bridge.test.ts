import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ChannelRegistry } from 'dsh-channel'
import { createMemoryStore } from 'dsh-channel-kit'
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
  calls: number
} {
  const sends: Array<{ chatId: string; text: string }> = []
  const edits: Array<{ chatId: string; messageId: number; text: string }> = []
  const deletes: number[] = []
  let calls = 0
  return {
    sends,
    edits,
    deletes,
    calls: 0,
    async getUpdates(_token: string, opts: { signal?: AbortSignal } = {}): Promise<TelegramUpdate[]> {
      calls++
      if (calls === 1) return updates
      // 后续长轮询挂起，直到 abort 后退出。
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
    { allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 },
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
    { allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 },
    createMemoryStore(),
    channel,
    client,
  )

  await bridge.start()
  await waitFor(() => client.sends.length >= 1)
  await bridge.stop()

  assert.ok(client.sends.some((send) => send.text.includes('没有权限')))
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
    { allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 0.05 },
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
    { allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 },
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
            text: '抱歉，刚才可能没有正确显示结果。我再查一次：\n<tool_calls>\n<invoke name="Bash">\n<parameter name="command" string="true">date</parameter>\n</invoke>\n</tool_calls>',
          },
        ],
      },
    },
  })

  await waitFor(() => client.sends.length >= 1)
  await bridge.stop()

  const sent = client.sends.map((send) => send.text).join('\n')
  assert.ok(sent.includes('抱歉'))
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

  const fakeAgent = { id: 'channel:telegram:42', status: 'idle' as const, session: { events: [] as any[] }, followup() {}, steer() {} }
  root.provide('agents', {
    list: () => [],
    get: () => undefined,
    resume: async () => { throw new Error('no persistence') },
    create: async (opts: any) => {
      metaPresets.push(opts.meta?.agentPreset)
      if (opts.setup) await opts.setup({ get: () => undefined })
      return { agent: fakeAgent, dispose: async () => {} }
    },
  })
  root.provide('agentPresets', {
    resolve: async (id?: string) => {
      resolveCalls.push(id)
      return { id: 'standard' }
    },
    mount: async (_agentCtx: any, id?: string) => {
      mountCalls.push(id)
    },
  })
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
    { allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 },
    createMemoryStore(),
    channel,
    client,
  )

  await bridge.start()
  await waitFor(() => mountCalls.length >= 1)
  await bridge.stop()

  // config.agentPreset 未设 → resolve 收到 undefined → 用宿主默认 preset。
  assert.deepEqual(resolveCalls, [undefined])
  // preset id 落到 session header（meta.agentPreset），供 resume 重建能力。
  assert.deepEqual(metaPresets, ['standard'])
  // setup 里确实 mount 了该 preset。
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
    { allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 },
    store,
    channel,
    client,
  )
  await bridge.start()

  root.emit('session/event', { id: sessionId }, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
  root.emit('session/event', { id: sessionId }, { type: 'tool/call', seq: 2, time: Date.now(), data: { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{"command":"npm test"}' } })

  // 门控 1500ms：定时器触发才建草稿。
  await waitFor(() => client.sends.some((s) => s.text.includes('Working…')), 2500)
  assert.ok(client.sends.some((s) => s.text.includes('🛠️ Bash')))

  root.emit('session/event', { id: sessionId }, { type: 'tool/result', seq: 3, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] } } })
  await waitFor(() => client.edits.length >= 1, 2000)

  root.emit('session/event', { id: sessionId }, { type: 'assistant/message', seq: 4, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } })
  await waitFor(() => client.sends.some((s) => s.text === 'done'), 2000)
  await waitFor(() => client.deletes.length >= 1, 2000)

  await bridge.stop()
})

test('bridge registers a user-questions provider and renders an option prompt', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  const sessionId = 'channel:telegram:42'

  let registeredProvider: { ask: (request: any) => Promise<any> } | null = null
  const fakeUq = { registerProvider(provider: any) { registeredProvider = provider; return () => {} } }
  const fakeAgentCtx = { get: (name: string) => (name === 'userQuestions' ? fakeUq : undefined) }
  const fakeAgent = { id: sessionId, status: 'idle' as const, session: { events: [] as any[] }, followup() {}, steer() {} }

  root.provide('agents', {
    list: () => [],
    get: () => undefined,
    resume: async () => { throw new Error('no persistence') },
    create: async (opts: any) => {
      if (opts.setup) await opts.setup(fakeAgentCtx)
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
    { allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 },
    createMemoryStore(),
    channel,
    client,
  )
  await bridge.start()
  await waitFor(() => registeredProvider !== null, 2000)

  // agent 已创建 → provider 已注册；ask() 渲染选项提示。
  const answerPromise = registeredProvider!.ask({
    questions: [{ id: 'q1', question: 'pick', options: [{ label: 'A' }, { label: 'B' }] }],
    agent: { id: sessionId },
  })
  await waitFor(() => client.sends.some((s) => s.text.includes('pick')), 2000)

  // 文本应答 "2" → 解析到 prompt → 返回 selected ['B']。
  // 走 getUpdates 二次批次太绕，这里直接断言渲染完成；应答解析由 kit 单测 + resolvePrompt 覆盖。
  assert.ok(client.sends.some((s) => s.text.includes('pick')))
  void answerPromise
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
    { allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 },
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

  // 图片落成 image 块，随文本 caption 一起进 content。
  const content = followed[0]!.content
  assert.equal(content.length, 2)
  assert.equal(content[0].type, 'text')
  assert.equal(content[0].text, 'look at this')
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].attachment.attachmentId, 'att-1')
})
