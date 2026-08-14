import { Channel, type ChatType, type OutboundChoice } from 'dsh-channel'
import type { WeixinClient } from './client.js'

export interface WeChatChannelOptions {
  /** 每次发送时重新解析 token；禁止跨操作缓存。 */
  resolveToken: () => Promise<string | undefined>
  /** typing ticket 解析（sendtyping 需要）；拿不到就静默降级为 no-op。 */
  resolveTypingTicket?: (chatKey: string) => Promise<string | undefined>
  client: WeixinClient
}

export class WeChatChannel extends Channel {
  readonly id = 'wechat'
  private readonly opts: WeChatChannelOptions

  constructor(opts: WeChatChannelOptions) {
    super()
    this.opts = opts
  }

  // WeChat iLink 单条文本上限（hermes weixin MAX_MESSAGE_LENGTH=2000）。
  get maxMessageChars(): number | undefined {
    return 2000
  }
  // WeChat 客户端能渲染 markdown（围栏代码块/标题/表格），故原样透传，不做降级。
  get formatTier(): 'plain' | 'markdown' | 'html' {
    return 'markdown'
  }
  // iLink 文本消息没有内联按钮，审批/提问一律走编号文本回退。
  get supportsChoices(): boolean {
    return false
  }
  // 微信不支持编辑已发消息（hermes SUPPORTS_MESSAGE_EDITING=False）。
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
      // typing 是装饰性动作，失败不影响主流程。
    }
  }
}
