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
    this.fetchImpl = opts.fetch ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  static redactToken(text: string, token?: string): string {
    if (!token) return text
    return text.split(token).join('<redacted>')
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
    opts: { parseMode?: 'HTML' | 'MarkdownV2'; replyMarkup?: TelegramInlineKeyboardMarkup; signal?: AbortSignal } = {},
  ): Promise<TelegramMessage> {
    return this.callApi(token, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode,
      reply_markup: opts.replyMarkup,
    }, opts.signal)
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

  /** 取 file_id 对应的文件字节（getFile 拿 file_path → 从 file 端点下载）。 */
  async getFile(token: string, fileId: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; filePath: string }> {
    const file = await this.callApi<TelegramFile>(token, 'getFile', { file_id: fileId }, signal)
    if (!file.file_path) throw new TelegramApiError(TelegramClient.redactToken('telegram getFile returned no file_path', token))
    const url = `${this.baseUrl}/file/bot${token}/${file.file_path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`telegram download timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
    timer.unref?.()
    const onOuterAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onOuterAbort, { once: true })
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal })
      if (!response.ok) throw new TelegramApiError(TelegramClient.redactToken(`telegram download failed: HTTP ${response.status}`, token))
      const bytes = new Uint8Array(await response.arrayBuffer())
      return { bytes, filePath: file.file_path }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  /** 上传并发送一张图片（multipart/form-data）。 */
  async sendPhoto(
    token: string,
    chatId: string,
    photo: Uint8Array,
    opts: { caption?: string; fileName?: string; signal?: AbortSignal } = {},
  ): Promise<TelegramMessage> {
    return this.callApiMultipart<TelegramMessage>(token, 'sendPhoto', chatId, 'photo', photo, opts.fileName ?? 'photo.jpg', 'image/jpeg', opts.caption, opts.signal)
  }

  /** 上传并发送一个文档（multipart/form-data）。 */
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
