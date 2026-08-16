import { Channel, type ChatType, type OutboundChoice } from 'dsh-channel'
import type { WeixinClient } from './client.js'

export interface WeChatChannelOptions {
  /** Resolve the token on every send; caching across operations is forbidden. */
  resolveToken: () => Promise<string | undefined>
  /** Resolves the typing ticket (required by sendtyping); when unavailable, silently degrade to a no-op. */
  resolveTypingTicket?: (chatKey: string) => Promise<string | undefined>
  client: WeixinClient
  /** Instance discriminator for multi-account deployments (default 'default'). */
  accountId?: string
}

export class WeChatChannel extends Channel {
  readonly id = 'wechat'
  private readonly opts: WeChatChannelOptions
  private readonly account: string

  constructor(opts: WeChatChannelOptions) {
    super()
    this.opts = opts
    this.account = opts.accountId ?? 'default'
  }

  get accountId(): string {
    return this.account
  }

  // WeChat iLink per-message text limit (hermes weixin MAX_MESSAGE_LENGTH=2000).
  get maxMessageChars(): number | undefined {
    return 2000
  }
  // The WeChat client can render markdown (fenced code blocks / headings / tables), so pass it through unchanged without degrading.
  get formatTier(): 'plain' | 'markdown' | 'html' {
    return 'markdown'
  }
  // iLink text messages have no inline buttons, so approvals/prompts always fall back to numbered text.
  get supportsChoices(): boolean {
    return false
  }
  // WeChat does not support editing sent messages (hermes SUPPORTS_MESSAGE_EDITING=False).
  get supportsEdit(): boolean {
    return false
  }
  get supportsTyping(): boolean {
    return true
  }
  get chatTypes(): readonly ChatType[] {
    return ['direct']
  }
  get streamingMode(): 'off' | 'block' | 'progress' {
    return 'off'
  }
  get supportsStatusText(): boolean {
    return false
  }
  get supportsThinking(): boolean {
    return false
  }
  get supportsMultiSelect(): boolean {
    return false
  }

  async send(
    chatKey: string,
    text: string,
    _opts?: { choices?: readonly OutboundChoice[]; signal?: AbortSignal },
  ): Promise<{ platformMessageId: string }> {
    const token = await this.opts.resolveToken()
    if (!token) throw new Error('WECHAT_TOKEN is not configured')

    const sent = await this.opts.client.sendMessage(token, chatKey, text, { signal: _opts?.signal })
    return { platformMessageId: sent.client_id ?? sent.message_id ?? '' }
  }

  async sendTyping(chatKey: string): Promise<void> {
    const token = await this.opts.resolveToken()
    if (!token || this.opts.resolveTypingTicket === undefined) return
    try {
      const ticket = await this.opts.resolveTypingTicket(chatKey)
      if (!ticket) return
      await this.opts.client.sendTyping(token, chatKey, ticket, 1)
    } catch {
      // typing is a decorative action; its failure does not affect the main flow.
    }
  }
}
