import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ChannelBridge, type BridgeConfig, type BridgePolicyOverrides, type ChannelStore } from 'dsh-channel-kit'
import type { InboundMessage } from 'dsh-channel'
import type { FeishuChannel } from './channel.js'
import { CREDENTIAL_FEISHU_APP_ID, CREDENTIAL_FEISHU_APP_SECRET } from './config.js'
import type { FeishuCredentials, FeishuEventV2, FeishuMessageEvent } from './client.js'
import { FeishuWsClient, chatTypeOf, hasMedia, mediaFacts, messageText, senderId } from './client.js'

export interface FeishuBridgeConfig extends BridgeConfig {
  allowedUserIds: string[]
  domain?: 'feishu' | 'lark'
  accountId?: string
  proxyUrl?: string
}

export class FeishuBridge extends ChannelBridge<FeishuBridgeConfig> {
  private readonly source: () => FeishuBridgeConfig
  private readonly wsClient: FeishuWsClient

  /** Unlike Telegram/WeChat, this bridge needs no HTTP client: `FeishuChannel` owns
   *  every outbound call and inbound arrives over the WebSocket it opens here. */
  constructor(
    ctx: Context,
    source: () => FeishuBridgeConfig,
    store: ChannelStore,
    channel: FeishuChannel,
    policies?: BridgePolicyOverrides,
  ) {
    super(ctx, channel, store, policies)
    this.source = source
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
    const appId = await this.ctx.credentials.resolve(credentialRef(CREDENTIAL_FEISHU_APP_ID))
    const appSecret = await this.ctx.credentials.resolve(credentialRef(CREDENTIAL_FEISHU_APP_SECRET))
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

    const chatKey = messageEvent.message?.chat_id ?? ''
    if (!chatKey || !senderId(messageEvent)) return

    await this.handleInbound(this.normalize(messageEvent, chatKey), messageEvent)
  }

  /** Feishu message event → the platform-agnostic inbound shape. */
  private normalize(messageEvent: FeishuMessageEvent, chatKey: string): InboundMessage {
    const message = messageEvent.message
    return {
      channel: 'feishu',
      chatKey,
      senderId: senderId(messageEvent),
      messageId: message?.message_id ?? '',
      chatType: chatTypeOf(messageEvent),
      text: messageText(messageEvent),
      timestamp: message?.create_time ? Number(message.create_time) : Date.now(),
      hasMedia: hasMedia(messageEvent),
      media: mediaFacts(messageEvent),
      mentionsBot: (message?.mentions?.length ?? 0) > 0,
      replyToMessageId: message?.parent_id || undefined,
    }
  }
}
