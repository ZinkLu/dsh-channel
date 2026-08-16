import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { ChannelBridge, DEFAULT_MAX_INBOUND_MEDIA_BYTES, renderForTier, type BridgeConfig, type BridgePolicyOverrides, type ChannelStore } from 'dsh-channel-kit'
import type { InboundMedia, InboundMessage } from 'dsh-channel'
import type { TelegramChannel } from './channel.js'
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage, TelegramPhotoSize } from './client.js'
import { hasMedia, messageText, senderName, toChatKey } from './client.js'

export interface TelegramBridgeConfig extends BridgeConfig {
  allowedUserIds: number[]
  pollingTimeoutSec: number
  maxInboundMediaBytes?: number
  accountId?: string
  proxyUrl?: string
}

/** Minimal duck type for dsh-attachment (optional dependency; when missing, images degrade to fileRef facts). */
interface AttachmentsLike {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRef>
}

export class TelegramBridge extends ChannelBridge<TelegramBridgeConfig> {
  private readonly source: () => TelegramBridgeConfig
  private readonly client: TelegramClient

  private pollAbort: AbortController | null = null
  private pollPromise: Promise<void> | null = null
  private botIdentity: { id: number; username?: string } | undefined
  private botIdentityPromise: Promise<{ id: number; username?: string } | undefined> | null = null

  constructor(
    ctx: Context,
    source: () => TelegramBridgeConfig,
    store: ChannelStore,
    channel: TelegramChannel,
    client: TelegramClient,
    policies?: BridgePolicyOverrides,
  ) {
    super(ctx, channel, store, policies)
    this.source = source
    this.client = client
  }

  /** Dynamic config read: the settings seam may swap the source at runtime. */
  protected get config(): TelegramBridgeConfig {
    return this.source()
  }

  protected get chunkCountBy(): 'codepoint' | 'utf16' {
    return 'utf16'
  }

  protected isAllowed(senderId: string): boolean {
    return this.config.allowedUserIds.includes(Number(senderId))
  }

  // ---- transport ----

  protected async connect(): Promise<void> {
    // Learn the bot's own id/username once up front so group `mentionsBot` can be observed accurately.
    await this.resolveBotIdentity().catch(() => {})
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
    let offset = 0
    let backoff = 1000
    let first = true

    while (!signal.aborted) {
      try {
        const token = await this.resolveToken()
        if (!token) {
          throw new Error('TELEGRAM_BOT_TOKEN is not configured')
        }
        const updates = await this.client.getUpdates(token, {
          offset: offset === 0 ? undefined : offset,
          timeoutSec: this.config.pollingTimeoutSec,
          allowedUpdates: ['message', 'callback_query'],
          signal,
        })

        if (first) {
          first = false
          this.ctx.emit('channel/status', 'telegram', 'connected')
        }

        for (const update of updates) {
          if (signal.aborted) return
          await this.processUpdate(update)
          offset = Math.max(offset, update.update_id + 1)
        }
        backoff = 1000
      } catch (error) {
        if (signal.aborted) return
        this.ctx.emit('channel/status', 'telegram', 'disconnected', error instanceof Error ? error : new Error(String(error)))
        await sleepWithAbort(backoff + Math.random() * 500, signal)
        backoff = Math.min(15_000, backoff * 2)
      }
    }
  }

