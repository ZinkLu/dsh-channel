import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ChannelRegistry } from 'dsh-channel'
import { createMemoryStore } from 'dsh-channel-kit'
import { FeishuBridge } from '../src/bridge.ts'
import { FeishuChannel } from '../src/channel.ts'
import { FeishuClient, type FeishuEventV2 } from '../src/client.ts'

interface RecordedUserMessage {
  text: string
  source: any
}

function makeEvent(overrides: Partial<FeishuEventV2['event']> = {}): FeishuEventV2 {
  return {
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1', event_id: 'evt_1' },
    event: {
      sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
      message: {
        message_id: 'om_100',
        chat_id: 'oc_chat1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
        create_time: '1700000000000',
      },
      ...overrides,
    },
  }
}

function fakeClient(): FeishuClient {
  return new FeishuClient({
    domain: 'feishu',
    fetch: (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-1', expire: 7200 }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_sent' } }), { status: 200 })
    }) as typeof fetch,
  })
}

test('bridge routes an inbound p2p text event to the agent', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  const followed: RecordedUserMessage[] = []
  const fakeAgent = {
    id: 'channel:feishu:oc_chat1',
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
    resume: async () => { throw new Error('no persistence') },
    create: async () => ({ agent: fakeAgent, dispose: async () => {} }),
  })
  root.provide('credentials', { resolve: async () => ({ value: 'x', source: 'test' }) })

  const client = fakeClient()
  const channel = new FeishuChannel({ client, resolveCredentials: async () => ({ appId: 'cli_a', appSecret: 'secret_b' }) })
  root.channels.register(channel)
  const bridge = new FeishuBridge(
    root,
    () => ({ allowedUserIds: ['ou_alice'], provider: 'deepseek-official', mergeWindowSec: 0.05, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
  )

  const emitted: any[] = []
  root.on('channel/message', (msg) => { emitted.push(msg) })

  await bridge.handleEvent(makeEvent())
  await waitFor(() => followed.length === 1)

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].channel, 'feishu')
  assert.equal(followed.length, 1)
  assert.deepEqual(followed[0]!.text, 'hello')
  assert.equal(followed[0]!.source.kind, 'channel')
  assert.equal(followed[0]!.source.channel, 'feishu')
  assert.deepEqual(followed[0]!.source.messageIds, ['om_100'])
})

test('bridge rejects non-allowlisted sender', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  const sent: string[] = []
  root.provide('agents', { list: () => [], get: () => undefined, resume: async () => { throw new Error('no persistence') }, create: async () => { throw new Error('should not create') } })
  root.provide('credentials', { resolve: async () => ({ value: 'x', source: 'test' }) })

  const client = fakeClient()
  const channel = new FeishuChannel({ client, resolveCredentials: async () => ({ appId: 'cli_a', appSecret: 'secret_b' }) })
  root.channels.register(channel)
  const bridge = new FeishuBridge(
    root,
    () => ({ allowedUserIds: ['ou_alice'], provider: 'deepseek-official', mergeWindowSec: 0.05, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
  )

  // Intercept deliver to observe outbound.
  root.on('channel/deliver', (out: any, next) => {
    sent.push(out.markdown)
    return next()
  })

  await bridge.handleEvent(makeEvent({ sender: { sender_id: { open_id: 'ou_mallory' }, sender_type: 'user' } }))

  // The rejection rides the chatKey's serial delivery worker, like every other
  // bridge-authored message, so it lands on the next turn of the loop.
  await waitFor(() => sent.some((text) => text.includes('You are not authorized to use this bot')))
})

test('bridge observes inbound replyToMessageId from parent_id', async () => {
  const root = new Context()
  new ChannelRegistry(root)

  const followed: RecordedUserMessage[] = []
  const fakeAgent = {
    id: 'channel:feishu:oc_chat1',
    status: 'idle' as const,
    session: { events: [] as any[] },
    followup(message: any) { followed.push({ text: messageTextFromContent(message), source: message.source }) },
    steer(message: any) { followed.push({ text: messageTextFromContent(message), source: message.source }) },
  }
  root.provide('agents', {
    list: () => [],
    get: () => undefined,
    resume: async () => { throw new Error('no persistence') },
    create: async () => ({ agent: fakeAgent, dispose: async () => {} }),
  })
  root.provide('credentials', { resolve: async () => ({ value: 'x', source: 'test' }) })

  const client = fakeClient()
  const channel = new FeishuChannel({ client, resolveCredentials: async () => ({ appId: 'cli_a', appSecret: 'secret_b' }) })
  root.channels.register(channel)
  const bridge = new FeishuBridge(
    root,
    () => ({ allowedUserIds: ['ou_alice'], provider: 'deepseek-official', mergeWindowSec: 0.05, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
  )

  const emitted: any[] = []
  root.on('channel/message', (msg) => { emitted.push(msg) })

  await bridge.handleEvent(makeEvent({
    message: {
      message_id: 'om_100',
      chat_id: 'oc_chat1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hi' }),
      create_time: '1700000000000',
      parent_id: 'om_parent',
    },
  }))
  await waitFor(() => emitted.length === 1)

  assert.equal(emitted[0].replyToMessageId, 'om_parent')
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
