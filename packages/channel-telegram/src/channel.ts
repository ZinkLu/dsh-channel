import { Channel, type ChatType, type OutboundChoice, type OutboundMedia, type PresentationLimits } from 'dsh-channel'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { TelegramClient } from './client.js'

export interface TelegramChannelOptions {
  /** Re-resolve the token on every send; caching across operations is forbidden. */
  resolveToken: () => Promise<string | undefined>
  client: TelegramClient
  /** Instance discriminator for multi-account deployments (default 'default'). */
  accountId?: string
  /** Image attachment → bytes (the bridge layer wires ctx.attachments.readImage). */
  readImage?: (ref: ImageAttachmentRef) => Promise<Uint8Array>
  /** Document filePath (cwd-relative) → bytes + filename (the bridge layer anchors meta.cwd and validates against path escapes). */
  readFile?: (filePath: string) => Promise<{ bytes: Uint8Array; name: string }>
}

export class TelegramChannel extends Channel {
  readonly id = 'telegram'
  private readonly opts: TelegramChannelOptions
  private readonly account: string

  constructor(opts: TelegramChannelOptions) {
    super()
    this.opts = opts
    this.account = opts.accountId ?? 'default'
  }

  get accountId(): string {
    return this.account
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
  get supportsReactions(): boolean {
    return true
  }
  get supportsReply(): boolean {
    return true
  }
  get supportsSilent(): boolean {
    return true
  }

  async react(chatKey: string, messageId: string, emoji: string): Promise<void> {
    const token = await this.opts.resolveToken()
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured')
    await this.opts.client.setMessageReaction(token, chatKey, Number(messageId), emoji)
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
    opts?: { choices?: readonly OutboundChoice[]; signal?: AbortSignal; replyTo?: string; threadId?: string; silent?: boolean },
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

    const sendOpts = {
      parseMode: 'HTML' as const,
      replyMarkup,
      signal: opts?.signal,
      replyTo: opts?.replyTo !== undefined ? Number(opts.replyTo) : undefined,
      threadId: opts?.threadId !== undefined ? Number(opts.threadId) : undefined,
      disableNotification: opts?.silent ?? false,
    }

    // On HTML send failure, automatically degrade to plain text and retry once.
    try {
      const sent = await this.opts.client.sendMessage(token, chatKey, text, sendOpts)
      return { platformMessageId: String(sent.message_id) }
    } catch (htmlError) {
      const plain = plainTextFallback(text)
      const sent = await this.opts.client.sendMessage(token, chatKey, plain, { ...sendOpts, parseMode: undefined })
      return { platformMessageId: String(sent.message_id) }
    }
  }

  async sendTyping(chatKey: string): Promise<void> {
    const token = await this.opts.resolveToken()
    if (!token) return
    try {
      await this.opts.client.sendChatAction(token, chatKey, 'typing')
    } catch {
      // typing is a decorative action; a failure does not affect the main flow.
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