  private async resolveToken(): Promise<string | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef('TELEGRAM_BOT_TOKEN'))
    return resolved?.value
  }

  private async requireToken(): Promise<string> {
    const token = await this.resolveToken()
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured')
    return token
  }

  /** Resolve (and cache) the bot's own id + username for `mentionsBot` observation. */
  private resolveBotIdentity(): Promise<{ id: number; username?: string } | undefined> {
    if (this.botIdentity !== undefined) return Promise.resolve(this.botIdentity)
    if (this.botIdentityPromise !== null) return this.botIdentityPromise
    this.botIdentityPromise = (async () => {
      try {
        const token = await this.resolveToken()
        if (!token) return undefined
        const me = await this.client.getMe(token)
        this.botIdentity = { id: me.id, username: me.username }
        return this.botIdentity
      } catch {
        return undefined
      } finally {
        this.botIdentityPromise = null
      }
    })()
    return this.botIdentityPromise
  }

  private async processUpdate(update: { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery }): Promise<void> {
    if (update.callback_query) {
      await this.processCallbackQuery(update.callback_query)
      return
    }
    if (update.message) {
      await this.processMessage(update.message)
    }
  }

  private async processMessage(message: TelegramMessage): Promise<void> {
    // Self-message filtering to prevent loopback (this also drops other bots, which v1 does not route).
    if (message.from?.is_bot) return
    await this.handleInbound(this.normalize(message), message)
  }

  /** Telegram update → the platform-agnostic inbound shape. */
  private normalize(message: TelegramMessage): InboundMessage {
    return {
      channel: 'telegram',
      chatKey: toChatKey(message.chat),
      senderId: message.from ? String(message.from.id) : '',
      senderName: senderName(message.from),
      messageId: String(message.message_id),
      // Everything non-private (group/supergroup/channel) is a group fact.
      chatType: message.chat.type === 'private' ? 'direct' : 'group',
      text: messageText(message),
      timestamp: message.date * 1000,
      hasMedia: hasMedia(message),
      media: mediaFacts(message),
      mentionsBot: mentionsBotOf(message, this.botIdentity),
      replyToMessageId: message.reply_to_message ? String(message.reply_to_message.message_id) : undefined,
    }
  }

  /** Download inbound images and store via `ctx.attachments.saveImage` (visible to the model); missing/failure degrades to fileRef facts. */
  protected async downloadInboundImages(message: unknown): Promise<ImageAttachmentRef[]> {
    const msg = message as TelegramMessage
    const photo = largestPhoto(msg.photo)
    if (!photo) return []
    const attachments = this.ctx.get('attachments') as AttachmentsLike | undefined
    if (!attachments) return []

    try {
      const token = await this.requireToken()
      const { bytes } = await this.client.getFile(token, photo.file_id, { maxBytes: this.config.maxInboundMediaBytes ?? DEFAULT_MAX_INBOUND_MEDIA_BYTES })
      const mediaType = sniffImageMediaType(bytes)
      if (!mediaType) return []
      const ref = await attachments.saveImage({ data: bytes, mediaType, name: `telegram-${photo.file_id}` })
      return [ref]
    } catch {
      // A download/store failure does not block the text; the image degrades to a fileRef fact (already emitted by ingest).
      return []
    }
  }

  // ---- drafts (progress streaming) ----

  protected async showDraft(chatKey: string, sessionId: string, text: string): Promise<void> {
    const token = await this.requireToken()
    const html = renderForTier(text, 'html')
    const existing = this.draftMessageIds.get(sessionId)
    if (existing === undefined) {
      const sent = await this.client.sendMessage(token, chatKey, html, { parseMode: 'HTML' })
      this.draftMessageIds.set(sessionId, sent.message_id)
      this.ctx.emit('channel/present', { kind: 'draft-new', channel: 'telegram', chatKey, draftKey: `draft:${sessionId}`, text } satisfies import('dsh-channel').PresentationFrame)
    } else {
      await this.client.editMessageText(token, chatKey, existing, html, { parseMode: 'HTML' })
      this.ctx.emit('channel/present', { kind: 'draft-edit', channel: 'telegram', chatKey, draftKey: `draft:${sessionId}`, editTarget: String(existing), text } satisfies import('dsh-channel').PresentationFrame)
    }
  }

  protected async deleteDraft(chatKey: string, target: string): Promise<void> {
    const token = await this.requireToken()
    await this.client.deleteMessage(token, chatKey, Number(target))
  }

  // ---- callback buttons (approval/prompt) ----

  private async processCallbackQuery(callbackQuery: TelegramCallbackQuery): Promise<void> {
    try {
      await this.client.answerCallbackQuery(await this.requireToken(), callbackQuery.id)
    } catch {
      // Failing to clear the spinner does not block what follows.
    }

    const data = callbackQuery.data ?? ''
    const apprMatch = /^appr:(\d+):([01])$/.exec(data)
    if (apprMatch) {
      const num = Number(apprMatch[1])
      const outcome = apprMatch[2] === '1' ? ('allowed-once' as const) : ('rejected' as const)

      const chatKey = callbackQuery.message ? toChatKey(callbackQuery.message.chat) : undefined
      const messageId = callbackQuery.message?.message_id

      this.resolveApproval(num, outcome)

      if (chatKey && messageId !== undefined) {
        try {
          const token = await this.requireToken()
          await this.client.editMessageText(
            token,
            chatKey,
            messageId,
            outcome === 'allowed-once' ? '✅ Approved' : '⛔ Denied',
            { parseMode: 'HTML' },
          )
        } catch {
          // A failed edit does not block the approval outcome.
        }
      }
      return
    }

    const promptMatch = /^prompt:(\d+):(\d+)$/.exec(data)
    if (promptMatch) {
      const answer = this.handleInboundChoice(data)
      if (answer !== null) {
        const chatKey = callbackQuery.message ? toChatKey(callbackQuery.message.chat) : undefined
        const messageId = callbackQuery.message?.message_id
        if (chatKey && messageId !== undefined) {
          try {
            const token = await this.requireToken()
            const chosen = answer.selected.join(', ') || answer.custom || ''
            await this.client.editMessageText(token, chatKey, messageId, `✅ Selected: ${chosen}`, { parseMode: 'HTML' })
          } catch {
            // A failed edit does not block the reply.
          }
        }
      }
      return
    }
  }
}

// ---- module-level helpers ----

function mediaFacts(message: TelegramMessage): InboundMedia[] {
  const facts: InboundMedia[] = []
  const photo = largestPhoto(message.photo)
  if (photo) facts.push({ kind: 'image', fileRef: photo.file_id, mimeType: 'image/jpeg' })
  if (message.document) facts.push({ kind: 'document', fileRef: message.document.file_id, mimeType: message.document.mime_type, fileName: message.document.file_name })
  if (message.video) facts.push({ kind: 'video', fileRef: message.video.file_id, mimeType: message.video.mime_type })
  if (message.audio) facts.push({ kind: 'audio', fileRef: message.audio.file_id, mimeType: message.audio.mime_type, fileName: message.audio.file_name })
  if (message.voice) facts.push({ kind: 'audio', fileRef: message.voice.file_id, mimeType: message.voice.mime_type })
  return facts
}

function largestPhoto(photo: readonly TelegramPhotoSize[] | undefined): TelegramPhotoSize | undefined {
  if (!photo || photo.length === 0) return undefined
  return photo.reduce((a, b) => ((b.file_size ?? 0) > (a.file_size ?? 0) ? b : a))
}

/** Whether the bot was @-mentioned in a group message (text_mention → bot id, mention → `@username`). */
function mentionsBotOf(message: TelegramMessage, bot: { id: number; username?: string } | undefined): boolean {
  if (!bot) return false
  const text = messageText(message)
  for (const entity of message.entities ?? []) {
    if (entity.type === 'text_mention' && entity.user?.id === bot.id) return true
    if (entity.type === 'mention' && bot.username !== undefined && text.slice(entity.offset, entity.offset + entity.length) === `@${bot.username}`) return true
  }
  return false
}

/** Sniff the image media type from bytes (saveImage needs an exact declaration; detect by magic number). */
function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39)) return 'image/gif'
  return undefined
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
