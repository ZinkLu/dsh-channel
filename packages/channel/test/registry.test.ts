import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Channel, ChannelRegistry, type InboundMessage, type OutboundMessage } from '../src/index.ts'

class FakeChannel extends Channel {
  readonly id = 'fake'
  readonly sent: string[] = []
  constructor() {
    super()
  }
  get maxMessageChars(): number | undefined {
    return 100
  }
  get formatTier(): 'plain' | 'markdown' | 'html' {
    return 'plain'
  }
  async send(chatKey: string, text: string): Promise<{ platformMessageId: string }> {
    this.sent.push(`${chatKey}:${text}`)
    return { platformMessageId: `msg-${this.sent.length}` }
  }
}

test('ChannelRegistry registers, lists, delivers and unregisters', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  const channel = new FakeChannel()
  const dispose = root.channels.register(channel)
  assert.equal(root.channels.get('fake'), channel)
  assert.deepEqual(root.channels.list(), [channel])

  const receipt = await root.channels.deliver({ channel: 'fake', chatKey: '42', markdown: 'hello', deliveryKey: 'k1' })
  assert.equal(receipt.status, 'sent')
  assert.deepEqual(channel.sent, ['42:hello'])

  assert.equal(dispose(), undefined)
  assert.equal(root.channels.get('fake'), undefined)
})

test('ChannelRegistry rejects duplicate id', () => {
  const root = new Context()
  new ChannelRegistry(root)
  const a = new FakeChannel()
  const b = new FakeChannel()
  root.channels.register(a)
  assert.throws(() => root.channels.register(b), /already registered/)
})

test('ChannelRegistry.deliver returns failed when no channel registered', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  const receipt = await root.channels.deliver({ channel: 'missing', chatKey: '1', markdown: 'x', deliveryKey: 'k' })
  assert.equal(receipt.status, 'failed')
  assert.match(receipt.error ?? '', /no channel/)
})

test('channel/message is emitted on ingest', () => {
  const root = new Context()
  new ChannelRegistry(root)
  const seen: InboundMessage[] = []
  root.on('channel/message', (msg) => { seen.push(msg) })
  const msg: InboundMessage = {
    channel: 'fake',
    chatKey: '7',
    senderId: 'u1',
    messageId: 'm1',
    chatType: 'direct',
    text: 'hi',
    timestamp: Date.now(),
    hasMedia: false,
  }
  root.channels.ingest(msg)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.messageId, 'm1')
})

test('channel/deliver waterfall can suppress and observe', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  const channel = new FakeChannel()
  root.channels.register(channel)

  const observed: OutboundMessage[] = []
  root.on('channel/deliver', async (out, next) => {
    observed.push(out)
    if (out.deliveryKey === 'suppress-me') return { status: 'suppressed' as const }
    return next()
  })

  const suppressed = await root.channels.deliver({ channel: 'fake', chatKey: '1', markdown: 'x', deliveryKey: 'suppress-me' })
  assert.equal(suppressed.status, 'suppressed')
  assert.equal(channel.sent.length, 0)

  const sent = await root.channels.deliver({ channel: 'fake', chatKey: '1', markdown: 'y', deliveryKey: 'pass' })
  assert.equal(sent.status, 'sent')
  assert.equal(observed.length, 2)
})
