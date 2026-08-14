import { Channel, type ChatType, type OutboundChoice, type OutboundMedia, type PresentationLimits } from 'dsh-channel'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { TelegramClient } from './client.js'

export interface TelegramChannelOptions {
  /** 每次发送时重新解析 token；禁止跨操作缓存。 */
  resolveToken: () => Promise<string | undefined>
  client: TelegramClient
  /** 图片 attachment → 字节（桥接层接 ctx.attachments.readImage）。 */
  readImage?: (ref: ImageAttachmentRef) => Promise<Uint8Array>
  /** 文档 filePath（cwd 相对路径）→ 字节 + 文件名（桥接层锚定 meta.cwd 并做越界校验）。 */
  readFile?: (filePath: string) => Promise<{ bytes: Uint8Array; name: string }>
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
  get streamingMode(): 'off' | 'block' | 'progress' {
    return 'progress'
  }
  get supportsStatusText(): boolean {
    return false
  }
  get supportsThinking(): boolean {
    return false
  }
  get presentationLimits(): PresentationLimits {
    return { maxValueBytes: 64 }
  }
  get supportsMultiSelect(): boolean {
    return false
  }
  get supportsMedia(): boolean {
    return true
  }

  async sendMedia(
    chatKey: string,
    media: OutboundMedia,
    opts?: { signal?: AbortSignal },
  ): Promise<{ platformMessageId: string }> {
    const token = await this.opts.resolveToken()
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured')

    if (media.kind === 'image') {
      const bytes = media.attachment !== undefined
        ? await this.readImageOrThrow(media.attachment)
        : media.filePath !== undefined
          ? (await this.readFileOrThrow(media.filePath)).bytes
          : undefined
      if (!bytes) throw new Error('telegram sendMedia image requires attachment or filePath')
      const sent = await this.opts.client.sendPhoto(token, chatKey, bytes, { caption: media.caption, signal: opts?.signal })
      return { platformMessageId: String(sent.message_id) }
    }

    if (media.filePath === undefined) throw new Error('telegram sendMedia document requires filePath')
    const file = await this.readFileOrThrow(media.filePath)
    const sent = await this.opts.client.sendDocument(token, chatKey, file.bytes, { caption: media.caption, fileName: file.name, signal: opts?.signal })
    return { platformMessageId: String(sent.message_id) }
  }

  private async readImageOrThrow(ref: ImageAttachmentRef): Promise<Uint8Array> {
    if (this.opts.readImage === undefined) throw new Error('telegram sendMedia image requires readImage resolver')
    return this.opts.readImage(ref)
  }

  private async readFileOrThrow(filePath: string): Promise<{ bytes: Uint8Array; name: string }> {
    if (this.opts.readFile === undefined) throw new Error('telegram sendMedia document requires readFile resolver')
    return this.opts.readFile(filePath)
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
