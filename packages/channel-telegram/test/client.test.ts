import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TelegramApiError, TelegramClient } from '../src/client.ts'
import { TelegramChannel } from '../src/channel.ts'

test('TelegramClient calls getUpdates with expected body', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const client = new TelegramClient({
    baseUrl: 'https://example.test/',
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      return new Response(JSON.stringify({ ok: true, result: [{ update_id: 7 }] }), { status: 200 })
    }) as typeof fetch,
  })

  const updates = await client.getUpdates('tok-123', { offset: 0, timeoutSec: 10 })
  assert.equal(updates[0]!.update_id, 7)
  assert.equal(calls[0]!.url, 'https://example.test/bottok-123/getUpdates?offset=0&timeout=10&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D')
})

test('TelegramClient throws redacted TelegramApiError on api failure', async () => {
  const client = new TelegramClient({
    baseUrl: 'https://example.test',
    fetch: (async () => new Response(JSON.stringify({ ok: false, description: 'bad token: tok-secret', error_code: 401 }), { status: 401 })) as typeof fetch,
  })
  await assert.rejects(
    () => client.sendMessage('tok-secret', '1', 'hi'),
    (error: unknown) => {
      assert.ok(error instanceof TelegramApiError)
      assert.ok(!error.message.includes('tok-secret'))
      assert.equal((error as TelegramApiError).errorCode, 401)
      return true
    },
  )
})

test('TelegramChannel.send falls back to plain text when HTML fails', async () => {
  const sends: string[] = []
  const client = {
    async sendMessage(_token: string, _chatId: string, text: string, opts?: { parseMode?: string }): Promise<{ message_id: number }> {
      sends.push(text)
      if (opts?.parseMode === 'HTML' && text.includes('<b>')) {
        throw new TelegramApiError('bad html')
      }
      return { message_id: sends.length }
    },
  } as any

  const channel = new TelegramChannel({ client, resolveToken: async () => 'tok' })
  const result = await channel.send('42', '<b>hello</b>', { choices: [{ id: 'a', label: 'A' }] })
  assert.equal(result.platformMessageId, '2')
  assert.equal(sends[0], '<b>hello</b>')
  assert.equal(sends[1], '**hello**')
})
