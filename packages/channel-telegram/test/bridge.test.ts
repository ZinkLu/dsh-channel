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

function createFakeClient(updates: TelegramUpdate[]): TelegramClient & { sends: Array<{ chatId: string; text: string }>; calls: number } {
  const sends: Array<{ chatId: string; text: string }> = []
  let calls = 0
  return {
    sends,
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
    async editMessageText(_token: string, _chatId: string, _messageId: number, text: string): Promise<{ message_id: number }> {
      return { message_id: _messageId }
    },
  } as unknown as TelegramClient & { sends: Array<{ chatId: string; text: string }>; calls: number }
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
