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

test('TelegramClient.getFile downloads bytes via file endpoint', async () => {
  const urls: string[] = []
  const client = new TelegramClient({
    baseUrl: 'https://example.test',
    fetch: (async (url: string | URL | Request) => {
      const u = String(url)
      urls.push(u)
      if (u.includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_id: 'f1', file_path: 'photos/1.jpg' } }), { status: 200 })
      }
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 })
    }) as typeof fetch,
  })

  const { bytes, filePath } = await client.getFile('tok', 'f1')
  assert.equal(filePath, 'photos/1.jpg')
  assert.deepEqual([...bytes], [0xff, 0xd8, 0xff])
  assert.equal(urls[1], 'https://example.test/file/bottok/photos/1.jpg')
})

test('TelegramClient.sendPhoto posts multipart form', async () => {
  let body: unknown
  const client = new TelegramClient({
    baseUrl: 'https://example.test',
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      assert.ok(String(url).endsWith('/sendPhoto'))
      body = init?.body
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 })
    }) as typeof fetch,
  })

  const sent = await client.sendPhoto('tok', '42', new Uint8Array([1, 2, 3]), { caption: 'hi' })
  assert.equal(sent.message_id, 9)
  assert.ok(body instanceof FormData)
})

test('TelegramChannel.sendMedia sends image via readImage and document via readFile', async () => {
  const sends: Array<{ kind: string; bytes: number[]; caption?: string }> = []
  const client = {
    async sendPhoto(_token: string, _chatId: string, bytes: Uint8Array, opts?: { caption?: string }): Promise<{ message_id: number }> {
      sends.push({ kind: 'photo', bytes: [...bytes], caption: opts?.caption })
      return { message_id: 1 }
    },
    async sendDocument(_token: string, _chatId: string, bytes: Uint8Array, opts?: { caption?: string; fileName?: string }): Promise<{ message_id: number }> {
      sends.push({ kind: 'document', bytes: [...bytes], caption: opts?.caption })
      return { message_id: 2 }
    },
  } as any

  const channel = new TelegramChannel({
    client,
    resolveToken: async () => 'tok',
    readImage: async () => new Uint8Array([1, 2, 3]),
    readFile: async (p: string) => ({ bytes: new Uint8Array([4, 5, 6]), name: p }),
  })

  const img = await channel.sendMedia('42', { kind: 'image', attachment: {} as any, caption: 'pic' })
  assert.equal(img.platformMessageId, '1')
  assert.equal(sends[0]!.kind, 'photo')
  assert.deepEqual(sends[0]!.bytes, [1, 2, 3])

  const doc = await channel.sendMedia('42', { kind: 'document', filePath: 'out.txt' })
  assert.equal(doc.platformMessageId, '2')
  assert.equal(sends[1]!.kind, 'document')
  assert.deepEqual(sends[1]!.bytes, [4, 5, 6])
})
