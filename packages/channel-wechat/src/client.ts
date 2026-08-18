import { randomBytes } from 'node:crypto'
import type { SendErrorKind } from 'dsh-channel'
import { proxiedFetch } from 'dsh-channel-kit'

/**
 * WeChat (WeChat) iLink Bot API client.
 *
 * WeChat has no public Bot API like Telegram's; this provider uses Tencent's
 * **iLink Bot API** (`https://ilinkai.weixin.qq.com`), long-polling inbound messages
 * with `getupdates` — hence it maps almost one-to-one to Telegram's `getUpdates`, and
 * the bridge can fully reuse the same orchestration (merge / route / approval / ledger),
 * swapping only the transport and capability facts.
 */

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const CHANNEL_VERSION = '2.2.0'
const APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0
const APP_ID = 'bot'

const ITEM_TEXT = 1
const ITEM_IMAGE = 2
const ITEM_VOICE = 3
const ITEM_FILE = 4
const ITEM_VIDEO = 5

const MSG_TYPE_USER = 1
const MSG_TYPE_BOT = 2
const MSG_STATE_FINISH = 2

export interface WeixinTextItem {
  type: 1
  text_item?: { text?: string }
}

export interface WeixinMediaRef {
  filekey?: string
  encrypted_query_param?: string
  full_url?: string
  filename?: string
}

export interface WeixinItem {
  type?: number
  text_item?: { text?: string }
  image_item?: { media?: WeixinMediaRef }
  voice_item?: { media?: WeixinMediaRef }
  file_item?: { media?: WeixinMediaRef }
  video_item?: { media?: WeixinMediaRef }
}

/** Platform-independent media facts (isomorphic to dsh-channel's InboundMedia; the client does not depend on the contract package). */
export interface WeixinMedia {
  kind: 'image' | 'document' | 'audio' | 'video'
  fileRef: string
  mimeType?: string
  fileName?: string
}

export interface WeixinMessage {
  from_user_id?: string
  to_user_id?: string
  message_id?: string
  client_id?: string
  msg_type?: number
  message_state?: number
  context_token?: string
  room_id?: string
  chat_room_id?: string
  item_list?: WeixinItem[]
}

export interface WeixinGetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface WeixinSendResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  message_id?: string
  client_id?: string
}

export interface WeixinClientOptions {
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  /** Outbound HTTP proxy (http://[user:pass@]host:port); wraps the fetch implementation. */
  proxyUrl?: string
}

export class WeixinApiError extends Error {
  readonly errcode: number | undefined
  readonly errmsg: string | undefined
  constructor(message: string, errcode?: number, errmsg?: string) {
    super(message)
    this.name = 'WeixinApiError'
    this.errcode = errcode
    this.errmsg = errmsg
  }
}

export interface ClassifiedSendError {
  errorKind: SendErrorKind
  retryAfterMs?: number
}

/** iLink/WeChat send-error classification. Conservative: unknown codes stay unknown (retryable). */
export function classifyWeChatSendError(error: WeixinApiError): ClassifiedSendError {
  const code = error.errcode
  if (code === 40001 || code === 40014 || code === 42001 || code === 40003) {
    return { errorKind: 'forbidden' }
  }
  if (code === 45009 || code === 45008 || code === 45006) {
    return { errorKind: 'rate_limited' }
  }
  if (code === 10001 || code === 10002 || code === 10003) {
    return { errorKind: 'too_long' }
  }
  if (code === -1 || code === 40097) {
    return { errorKind: 'transient' }
  }
  return { errorKind: 'unknown' }
}

