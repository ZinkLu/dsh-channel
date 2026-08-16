import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Channel, ChannelRegistry, type InboundMessage, type OutboundMedia, type OutboundMessage } from '../src/index.ts'

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

class MediaChannel extends FakeChannel {
  readonly media: OutboundMedia[] = []
  get supportsMedia(): boolean {
    return true
  }
  async sendMedia(chatKey: string, media: OutboundMedia): Promise<{ platformMessageId: string }> {
    this.media.push(media)
    return { platformMessageId: `media-${this.media.length}` }
  }
}

test('Channel supportsReactions defaults to false and react is a no-op', async () => {
  const channel = new FakeChannel()
  assert.equal(channel.supportsReactions, false)
  // The base no-op must never throw.
  await assert.doesNotReject(() => channel.react('42', 'm1', '👀'))
})

class ReactChannel extends FakeChannel {
  readonly reacted: Array<{ chatKey: string; messageId: string; emoji: string }> = []
  get supportsReactions(): boolean {
    return true
  }
  async react(chatKey: string, messageId: string, emoji: string): Promise<void> {
    this.reacted.push({ chatKey, messageId, emoji })
  }
}

test('supportsReactions platform implements react with chatKey/messageId/emoji', async () => {
  const channel = new ReactChannel()
  assert.equal(channel.supportsReactions, true)
  await channel.react('42', 'm1', '👀')
  assert.deepEqual(channel.reacted, [{ chatKey: '42', messageId: 'm1', emoji: '👀' }])
})

test('ChannelRegistry.deliver sends media via sendMedia when supported', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  const channel = new MediaChannel()
  root.channels.register(channel)

  const receipt = await root.channels.deliver({
    channel: 'fake',
    chatKey: '42',
    markdown: 'here is a file',
    deliveryKey: 'k1',
    media: [{ kind: 'document', filePath: 'out.txt' }],
  })
  assert.equal(receipt.status, 'sent')
  assert.deepEqual(receipt.platformMessageIds, ['msg-1', 'media-1'])
  assert.deepEqual(channel.sent, ['42:here is a file'])
  assert.equal(channel.media.length, 1)
  assert.equal(channel.media[0]!.filePath, 'out.txt')
})

test('ChannelRegistry.deliver degrades media to a text note when unsupported (no path leak)', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  const channel = new FakeChannel() // supportsMedia=false
  root.channels.register(channel)

  const receipt = await root.channels.deliver({
    channel: 'fake',
    chatKey: '42',
    markdown: 'here is a file',
    deliveryKey: 'k1',
    media: [{ kind: 'document', filePath: '/secret/host/path.txt' }],
  })
  assert.equal(receipt.status, 'sent')
  assert.equal(channel.sent.length, 2)
  assert.equal(channel.sent[1], '42:⚠️ Could not deliver the file attachment.')
  assert.ok(!channel.sent[1]!.includes('/secret/host'))
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
