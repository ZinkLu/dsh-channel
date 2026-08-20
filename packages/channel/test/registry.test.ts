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

test('Channel ackInbound defaults to false (nothing shown) and never throws', async () => {
  const channel = new FakeChannel()
  assert.equal(await channel.ackInbound('42', 'm1'), false)
})

class AckChannel extends FakeChannel {
  readonly acked: Array<{ chatKey: string; messageId: string }> = []
  async ackInbound(chatKey: string, messageId: string): Promise<boolean> {
    this.acked.push({ chatKey, messageId })
    return true
  }
}

test('a platform with a cheap ack implements ackInbound and reports true', async () => {
  const channel = new AckChannel()
  assert.equal(await channel.ackInbound('42', 'm1'), true)
  assert.deepEqual(channel.acked, [{ chatKey: '42', messageId: 'm1' }])
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

class AccountedChannel extends FakeChannel {
  private readonly account: string
  constructor(account: string) {
    super()
    this.account = account
  }
  get accountId(): string {
    return this.account
  }
}

test('ChannelRegistry allows multiple accounts of the same provider id', async () => {
  const root = new Context()
  new ChannelRegistry(root)
  const prod = new AccountedChannel('prod')
  const staging = new AccountedChannel('staging')
  root.channels.register(prod)
  root.channels.register(staging)

  assert.equal(root.channels.get('fake', 'prod'), prod)
  assert.equal(root.channels.get('fake', 'staging'), staging)
  assert.equal(root.channels.get('fake'), undefined) // no 'default' instance registered
  assert.equal(root.channels.list().length, 2)

  // Deliver routes by accountId.
  const receipt = await root.channels.deliver({ channel: 'fake', accountId: 'staging', chatKey: '7', markdown: 'hi', deliveryKey: 'k1' })
  assert.equal(receipt.status, 'sent')
  assert.deepEqual(staging.sent, ['7:hi'])
  assert.equal(prod.sent.length, 0)
})

test('ChannelRegistry rejects a duplicate (id, accountId)', () => {
  const root = new Context()
  new ChannelRegistry(root)
  root.channels.register(new AccountedChannel('prod'))
  assert.throws(() => root.channels.register(new AccountedChannel('prod')), /already registered/)
})

test('ChannelRegistry.bindChatKey/chatKeyOf expose the proactive-push binding', () => {
  const root = new Context()
  new ChannelRegistry(root)
  assert.equal(root.channels.chatKeyOf('sess-1'), undefined)
  root.channels.bindChatKey('sess-1', 'telegram', '42', 'prod')
  assert.deepEqual(root.channels.chatKeyOf('sess-1'), { channel: 'telegram', accountId: 'prod', chatKey: '42' })
  // default account omits accountId from the binding
  root.channels.bindChatKey('sess-2', 'telegram', '7')
  assert.deepEqual(root.channels.chatKeyOf('sess-2'), { channel: 'telegram', chatKey: '7' })
})

test('presentation capability facts default conservatively and reconcile returns unknown', async () => {
  const channel = new FakeChannel()
  assert.equal(channel.supportsReply, false)
  assert.equal(channel.supportsThreads, false)
  assert.equal(channel.supportsSilent, false)
  assert.equal(channel.supportsReconciliation, false)
  assert.equal(await channel.reconcile('42', 'k1', 'hash'), 'unknown')
})
