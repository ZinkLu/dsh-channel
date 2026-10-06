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

/** Transport-level stub: records the focus choices the provider forwards to the kit. */
class FocusRecordingBridge extends TelegramBridge {
  focusCalls: Array<{ sessionId: string; chatKey: string }> = []
  focusOutcome: 'focused' | 'unavailable' | 'foreign' = 'focused'
  protected async applyFocusChoice(sessionId: string, chatKey: string): Promise<'focused' | 'unavailable' | 'foreign'> {
    this.focusCalls.push({ sessionId, chatKey })
    return this.focusOutcome
  }
}

function createClient(sends: Array<{ chatId: string; text: string }>, queued: TelegramUpdate[]): TelegramClient {
  return {
    async getMe() {
      return { id: 777, username: 'test_bot' }
    },
    async getUpdates(_t: string, opts: { signal?: AbortSignal } = {}) {
      for (let i = 0; i < 100; i++) {
        if (queued.length > 0) return queued.splice(0)
        if (opts.signal?.aborted) return []
        await new Promise((r) => setTimeout(r, 10))
      }
      return []
    },
    async sendMessage(_t: string, chatId: string, text: string) {
      sends.push({ chatId, text })
      return { message_id: sends.length }
    },
    async sendChatAction() {
      return true
    },
    async answerCallbackQuery() {
      return true
    },
    async setMessageReaction() {
      return true
    },
    async editMessageText(_t: string, _c: string, messageId: number, text: string) {
      return { message_id: messageId, text }
    },
    async deleteMessage() {
      return true
    },
  } as unknown as TelegramClient
}

test('a focus: callback_query forwards to applyFocusChoice and confirms the new focus', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  root.provide('agents', { list: () => [], get: () => undefined, resume: async () => { throw new Error('x') }, create: async () => { throw new Error('x') } })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const sends: Array<{ chatId: string; text: string }> = []
  const queued: TelegramUpdate[] = []
  const client = createClient(sends, queued)

  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new FocusRecordingBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
    client,
  )
  await bridge.start()

  queued.push({
    update_id: 901,
    callback_query: {
      id: 'cbq-focus-1',
      from: { id: 123, is_bot: false, first_name: 'U' },
      message: { message_id: 7, chat: { id: 42, type: 'private' }, date: 1, text: 'the /ls card' },
      data: 'focus:9f2c6b1e-1234-4abc-9def-0123456789ab',
    },
  } as unknown as TelegramUpdate)

  await waitFor(() => sends.some((send) => send.text.includes('Focused')))
  await bridge.stop()

  assert.deepEqual(bridge.focusCalls, [{ sessionId: '9f2c6b1e-1234-4abc-9def-0123456789ab', chatKey: '42' }])
  const confirmation = sends.find((send) => send.text.includes('Focused'))!
  // The uuid is shortened for chat display.
  assert.equal(confirmation.text, '✅ Focused 9f2c6b1e…')
})

test('an unavailable focus choice reports the stale-list warning instead of confirming', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  root.provide('agents', { list: () => [], get: () => undefined, resume: async () => { throw new Error('x') }, create: async () => { throw new Error('x') } })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const sends: Array<{ chatId: string; text: string }> = []
  const queued: TelegramUpdate[] = []
  const client = createClient(sends, queued)

  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new FocusRecordingBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
    client,
  )
  bridge.focusOutcome = 'unavailable'
  await bridge.start()

  queued.push({
    update_id: 902,
    callback_query: {
      id: 'cbq-focus-2',
      from: { id: 123, is_bot: false, first_name: 'U' },
      message: { message_id: 8, chat: { id: 42, type: 'private' }, date: 1, text: 'the /ls card' },
      data: 'focus:dead-session',
    },
  } as unknown as TelegramUpdate)

  await waitFor(() => sends.some((send) => send.text.includes('could not be focused')))
  await bridge.stop()

  assert.deepEqual(bridge.focusCalls, [{ sessionId: 'dead-session', chatKey: '42' }])
  assert.ok(!sends.some((send) => send.text.includes('✅ Focused')))
})

test('a foreign focus choice replies with the /use --take warning instead of confirming', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  root.provide('agents', { list: () => [], get: () => undefined, resume: async () => { throw new Error('x') }, create: async () => { throw new Error('x') } })
  root.provide('credentials', { resolve: async () => ({ value: 'test-token', source: 'test' }) })

  const sends: Array<{ chatId: string; text: string }> = []
  const queued: TelegramUpdate[] = []
  const client = createClient(sends, queued)

  const channel = new TelegramChannel({ client, resolveToken: async () => 'test-token' })
  root.channels.register(channel)
  const bridge = new FocusRecordingBridge(
    root,
    () => ({ allowedUserIds: [123], provider: 'deepseek-official', pollingTimeoutSec: 1, mergeWindowSec: 5, approvalTimeoutSec: 120 }),
    createMemoryStore(),
    channel,
    client,
  )
  bridge.focusOutcome = 'foreign'
  await bridge.start()

  queued.push({
    update_id: 903,
    callback_query: {
      id: 'cbq-focus-3',
      from: { id: 123, is_bot: false, first_name: 'U' },
      message: { message_id: 9, chat: { id: 42, type: 'private' }, date: 1, text: 'the /ls card' },
      data: 'focus:tui-session-1',
    },
  } as unknown as TelegramUpdate)

  await waitFor(() => sends.some((send) => send.text.includes('--take')))
  await bridge.stop()

  assert.deepEqual(bridge.focusCalls, [{ sessionId: 'tui-session-1', chatKey: '42' }])
  const warning = sends.find((send) => send.text.includes('--take'))!
  // The channel renders for its HTML tier: the backticked command arrives as <code>.
  assert.equal(
    warning.text,
    '⚠️ this session was not started by this host; resuming it here while another process has it open would corrupt its log — reply <code>/use tui-session-1 --take</code> to adopt',
  )
  assert.ok(!sends.some((send) => send.text.includes('✅ Focused')))
})