export class WeixinClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  /** peer chatKey → most recent inbound context_token (needed to address replies to that peer). */
  private readonly contextTokens = new Map<string, string>()

  constructor(opts: WeixinClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    const rawFetch = opts.fetch ?? fetch
    this.fetchImpl = opts.proxyUrl ? proxiedFetch(opts.proxyUrl) : rawFetch
    this.timeoutMs = opts.timeoutMs ?? 35_000
  }

  static redactToken(text: string, token?: string): string {
    if (!token) return text
    return text.split(token).join('<redacted>')
  }

  /** Record the peer's context_token on inbound and echo it on outbound replies to keep the session continuous. */
  setContextToken(chatKey: string, token: string | undefined): void {
    if (token) this.contextTokens.set(chatKey, token)
  }

  contextToken(chatKey: string): string | undefined {
    return this.contextTokens.get(chatKey)
  }

  async getUpdates(
    token: string,
    opts: { syncBuf?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<WeixinGetUpdatesResponse> {
    const result = await this.callApi<WeixinGetUpdatesResponse>(token, 'ilink/bot/getupdates', {
      get_updates_buf: opts.syncBuf ?? '',
    }, { timeoutMs: opts.timeoutMs ?? 35_000, signal: opts.signal })
    return result
  }

  async sendMessage(
    token: string,
    chatKey: string,
    text: string,
    opts: { contextToken?: string; signal?: AbortSignal } = {},
  ): Promise<WeixinSendResponse> {
    const message: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: chatKey,
      client_id: `dsh-wechat-${randomBytes(16).toString('hex')}`,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_TEXT, text_item: { text } }],
    }
    const contextToken = opts.contextToken ?? this.contextToken(chatKey)
    if (contextToken) message['context_token'] = contextToken

    return this.callApi<WeixinSendResponse>(token, 'ilink/bot/sendmessage', { msg: message }, { timeoutMs: 15_000, signal: opts.signal })
  }

  async sendTyping(
    token: string,
    chatKey: string,
    typingTicket: string,
    status: 1 | 2,
    signal?: AbortSignal,
  ): Promise<WeixinSendResponse> {
    return this.callApi<WeixinSendResponse>(token, 'ilink/bot/sendtyping', {
      ilink_user_id: chatKey,
      typing_ticket: typingTicket,
      status,
    }, { timeoutMs: 10_000, signal })
  }

  /** Fetch the peer's typing ticket (required by sendtyping). */
  async getConfig(
    token: string,
    chatKey: string,
    opts: { contextToken?: string; signal?: AbortSignal } = {},
  ): Promise<{ typingTicket?: string }> {
    const payload: Record<string, unknown> = { ilink_user_id: chatKey }
    const contextToken = opts.contextToken ?? this.contextToken(chatKey)
    if (contextToken) payload['context_token'] = contextToken
    const result = await this.callApi<{ typing_ticket?: string; ret?: number; errcode?: number; errmsg?: string }>(
      token,
      'ilink/bot/getconfig',
      payload,
      { timeoutMs: 10_000, signal: opts.signal },
    )
    return { typingTicket: result.typing_ticket }
  }

  private async callApi<T extends { ret?: number; errcode?: number; errmsg?: string }>(
    token: string,
    endpoint: string,
    payload: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}/${endpoint}`
    const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`weixin api timeout after ${opts.timeoutMs ?? 30_000}ms`)), opts.timeoutMs ?? 30_000)
    timer.unref?.()
    const onOuterAbort = () => controller.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true })

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'AuthorizationType': 'ilink_bot_token',
          'Content-Length': String(Buffer.byteLength(body, 'utf8')),
          'X-WECHAT-UIN': randomWechatUin(),
          'iLink-App-Id': APP_ID,
          'iLink-App-ClientVersion': String(APP_CLIENT_VERSION),
        },
        body,
        signal: controller.signal,
      })
      const payload = (await response.json()) as T
      const errcode = payload.errcode ?? payload.ret
      if (response.ok && (errcode === undefined || errcode === 0)) return payload
      throw new WeixinApiError(
        WeixinClient.redactToken(`weixin api ${endpoint} failed: ${payload.errmsg ?? `HTTP ${response.status}`}`, token),
        payload.errcode,
        payload.errmsg,
      )
    } catch (error) {
      if (error instanceof WeixinApiError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new WeixinApiError(WeixinClient.redactToken(`weixin api ${endpoint} request failed: ${message}`, token))
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onOuterAbort)
    }
  }
}

function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64')
}

export function toChatKey(message: WeixinMessage, accountId: string): string {
  const roomId = String(message.room_id ?? message.chat_room_id ?? '').trim()
  if (roomId) return roomId
  return String(message.from_user_id ?? '').trim()
}

export function chatTypeOf(message: WeixinMessage, accountId: string): 'direct' | 'group' {
  const roomId = String(message.room_id ?? message.chat_room_id ?? '').trim()
  if (roomId) return 'group'
  const toUserId = String(message.to_user_id ?? '').trim()
  // Treat as a group chat when to_user_id is not self and it is a user message.
  if (toUserId && accountId && toUserId !== accountId && message.msg_type === MSG_TYPE_USER) return 'group'
  return 'direct'
}

export function senderId(message: WeixinMessage): string {
  return String(message.from_user_id ?? '').trim()
}

export function messageText(message: WeixinMessage): string {
  let text = ''
  for (const item of message.item_list ?? []) {
    if (item.type === ITEM_TEXT) text += item.text_item?.text ?? ''
  }
  return text
}

export function hasMedia(message: WeixinMessage): boolean {
  return (message.item_list ?? []).some((item) => item.type !== undefined && item.type !== ITEM_TEXT)
}

/** Inbound media facts (fileRef is an iLink CDN reference; v1 does not download bytes, only hands them over). */
export function mediaFacts(message: WeixinMessage): WeixinMedia[] {
  const facts: WeixinMedia[] = []
  for (const item of message.item_list ?? []) {
    const kind = kindOf(item.type)
    if (kind === undefined) continue
    const media = mediaOf(item)
    const fileRef = media?.filekey ?? media?.encrypted_query_param ?? media?.full_url ?? `weixin:${item.type}:${facts.length}`
    facts.push({ kind, fileRef, fileName: media?.filename })
  }
  return facts
}

function kindOf(type: number | undefined): WeixinMedia['kind'] | undefined {
  switch (type) {
    case ITEM_IMAGE:
      return 'image'
    case ITEM_FILE:
      return 'document'
    case ITEM_VOICE:
      return 'audio'
    case ITEM_VIDEO:
      return 'video'
    default:
      return undefined
  }
}

function mediaOf(item: WeixinItem): WeixinMediaRef | undefined {
  return item.image_item?.media ?? item.voice_item?.media ?? item.file_item?.media ?? item.video_item?.media
}
