import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ChannelBridge, type BridgeConfig, type BridgePolicyOverrides, type ChannelStore } from 'dsh-channel-kit'
import type { InboundMessage } from 'dsh-channel'
import type { FeishuChannel } from './channel.js'
import type { FeishuCredentials, FeishuEventV2, FeishuMessageEvent } from './client.js'
import { FeishuClient, FeishuWsClient, chatTypeOf, hasMedia, mediaFacts, messageText, senderId } from './client.js'

export interface FeishuBridgeConfig extends BridgeConfig {
  allowedUserIds: string[]
  domain?: 'feishu' | 'lark'
  accountId?: string
  proxyUrl?: string
}

export class FeishuBridge extends ChannelBridge<FeishuBridgeConfig> {
  private readonly source: () => FeishuBridgeConfig
  private readonly client: FeishuClient
  private readonly wsClient: FeishuWsClient

  constructor(
    ctx: Context,
    source: () => FeishuBridgeConfig,
    store: ChannelStore,
    channel: FeishuChannel,
    client: FeishuClient,
    policies?: BridgePolicyOverrides,
  ) {
    super(ctx, channel, store, policies)
    this.source = source
    this.client = client
    this.wsClient = new FeishuWsClient({
      domain: source().domain,
      resolveCredentials: () => this.resolveCredentials(),
      onEvent: (event) => void this.handleEvent(event),
      onStatus: (status, error) => this.ctx.emit('channel/status', 'feishu', status, error),
    })
  }

  /** Dynamic config read: the settings seam may swap the source at runtime. */
  protected get config(): FeishuBridgeConfig {
    return this.source()
  }

  protected isAllowed(senderId: string): boolean {
    return this.config.allowedUserIds.includes(senderId)
  }

  // ---- transport ----

  protected async connect(): Promise<void> {
    await this.wsClient.start()
  }

  protected async disconnect(): Promise<void> {
    await this.wsClient.stop()
  }

  private async resolveCredentials(): Promise<FeishuCredentials | undefined> {
    const appId = await this.ctx.credentials.resolve(credentialRef('FEISHU_APP_ID'))
    const appSecret = await this.ctx.credentials.resolve(credentialRef('FEISHU_APP_SECRET'))
    if (!appId?.value || !appSecret?.value) return undefined
    return { appId: appId.value, appSecret: appSecret.value }
  }

  // ---- inbound ----

  /**
   * Unified inbound event entry point: called internally by the long-connection client;
   * the host may also feed events directly in webhook mode.
   * Only `im.message.receive_v1` text events are processed; other event types are silently ignored.
   */
  async handleEvent(event: FeishuEventV2): Promise<void> {
    if (event.header?.event_type !== 'im.message.receive_v1' || event.event === undefined) return
    const messageEvent: FeishuMessageEvent = event.event

    const message = messageEvent.message
    const chatKey = message?.chat_id ?? ''
    const sender = senderId(messageEvent)
    if (!chatKey || !sender) return

    const chatType = chatTypeOf(messageEvent)
    const messageId = message?.message_id ?? ''

    // Group chats are not routed in v1, but capability facts are still emitted.
    if (chatType !== 'direct') {
      this.ingest(messageEvent, chatKey, 'group')
      return
    }

    if (!this.isAllowed(sender)) {
      await this.sendLocal(chatKey, '⚠️ You are not authorized to use this bot.')
      return
    }

    if (messageId) {
      if (this.isOwnEcho(chatKey, messageId)) return
      if (this.store.seenInbound(messageId)) return
      this.store.markInbound(messageId, 'handling')
    }

    // Approval/question replies take precedence over merge/router (openclaw control-command iron rule).
    const text = messageText(messageEvent)
    if (await this.handleInboundReply(text)) {
      if (messageId) this.store.markInbound(messageId, 'done')
      return
    }

    const isCommand = text.trim().startsWith('/')

    this.ingest(messageEvent, chatKey, 'direct')

    if (isCommand) {
      await this.flushBuffered(chatKey)
      await this.handleCommand(text.trim(), chatKey)
      if (messageId) this.store.markInbound(messageId, 'done')
      return
    }

    if (hasMedia(messageEvent)) {
      await this.flushBuffered(chatKey)
      if (text.trim() !== '') {
        await this.dispatchText(chatKey, text, [messageId].filter(Boolean), sender)
      }
      if (messageId) this.store.markInbound(messageId, 'done')
      return
    }

    if (text.trim() === '') {
      if (messageId) this.store.markInbound(messageId, 'done')
      return
    }

    await this.mergeMessage(chatKey, text, messageId, sender)
    if (messageId) this.store.markInbound(messageId, 'done')
  }

  private ingest(messageEvent: FeishuMessageEvent, chatKey: string, chatType: 'direct' | 'group'): void {
    const message = messageEvent.message
    const inbound: InboundMessage = {
      channel: 'feishu',
      chatKey,
      senderId: senderId(messageEvent),
      messageId: message?.message_id ?? '',
      chatType,
      text: messageText(messageEvent),
      timestamp: message?.create_time ? Number(message.create_time) : Date.now(),
      hasMedia: hasMedia(messageEvent),
      media: mediaFacts(messageEvent),
      mentionsBot: (message?.mentions?.length ?? 0) > 0,
      replyToMessageId: message?.parent_id || undefined,
    }
    this.ctx.channels.ingest(inbound)
  }
}
