import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ChannelBridge, sleepWithAbort, type BridgeConfig, type BridgePolicyOverrides, type ChannelStore } from 'dsh-channel-kit'
import type { InboundMessage } from 'dsh-channel'
import type { WeChatChannel } from './channel.js'
import type { WeixinClient, WeixinMessage } from './client.js'
import { chatTypeOf, hasMedia, mediaFacts, messageText, senderId, toChatKey } from './client.js'

export interface WeChatBridgeConfig extends BridgeConfig {
  allowedUserIds: string[]
  /** iLink bot account id (platform-side); when unset, read from the WECHAT_ACCOUNT_ID credential. */
  platformAccountId?: string
  pollingTimeoutSec: number
  accountId?: string
  proxyUrl?: string
}

export class WeChatBridge extends ChannelBridge<WeChatBridgeConfig> {
  private readonly source: () => WeChatBridgeConfig
  private readonly client: WeixinClient
  private readonly typingTickets = new Map<string, string>()

  private pollAbort: AbortController | null = null
  private pollPromise: Promise<void> | null = null

  constructor(
    ctx: Context,
    source: () => WeChatBridgeConfig,
    store: ChannelStore,
    channel: WeChatChannel,
    client: WeixinClient,
    policies?: BridgePolicyOverrides,
  ) {
    super(ctx, channel, store, policies)
    this.source = source
    this.client = client
  }

  /** Dynamic config read: the settings seam may swap the source at runtime. */
  protected get config(): WeChatBridgeConfig {
    return this.source()
  }

  protected isAllowed(senderId: string): boolean {
    return this.config.allowedUserIds.includes(senderId)
  }

  // ---- transport ----

  protected async connect(): Promise<void> {
    this.pollAbort = new AbortController()
    this.pollPromise = this.pollLoop(this.pollAbort.signal)
  }

  protected async disconnect(): Promise<void> {
    this.pollAbort?.abort()
    if (this.pollPromise) {
      await this.pollPromise.catch(() => {})
      this.pollPromise = null
    }
    this.pollAbort = null
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let syncBuf = ''
    let backoff = 1000
    // Re-announced after every gap, not just the first poll: the kit bridge
    // gates ledger deliveries on `connected`, so a status that never comes back
    // would fail every outbound reply while inbound keeps working.
    let connected = false

    while (!signal.aborted) {
      try {
        const token = await this.requireToken()
        // Margin over the poll window: iLink decides the server-side hold, and a
        // deadline equal to it would kill every idle poll at the wire (the
        // Telegram client had exactly that pathology).
        const response = await this.client.getUpdates(token, {
          syncBuf,
          timeoutMs: this.config.pollingTimeoutSec * 1000 + 10_000,
          signal,
        })

        if (!connected) {
          connected = true
          this.ctx.emit('channel/status', 'wechat', 'connected')
        }

        for (const message of response.msgs ?? []) {
          if (signal.aborted) return
          await this.processMessage(message)
        }
        const nextBuf = String(response.get_updates_buf ?? '')
        if (nextBuf) syncBuf = nextBuf
        backoff = 1000
      } catch (error) {
        if (signal.aborted) return
        connected = false
        this.ctx.emit('channel/status', 'wechat', 'disconnected', error instanceof Error ? error : new Error(String(error)))
        await sleepWithAbort(backoff + Math.random() * 500, signal)
        backoff = Math.min(15_000, backoff * 2)
      }
    }
  }

  private async resolveToken(): Promise<string | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef('WECHAT_TOKEN'))
    return resolved?.value
  }

  private async resolveAccountId(): Promise<string | undefined> {
    if (this.config.platformAccountId) return this.config.platformAccountId
    const resolved = await this.ctx.credentials.resolve(credentialRef('WECHAT_ACCOUNT_ID'))
    return resolved?.value
  }

  private async requireToken(): Promise<string> {
    const token = await this.resolveToken()
    if (!token) throw new Error('WECHAT_TOKEN is not configured')
    return token
  }

  private async processMessage(message: WeixinMessage): Promise<void> {
    const accountId = (await this.resolveAccountId()) ?? ''
    const sender = senderId(message)
    // Self-message loopback guard: our own account's sends replay through getupdates.
    if (!sender || sender === accountId || message.msg_type === 2) return

    const chatKey = toChatKey(message, accountId)
    if (!chatKey) return

    // context_token echo + typing ticket warm-up. Both are idempotent, so they
    // run ahead of the shared pipeline's dedupe rather than needing a hook inside it.
    const contextToken = message.context_token
    if (contextToken) this.client.setContextToken(chatKey, contextToken)
    void this.warmTypingTicket(chatKey, contextToken)

    await this.handleInbound(this.normalize(message, chatKey, accountId), message)
  }

  private async warmTypingTicket(chatKey: string, contextToken?: string): Promise<void> {
    try {
      const token = await this.resolveToken()
      if (!token) return
      const { typingTicket } = await this.client.getConfig(token, chatKey, { contextToken })
      if (typingTicket) this.typingTickets.set(chatKey, typingTicket)
    } catch {
      // If the ticket cannot be obtained, degrade to not sending typing.
    }
  }

  /** iLink message → the platform-agnostic inbound shape. */
  private normalize(message: WeixinMessage, chatKey: string, accountId: string): InboundMessage {
    return {
      channel: 'wechat',
      chatKey,
      senderId: senderId(message),
      messageId: String(message.message_id ?? message.client_id ?? ''),
      chatType: chatTypeOf(message, accountId),
      text: messageText(message),
      timestamp: Date.now(),
      hasMedia: hasMedia(message),
      media: mediaFacts(message),
      // iLink messages carry no mention/at metadata, so group mentions are not observable here (unlike Telegram/Feishu).
      mentionsBot: false,
    }
  }
}
