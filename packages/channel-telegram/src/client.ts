import type { SendErrorKind } from 'dsh-channel'
import { assertMediaWithinLimit, proxiedFetch } from 'dsh-channel-kit'

export interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  username?: string
  first_name?: string
  last_name?: string
  title?: string
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  date: number
  chat: TelegramChat
  text?: string
  caption?: string
  entities?: TelegramEntity[]
  caption_entities?: TelegramEntity[]
  reply_to_message?: { message_id: number }
  reply_markup?: TelegramInlineKeyboardMarkup
  photo?: TelegramPhotoSize[]
  document?: TelegramDocument
  video?: TelegramVideo
  audio?: TelegramAudio
  voice?: TelegramVoice
}

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export interface TelegramDocument {
  file_id: string
  file_unique_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TelegramVideo {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  mime_type?: string
  file_size?: number
}

export interface TelegramAudio {
  file_id: string
  file_unique_id: string
  mime_type?: string
  file_name?: string
  file_size?: number
}

export interface TelegramVoice {
  file_id: string
  file_unique_id: string
  mime_type?: string
  file_size?: number
}

export interface TelegramFile {
  file_id: string
  file_unique_id: string
  file_size?: number
  file_path?: string
}

export interface TelegramEntity {
  type: string
  offset: number
  length: number
  url?: string
  user?: TelegramUser
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

export interface TelegramResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

export interface TelegramClientOptions {
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  /** Outbound HTTP proxy (http://[user:pass@]host:port); wraps the fetch implementation. */
  proxyUrl?: string
}

export class TelegramApiError extends Error {
  readonly description: string | undefined
  readonly errorCode: number | undefined
  constructor(message: string, description?: string, errorCode?: number) {
    super(message)
    this.name = 'TelegramApiError'
    this.description = description
    this.errorCode = errorCode
  }
}

export class TelegramClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: TelegramClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.telegram.org').replace(/\/$/, '')
    const rawFetch = opts.fetch ?? fetch
    this.fetchImpl = opts.proxyUrl ? proxiedFetch(opts.proxyUrl) : rawFetch
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  static redactToken(text: string, token?: string): string {
    if (!token) return text
    return text.split(token).join('<redacted>')
  }

  async getMe(token: string, signal?: AbortSignal): Promise<TelegramUser> {
    return this.callApi(token, 'getMe', undefined, signal)
  }

  async getUpdates(token: string, opts: { offset?: number; timeoutSec?: number; allowedUpdates?: readonly string[]; signal?: AbortSignal } = {}): Promise<TelegramUpdate[]> {
    const query = new URLSearchParams()
    if (opts.offset !== undefined) query.set('offset', String(opts.offset))
    query.set('timeout', String(opts.timeoutSec ?? 30))
    query.set('allowed_updates', JSON.stringify(opts.allowedUpdates ?? ['message', 'callback_query']))
    const result = await this.callApi(token, `getUpdates?${query.toString()}`, undefined, opts.signal)
    return (result as TelegramUpdate[]) ?? []
  }

  async sendMessage(
    token: string,
    chatId: string,
    text: string,
    opts: {
      parseMode?: 'HTML' | 'MarkdownV2'
      replyMarkup?: TelegramInlineKeyboardMarkup
      signal?: AbortSignal
      replyTo?: number
      threadId?: number
      disableNotification?: boolean
    } = {},
  ): Promise<TelegramMessage> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode,
      reply_markup: opts.replyMarkup,
    }
    if (opts.replyTo !== undefined) body.reply_parameters = { message_id: opts.replyTo }
    if (opts.threadId !== undefined) body.message_thread_id = opts.threadId
    if (opts.disableNotification) body.disable_notification = true
    return this.callApi(token, 'sendMessage', body, opts.signal)
  }

  async sendChatAction(token: string, chatId: string, action: string, signal?: AbortSignal): Promise<boolean> {
    return this.callApi(token, 'sendChatAction', { chat_id: chatId, action }, signal)
  }

  async answerCallbackQuery(token: string, callbackQueryId: string, opts: { text?: string; signal?: AbortSignal } = {}): Promise<boolean> {
    return this.callApi(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: opts.text,
    }, opts.signal)
  }

  async editMessageText(
    token: string,
    chatId: string,
    messageId: number,
    text: string,
    opts: { parseMode?: 'HTML' | 'MarkdownV2'; replyMarkup?: TelegramInlineKeyboardMarkup; signal?: AbortSignal } = {},
  ): Promise<TelegramMessage> {
    return this.callApi(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: opts.parseMode,
      reply_markup: opts.replyMarkup,
    }, opts.signal)
  }

  async deleteMessage(token: string, chatId: string, messageId: number, signal?: AbortSignal): Promise<boolean> {
    return this.callApi(token, 'deleteMessage', { chat_id: chatId, message_id: messageId }, signal)
  }

  /**
   * React to a message with an emoji (Telegram setMessageReaction).
   */
  async setMessageReaction(token: string, chatId: string, messageId: number, emoji: string, signal?: AbortSignal): Promise<boolean> {
    return this.callApi(token, 'setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    }, signal)
  }

  /**
   * Fetch the file bytes for a file_id (getFile returns file_path → download from the file endpoint).
   * The body is read incrementally and aborted as soon as it exceeds `opts.maxBytes`
   * (Content-Length first, then the running byte count) so an oversized payload is
   * rejected before it is fully buffered.
   */
  async getFile(
    token: string,
    fileId: string,
    opts: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<{ bytes: Uint8Array; filePath: string }> {
    const file = await this.callApi<TelegramFile>(token, 'getFile', { file_id: fileId }, opts.signal)
    if (!file.file_path) throw new TelegramApiError(TelegramClient.redactToken('telegram getFile returned no file_path', token))
    const url = `${this.baseUrl}/file/bot${token}/${file.file_path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`telegram download timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
    timer.unref?.()
    const onOuterAbort = () => controller.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal })
      if (!response.ok) throw new TelegramApiError(TelegramClient.redactToken(`telegram download failed: HTTP ${response.status}`, token))
      const bytes = await readBodyWithLimit(response, opts.maxBytes ?? 0, 'telegram media')
      return { bytes, filePath: file.file_path }
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  /** Upload and send an image (multipart/form-data). */
  async sendPhoto(
    token: string,
    chatId: string,
    photo: Uint8Array,
    opts: { caption?: string; fileName?: string; signal?: AbortSignal } = {},
  ): Promise<TelegramMessage> {
    return this.callApiMultipart<TelegramMessage>(token, 'sendPhoto', chatId, 'photo', photo, opts.fileName ?? 'photo.jpg', 'image/jpeg', opts.caption, opts.signal)
  }

  /** Upload and send a document (multipart/form-data). */
  async sendDocument(
    token: string,
    chatId: string,
    document: Uint8Array,
    opts: { caption?: string; fileName?: string; mimeType?: string; signal?: AbortSignal } = {},
  ): Promise<TelegramMessage> {
    return this.callApiMultipart<TelegramMessage>(token, 'sendDocument', chatId, 'document', document, opts.fileName ?? 'document.bin', opts.mimeType ?? 'application/octet-stream', opts.caption, opts.signal)
  }

  private async callApiMultipart<T>(
    token: string,
    method: string,
    chatId: string,
    field: string,
    bytes: Uint8Array,
    fileName: string,
    mimeType: string,
    caption: string | undefined,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.baseUrl}/bot${token}/${method}`
    const form = new FormData()
    form.set('chat_id', chatId)
    form.set(field, new Blob([bytes as BlobPart], { type: mimeType }), fileName)
    if (caption !== undefined && caption !== '') {
      form.set('caption', caption)
      form.set('parse_mode', 'HTML')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`telegram api timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
    timer.unref?.()
    const onOuterAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onOuterAbort, { once: true })

    try {
      const response = await this.fetchImpl(url, { method: 'POST', body: form, signal: controller.signal })
      const payload = (await response.json()) as TelegramResponse<T>
      if (!payload.ok) {
        throw new TelegramApiError(
          TelegramClient.redactToken(`telegram api ${method} failed: ${payload.description ?? 'unknown error'}`, token),
          payload.description,
          payload.error_code,
        )
      }
      return payload.result as T
    } catch (error) {
      if (error instanceof TelegramApiError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new TelegramApiError(TelegramClient.redactToken(`telegram api ${method} request failed: ${message}`, token))
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  private async callApi<T>(token: string, method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}/bot${token}/${method}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`telegram api timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
    timer.unref?.()
    const onOuterAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onOuterAbort, { once: true })

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const payload = (await response.json()) as TelegramResponse<T>
      if (!payload.ok) {
        throw new TelegramApiError(
          TelegramClient.redactToken(`telegram api ${method} failed: ${payload.description ?? 'unknown error'}`, token),
          payload.description,
          payload.error_code,
        )
      }
      return payload.result as T
    } catch (error) {
      if (error instanceof TelegramApiError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new TelegramApiError(TelegramClient.redactToken(`telegram api ${method} request failed: ${message}`, token))
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
    }
  }
}

/** Stream a response body into bytes, aborting as soon as it exceeds `maxBytes` (0/undefined = no limit). */
async function readBodyWithLimit(response: Response, maxBytes: number, kind: string): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(contentLength) && contentLength > 0) {
    assertMediaWithinLimit(contentLength, maxBytes, kind)
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    assertMediaWithinLimit(bytes.length, maxBytes, kind)
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      assertMediaWithinLimit(total, maxBytes, kind)
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export interface ClassifiedSendError {
  errorKind: SendErrorKind
  retryAfterMs?: number
}

/**
 * Telegram send-error classification table (hermes platforms/base.py:2484-2520,
 * adapted to Bot API error_code + description). `not_found` is split by blast
 * radius in the caller when it has both a chat and an edit target.
 */
export function classifyTelegramSendError(error: TelegramApiError): ClassifiedSendError {
  const code = error.errorCode
  const description = (error.description ?? error.message).toLowerCase()

  if (code === 429 || description.includes('retry after') || description.includes('too many requests')) {
    return { errorKind: 'rate_limited', retryAfterMs: parseRetryAfterMs(error.message) }
  }
  if (code === 403 || description.includes('forbidden') || description.includes('bot was blocked') || description.includes('user is deactivated') || description.includes('bot was kicked')) {
    return { errorKind: 'forbidden' }
  }
  if (code === 401) {
    return { errorKind: 'forbidden' }
  }
  if (code === 400) {
    if (description.includes('chat not found') || description.includes('message not found') || description.includes('message to edit not found') || description.includes('message_id not found') || description.includes("message can't be deleted")) {
      return { errorKind: 'not_found' }
    }
    if (description.includes('too long') || description.includes('too many characters')) {
      return { errorKind: 'too_long' }
    }
    if (description.includes('parse') || description.includes('format') || description.includes("can't use this syntax") || description.includes('unsupported parse')) {
      return { errorKind: 'bad_format' }
    }
    if (description.includes('not enough rights') || description.includes('have no rights')) {
      return { errorKind: 'forbidden' }
    }
  }
  if (code !== undefined && code >= 500) {
    return { errorKind: 'transient' }
  }
  return { errorKind: 'unknown' }
}

function parseRetryAfterMs(message: string): number | undefined {
  const match = /retry after (\d+)/i.exec(message)
  if (!match) return undefined
  const seconds = Number(match[1])
  return Number.isFinite(seconds) ? seconds * 1000 : undefined
}

export function toChatKey(chat: TelegramChat): string {
  return String(chat.id)
}

export function senderName(user: TelegramUser | undefined): string | undefined {
  if (!user) return undefined
  return user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(' ') || undefined
}

export function messageText(message: TelegramMessage): string {
  return message.text ?? message.caption ?? ''
}

export function hasMedia(message: TelegramMessage): boolean {
  return message.caption !== undefined || 'photo' in message || 'document' in message || 'video' in message || 'audio' in message || 'voice' in message
}
