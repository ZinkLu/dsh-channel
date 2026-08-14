import { Channel, type ChatType, type OutboundChoice } from 'dsh-channel'
import type { TelegramClient } from './client.js'

export interface TelegramChannelOptions {
  /** 每次发送时重新解析 token；禁止跨操作缓存。 */
  resolveToken: () => Promise<string | undefined>
  client: TelegramClient
}

export class TelegramChannel extends Channel {
  readonly id = 'telegram'
  private readonly opts: TelegramChannelOptions

  constructor(opts: TelegramChannelOptions) {
    super()
    this.opts = opts
  }

  get maxMessageChars(): number | undefined {
    return 4096
  }
  get formatTier(): 'plain' | 'markdown' | 'html' {
    return 'html'
  }
  get supportsChoices(): boolean {
    return true
  }
  get supportsEdit(): boolean {
    return true
  }
  get supportsTyping(): boolean {
    return true
  }
  get chatTypes(): readonly ChatType[] {
    return ['direct']
  }

  async send(
    chatKey: string,
    text: string,
    opts?: { choices?: readonly OutboundChoice[]; signal?: AbortSignal },
  ): Promise<{ platformMessageId: string }> {
    const token = await this.opts.resolveToken()
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured')

    const replyMarkup =
      opts?.choices && opts.choices.length > 0
        ? {
            inline_keyboard: [
              opts.choices.map((choice) => ({
                text: choice.label,
                callback_data: choice.id.slice(0, 64),
              })),
            ],
          }
        : undefined

    // HTML 发送失败自动降级纯文本重试一次。
    try {
      const sent = await this.opts.client.sendMessage(token, chatKey, text, { parseMode: 'HTML', replyMarkup, signal: opts?.signal })
      return { platformMessageId: String(sent.message_id) }
    } catch (htmlError) {
      const plain = plainTextFallback(text)
      const sent = await this.opts.client.sendMessage(token, chatKey, plain, { replyMarkup, signal: opts?.signal })
      return { platformMessageId: String(sent.message_id) }
    }
  }

  async sendTyping(chatKey: string): Promise<void> {
    const token = await this.opts.resolveToken()
    if (!token) return
    try {
      await this.opts.client.sendChatAction(token, chatKey, 'typing')
    } catch {
      // typing 是装饰性动作，失败不影响主流程。
    }
  }
}

function plainTextFallback(html: string): string {
  return html
    .replace(/<pre>/g, '\n```\n')
    .replace(/<\/pre>/g, '\n```\n')
    .replace(/<code>/g, '`')
    .replace(/<\/code>/g, '`')
    .replace(/<b>/g, '**')
    .replace(/<\/b>/g, '**')
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '[$2]($1)')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
