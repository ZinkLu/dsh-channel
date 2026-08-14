import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WeixinApiError, WeixinClient } from '../src/client.ts'
import { WeChatChannel } from '../src/channel.ts'

test('WeixinClient calls getupdates with base_info and iLink headers', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const client = new WeixinClient({
    baseUrl: 'https://example.test/',
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      return new Response(JSON.stringify({ ret: 0, msgs: [{ message_id: '7' }], get_updates_buf: 'buf1' }), { status: 200 })
    }) as typeof fetch,
  })

  const updates = await client.getUpdates('tok-123', { syncBuf: 'buf0' })
  assert.equal(updates.msgs![0]!.message_id, '7')
  assert.equal(updates.get_updates_buf, 'buf1')
  assert.equal(calls[0]!.url, 'https://example.test/ilink/bot/getupdates')
  const body = JSON.parse(String(calls[0]!.init.body))
  assert.deepEqual(body.base_info, { channel_version: '2.2.0' })
  assert.equal(body.get_updates_buf, 'buf0')
  assert.equal((calls[0]!.init.headers as Record<string, string>)['Authorization'], 'Bearer tok-123')
})

test('WeixinClient throws redacted WeixinApiError on api failure', async () => {
  const client = new WeixinClient({
    baseUrl: 'https://example.test',
    fetch: (async () => new Response(JSON.stringify({ ret: -14, errcode: -14, errmsg: 'bad token: tok-secret' }), { status: 200 })) as typeof fetch,
  })
  await assert.rejects(
    () => client.getUpdates('tok-secret'),
    (error: unknown) => {
      assert.ok(error instanceof WeixinApiError)
      assert.ok(!error.message.includes('tok-secret'))
      assert.equal((error as WeixinApiError).errcode, -14)
      return true
    },
  )
})

test('WeChatChannel.send echoes context token for the peer', async () => {
  const sends: Array<{ chatKey: string; text: string; contextToken?: string }> = []
  const client = {
    setContextToken(chatKey: string, token: string) {
      this.tokens[chatKey] = token
    },
    tokens: {} as Record<string, string>,
    contextToken(chatKey: string) {
      return this.tokens[chatKey]
    },
    async sendMessage(_token: string, chatKey: string, text: string, opts?: { contextToken?: string }): Promise<{ client_id: string }> {
      // Mirror the real WeixinClient: look up the peer token internally when opts.contextToken is absent.
      const contextToken = opts?.contextToken ?? this.contextToken(chatKey)
      sends.push({ chatKey, text, contextToken })
      return { client_id: `id-${sends.length}` }
    },
  } as any

  client.setContextToken('42', 'ctx-token-1')
  const channel = new WeChatChannel({ client, resolveToken: async () => 'tok' })
  const result = await channel.send('42', 'hello **world**')
  assert.equal(result.platformMessageId, 'id-1')
  assert.equal(sends[0]!.contextToken, 'ctx-token-1')
  assert.equal(sends[0]!.text, 'hello **world**')
})
