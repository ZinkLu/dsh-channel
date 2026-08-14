import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ChannelRegistry } from 'dsh-channel'
import { createMemoryStore } from 'dsh-channel-kit'
import { WeChatBridge } from '../src/bridge.ts'
import { WeChatChannel } from '../src/channel.ts'
import type { WeixinClient, WeixinMessage } from '../src/client.ts'

interface RecordedUserMessage {
  text: string
  source: any
}

function createFakeClient(messages: WeixinMessage[]): WeixinClient & {
  sends: Array<{ chatKey: string; text: string }>
  tokens: Record<string, string>
  calls: number
} {
  const sends: Array<{ chatKey: string; text: string }> = []
  const tokens: Record<string, string> = {}
  let calls = 0
  return {
    sends,
    tokens,
    calls: 0,
    setContextToken(chatKey: string, token: string | undefined) {
      if (token) tokens[chatKey] = token
    },
    contextToken(chatKey: string) {
      return tokens[chatKey]
    },
    async getUpdates(_token: string, opts: { signal?: AbortSignal } = {}): Promise<{ msgs?: WeixinMessage[]; get_updates_buf?: string }> {
      calls++
      if (calls === 1) return { msgs: messages, get_updates_buf: 'buf1' }
      return new Promise<{ msgs?: WeixinMessage[] }>((resolve) => {
        const onAbort = () => {
          opts.signal?.removeEventListener('abort', onAbort)
          resolve({ msgs: [] })
        }
        if (opts.signal?.aborted) {
          resolve({ msgs: [] })
          return
        }
        opts.signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    async sendMessage(_token: string, chatKey: string, text: string): Promise<{ client_id: string }> {
      sends.push({ chatKey, text })
      return { client_id: `id-${sends.length}` }
    },
    async getConfig(): Promise<{ typingTicket?: string }> {
      return { typingTicket: undefined }
    },
    async sendTyping(): Promise<unknown> {
      return {}
    },
  } as unknown as WeixinClient & {
    sends: Array<{ chatKey: string; text: string }>
    tokens: Record<string, string>
    calls: number
  }
}

test('bridge ingests, routes, merges, and dispatches to agent', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  const followed: RecordedUserMessage[] = []
  const fakeAgent = {
    id: 'channel:wechat:alice',
    status: 'idle' as const,
    session: { events: [] as any[] },
    followup(message: any) {
      followed.push({ text: messageTextFromContent(message), source: message.source })
    },
    steer(message: any) {
      followed.push({ text: messageTextFromContent(message), source: message.source })
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

  const messages: WeixinMessage[] = [
    {
      message_id: '100',
      from_user_id: 'alice',
      msg_type: 1,
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    },
  ]
  const client = createFakeClient(messages)
  const channel = new WeChatChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new WeChatBridge(
    root,
    { allowedUserIds: ['alice'], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 },
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
  assert.equal(emitted[0].channel, 'wechat')
  assert.equal(followed.length, 1)
  assert.deepEqual(followed[0]!.text, 'hello')
  assert.equal(followed[0]!.source.kind, 'channel')
  assert.equal(followed[0]!.source.channel, 'wechat')
  assert.deepEqual(followed[0]!.source.messageIds, ['100'])
})

test('bridge rejects non-allowlisted sender with a local reply', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  root.provide('agents', { list: () => [], get: () => undefined, resume: async () => { throw new Error('no persistence') }, create: async () => { throw new Error('should not create') } })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const messages: WeixinMessage[] = [
    { message_id: '200', from_user_id: 'mallory', msg_type: 1, item_list: [{ type: 1, text_item: { text: 'hi' } }] },
  ]
  const client = createFakeClient(messages)
  const channel = new WeChatChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new WeChatBridge(
    root,
    { allowedUserIds: ['alice'], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 0.05, approvalTimeoutSec: 120 },
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
