import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ChannelRegistry } from 'dsh-channel'
import { createMemoryStore } from 'dsh-channel-kit'
import { TelegramBridge } from '../src/bridge.ts'
import { TelegramChannel } from '../src/channel.ts'
import type { TelegramClient, TelegramUpdate } from '../src/client.ts'

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('condition not met within timeout')
}

test('a real callback_query update resolves the approval its card asked for (poll loop → processCallbackQuery → broker)', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  root.provide('agents', { list: () => [], get: () => undefined, resume: async () => { throw new Error('x') }, create: async () => { throw new Error('x') } })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const sends: Array<{ chatId: string; text: string; opts: any }> = []
  const edits: Array<{ messageId: number; text: string }> = []
  const queued: TelegramUpdate[] = []
  const client = {
    async getMe() { return { id: 777, username: 'test_bot' } },
    async getUpdates(_t: string, opts: { signal?: AbortSignal } = {}) {
      // Deliver whatever is queued; otherwise hold like a long poll until abort or new data.
      for (let i = 0; i < 100; i++) {
        if (queued.length > 0) return queued.splice(0)
        if (opts.signal?.aborted) return []
        await new Promise((r) => setTimeout(r, 10))
      }
      return []
    },
    async sendMessage(_t: string, chatId: string, text: string, opts: any) { sends.push({ chatId, text, opts }); return { message_id: sends.length } },
    async sendChatAction() { return true },
    async answerCallbackQuery() { return true },
    async setMessageReaction() { return true },
    async editMessageText(_t: string, _c: string, messageId: number, text: string) { edits.push({ messageId, text }); return { message_id: messageId } },
    async deleteMessage() { return true },
  } as unknown as TelegramClient

  const store = createMemoryStore()
  store.setBinding('42', 'channel:telegram:42')
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

  const verdict = root.waterfall('approval/request', { agent: { id: 'channel:telegram:42' }, toolName: 'Bash', reason: 'why' }, async () => 'unavailable' as const)
  await waitFor(() => sends.length === 1)
  const card = sends[0]!
  const data = card.opts?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data as string
  assert.equal(data, 'appr:1:1')

  // The user taps "Approve": Telegram delivers a callback_query update on the next poll.
  queued.push({
    update_id: 900,
    callback_query: { id: 'cbq-1', from: { id: 123, is_bot: false, first_name: 'U' }, message: { message_id: 1, chat: { id: 42, type: 'private' }, date: 1, text: card.text }, data },
  } as unknown as TelegramUpdate)

  const outcome = await Promise.race([verdict, new Promise((r) => setTimeout(() => r('TIMEOUT-no-resolve'), 3000))])
  await bridge.stop()
  assert.equal(outcome, 'allowed-once')
})
