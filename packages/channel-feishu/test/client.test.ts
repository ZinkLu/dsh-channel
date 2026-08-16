import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FeishuApiError, FeishuClient, resolveReceiveIdType } from '../src/client.ts'
import { FeishuChannel } from '../src/channel.ts'

test('FeishuClient requests and caches tenant_access_token', async () => {
  const calls: string[] = []
  let tokenRequests = 0
  const client = new FeishuClient({
    domain: 'feishu',
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      calls.push(u)
      if (u.endsWith('/auth/v3/tenant_access_token/internal')) {
        tokenRequests++
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-123', expire: 7200 }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_1' } }), { status: 200 })
    }) as typeof fetch,
  })

  const token = await client.getTenantAccessToken({ appId: 'cli_a', appSecret: 'secret_b' })
  assert.equal(token, 't-123')
  // Fetching again should hit the cache (no further request).
  await client.getTenantAccessToken({ appId: 'cli_a', appSecret: 'secret_b' })
  assert.equal(tokenRequests, 1)
})

test('FeishuClient.sendMessage posts text with receive_id_type resolution', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const client = new FeishuClient({
    domain: 'feishu',
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body })
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_1' } }), { status: 200 })
    }) as typeof fetch,
  })

  await client.sendMessage('tok', 'oc_chat1', 'hello')
  assert.equal(calls[0]!.url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id')
  const body = JSON.parse(String(calls[0]!.body))
  assert.equal(body.receive_id, 'oc_chat1')
  assert.equal(body.msg_type, 'text')
  assert.equal(JSON.parse(body.content).text, 'hello')
})

test('FeishuClient throws FeishuApiError with code on failure', async () => {
  const client = new FeishuClient({
    domain: 'feishu',
    fetch: (async () => new Response(JSON.stringify({ code: 99991672, msg: 'app secret not found' }), { status: 200 })) as typeof fetch,
  })
  await assert.rejects(
    () => client.getTenantAccessToken({ appId: 'cli_a', appSecret: 'secret_b' }),
    (error: unknown) => {
      assert.ok(error instanceof FeishuApiError)
      assert.equal((error as FeishuApiError).code, 99991672)
      return true
    },
  )
})

test('resolveReceiveIdType maps prefixes', () => {
  assert.equal(resolveReceiveIdType('oc_chat1'), 'chat_id')
  assert.equal(resolveReceiveIdType('ou_user1'), 'open_id')
  assert.equal(resolveReceiveIdType('on_union1'), 'union_id')
  assert.equal(resolveReceiveIdType('u_user1'), 'user_id')
  assert.equal(resolveReceiveIdType('someone@example.com'), 'open_id')
})

test('FeishuChannel.send resolves credentials and returns message id', async () => {
  const client = {
    async getTenantAccessToken(credentials: { appId: string; appSecret: string }): Promise<string> {
      assert.equal(credentials.appId, 'cli_a')
      return 'tok'
    },
    async sendMessage(_token: string, chatKey: string, text: string): Promise<string> {
      assert.equal(chatKey, 'oc_chat1')
      assert.equal(text, 'hello')
      return 'om_1'
    },
  } as any

  const channel = new FeishuChannel({ client, resolveCredentials: async () => ({ appId: 'cli_a', appSecret: 'secret_b' }) })
  const result = await channel.send('oc_chat1', 'hello')
  assert.equal(result.platformMessageId, 'om_1')
})

test('FeishuClient.createReaction maps the ack emoji to an emoji_type', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const client = new FeishuClient({
    domain: 'feishu',
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    }) as typeof fetch,
  })

  await client.createReaction('tok', 'om_1', '👀')
  assert.equal(calls[0]!.url, 'https://open.feishu.cn/open-apis/im/v1/messages/om_1/reactions')
  assert.deepEqual(calls[0]!.body, { reaction_type: { emoji_type: 'ONLOOKER' } })
})

test('FeishuChannel.react resolves credentials and calls createReaction', async () => {
  const reacted: Array<{ messageId: string; emoji: string }> = []
  const client = {
    async getTenantAccessToken(): Promise<string> { return 'tok' },
    async createReaction(_token: string, messageId: string, emoji: string): Promise<void> {
      reacted.push({ messageId, emoji })
    },
  } as any

  const channel = new FeishuChannel({ client, resolveCredentials: async () => ({ appId: 'cli_a', appSecret: 'secret_b' }) })
  assert.equal(channel.supportsReactions, true)
  await channel.react('oc_chat1', 'om_1', '👀')
  assert.deepEqual(reacted, [{ messageId: 'om_1', emoji: '👀' }])
})

test('FeishuChannel.send uses replyMessage when replyTo is provided', async () => {
  const replies: Array<{ messageId: string; text: string }> = []
  const client = {
    async getTenantAccessToken(): Promise<string> { return 'tok' },
    async replyMessage(_token: string, messageId: string, text: string): Promise<string> {
      replies.push({ messageId, text })
      return 'om_reply'
    },
    async sendMessage(): Promise<string> { return 'om_sent' },
  } as any

  const channel = new FeishuChannel({ client, resolveCredentials: async () => ({ appId: 'cli_a', appSecret: 'secret_b' }) })
  assert.equal(channel.supportsReply, true)
  const result = await channel.send('oc_chat1', 'hello', { replyTo: 'om_parent' })
  assert.equal(result.platformMessageId, 'om_reply')
  assert.deepEqual(replies, [{ messageId: 'om_parent', text: 'hello' }])
})
