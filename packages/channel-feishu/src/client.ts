import type { SendErrorKind } from 'dsh-channel'
import { decodeFrame, encodeFrame } from './proto.js'
import { proxiedFetch } from 'dsh-channel-kit'

/**
 * Feishu / Lark Open API client + long-connection (WebSocket) inbound client.
 *
 * Sending goes over HTTP (authenticated with tenant_access_token), while inbound uses
 * **long-connection mode** (fetch the wss address from `callback/ws/endpoint`, then open a
 * persistent connection), so like Telegram/WeChat it needs **no public address and no webhook**.
 * Reference: the openclaw Feishu plugin (`@larksuiteoapi/node-sdk`) / mimiclaw feishu_bot.c.
 */

export type FeishuDomain = 'feishu' | 'lark'

export interface FeishuCredentials {
  appId: string
  appSecret: string
}

export interface FeishuClientOptions {
  domain?: FeishuDomain
  fetch?: typeof fetch
  timeoutMs?: number
  /** Tenant token cache expiry threshold (seconds); defaults to renewing 300s ahead. */
  tokenRefreshAheadSec?: number
  /** Outbound HTTP proxy (http://[user:pass@]host:port); wraps the fetch implementation. */
  proxyUrl?: string
}

export class FeishuApiError extends Error {
  readonly code: number | undefined
  readonly msg: string | undefined
  constructor(message: string, code?: number, msg?: string) {
    super(message)
    this.name = 'FeishuApiError'
    this.code = code
    this.msg = msg
  }
}

export interface ClassifiedSendError {
  errorKind: SendErrorKind
  retryAfterMs?: number
}

/**
 * Feishu send-error classification. Codes kept conservative: unknown stays
 * unknown (retryable). Known Feishu ranges are mapped from their open-api docs.
 */
export function classifyFeishuSendError(error: FeishuApiError): ClassifiedSendError {
  const code = error.code
  const msg = (error.msg ?? error.message).toLowerCase()
  if (code === 99991672 || code === 230001) return { errorKind: 'too_long' }
  if (code === 99991663 || code === 99991664 || code === 99991665 || code === 99991666) return { errorKind: 'forbidden' }
  if (code === 99991668 || code === 99991669) return { errorKind: 'rate_limited' }
  if (code === 99991670 || code === 99991671) return { errorKind: 'not_found' }
  if (code !== undefined && code >= 100_000_000) return { errorKind: 'transient' }
  if (msg.includes('too long') || msg.includes('text length') || msg.includes('exceeds')) return { errorKind: 'too_long' }
  if (msg.includes('permission') || msg.includes('forbidden') || msg.includes('denied')) return { errorKind: 'forbidden' }
  if (msg.includes('rate') || msg.includes('too many') || msg.includes('frequency')) return { errorKind: 'rate_limited' }
  if (msg.includes('not found') || msg.includes('not exist')) return { errorKind: 'not_found' }
  return { errorKind: 'unknown' }
}

export function domainBase(domain: FeishuDomain = 'feishu'): string {
  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
}

const FEISHU_EMOJI_TYPES: Record<string, string> = {
  '👀': 'ONLOOKER',
  '👍': 'THUMBSUP',
}

export function resolveReceiveIdType(receiveId: string): 'chat_id' | 'open_id' | 'union_id' | 'user_id' {
  if (receiveId.startsWith('oc_')) return 'chat_id'
  if (receiveId.startsWith('ou_')) return 'open_id'
  if (receiveId.startsWith('on_')) return 'union_id'
  if (receiveId.startsWith('u_')) return 'user_id'
  return 'open_id'
}

export class FeishuClient {
  private readonly domain: FeishuDomain
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly refreshAheadSec: number
  private tenantToken: string | undefined
  private tokenExpiresAt = 0

  constructor(opts: FeishuClientOptions = {}) {
    this.domain = opts.domain ?? 'feishu'
    const rawFetch = opts.fetch ?? fetch
    this.fetchImpl = opts.proxyUrl ? proxiedFetch(opts.proxyUrl) : rawFetch
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.refreshAheadSec = opts.tokenRefreshAheadSec ?? 300
  }

  static redactSecret(text: string, secret?: string): string {
    if (!secret) return text
    return text.split(secret).join('<redacted>')
  }

  get baseUrl(): string {
    return `${domainBase(this.domain)}/open-apis`
  }

  async getTenantAccessToken(credentials: FeishuCredentials): Promise<string> {
    if (this.tenantToken && Date.now() < this.tokenExpiresAt) return this.tenantToken
    const response = await this.fetchImpl(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
    })
    const payload = (await response.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (payload.code !== 0 || !payload.tenant_access_token) {
      throw new FeishuApiError(
        FeishuClient.redactSecret(`feishu tenant_access_token failed: ${payload.msg ?? 'unknown error'}`, credentials.appSecret),
        payload.code,
        payload.msg,
      )
    }
    this.tenantToken = payload.tenant_access_token
    this.tokenExpiresAt = Date.now() + (payload.expire ?? 7200) * 1000 - this.refreshAheadSec * 1000
    return this.tenantToken
  }

  async sendMessage(
    token: string,
    receiveId: string,
    text: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const receiveIdType = resolveReceiveIdType(receiveId)
    const payload = await this.callApi<{ data?: { message_id?: string } }>(
      token,
      `/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
        uuid: randomUuid(),
      },
      { signal: opts.signal },
    )
    const messageId = payload.data?.message_id
    if (!messageId) throw new FeishuApiError('feishu send message returned no message_id')
    return messageId
  }

  /**
   * React to a message with an emoji (Feishu message_reaction.create).
   * Feishu expects a predefined `emoji_type`; a small map translates the common
   * ack emoji, and anything unknown is passed through unchanged (a failure just
   * degrades to the caller's text ack).
   */
  async createReaction(
    token: string,
    messageId: string,
    emoji: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const emojiType = FEISHU_EMOJI_TYPES[emoji] ?? emoji
    await this.callApi(
      token,
      `/im/v1/messages/${messageId}/reactions`,
      { reaction_type: { emoji_type: emojiType } },
      { signal: opts.signal },
    )
  }

  /** Reply to the given message (the thread in the original message context). */
  async replyMessage(
    token: string,
    messageId: string,
    text: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const payload = await this.callApi<{ data?: { message_id?: string } }>(
      token,
      `/im/v1/messages/${messageId}/reply`,
      { msg_type: 'text', content: JSON.stringify({ text }) },
      { signal: opts.signal },
    )
    const replyId = payload.data?.message_id
    if (!replyId) throw new FeishuApiError('feishu reply message returned no message_id')
    return replyId
  }

  async getBotInfo(token: string): Promise<{ appName?: string; openId?: string }> {
    const payload = await this.callApi<{ bot?: { app_name?: string; open_id?: string } }>(token, '/bot/v3/info', undefined)
    return { appName: payload.bot?.app_name, openId: payload.bot?.open_id }
  }

  private async callApi<T>(
    token: string,
    path: string,
    body: unknown,
    opts: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`feishu api timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
    timer.unref?.()
    const onOuterAbort = () => controller.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true })

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const payload = (await response.json()) as T & { code?: number; msg?: string }
      if (payload.code === 0) return payload as T
      throw new FeishuApiError(`feishu api ${path} failed: ${payload.msg ?? `HTTP ${response.status}`}`, payload.code, payload.msg)
    } catch (error) {
      if (error instanceof FeishuApiError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new FeishuApiError(`feishu api ${path} request failed: ${message}`)
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onOuterAbort)
    }
  }
}

// ---- Long connection (WebSocket) ----

export interface FeishuWsEndpoint {
  url: string
  serviceId: number
  pingIntervalMs: number
  reconnectIntervalMs: number
}

export interface WebSocketLike {
  send(data: ArrayBuffer): void
  close(code?: number, reason?: string): void
  binaryType?: string
  onopen?: ((event: unknown) => void) | null
  onmessage?: ((event: { data: unknown }) => void) | null
  onclose?: ((event: { code?: number; reason?: string }) => void) | null
  onerror?: ((event: unknown) => void) | null
}

export interface FeishuWsClientOptions {
  resolveCredentials: () => Promise<FeishuCredentials | undefined>
  domain?: FeishuDomain
  fetch?: typeof fetch
  createWebSocket?: (url: string) => WebSocketLike
  onEvent?: (event: FeishuEventV2) => void
  onStatus?: (status: 'connecting' | 'connected' | 'disconnected', error?: Error) => void
}

export class FeishuWsClient {
  private readonly opts: FeishuWsClientOptions
  private readonly fetchImpl: typeof fetch
  private readonly domain: FeishuDomain
  private ws: WebSocketLike | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private stopped = false
  private endpoint: FeishuWsEndpoint | null = null

  constructor(opts: FeishuWsClientOptions) {
    this.opts = opts
    this.fetchImpl = opts.fetch ?? fetch
    this.domain = opts.domain ?? 'feishu'
  }

  async start(): Promise<void> {
    this.stopped = false
    void this.runLoop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pingTimer) clearTimeout(this.pingTimer)
    this.pingTimer = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        ws.close(1000, 'stopped')
      } catch {
        // ignore
      }
    }
  }

  private async runLoop(): Promise<void> {
    let backoff = 1000
    while (!this.stopped) {
      try {
        const credentials = await this.opts.resolveCredentials()
        if (!credentials) throw new Error('FEISHU_APP_ID / FEISHU_APP_SECRET are not configured')

        this.endpoint = await this.fetchEndpoint(credentials)
        this.opts.onStatus?.('connecting')
        await this.connectOnce(this.endpoint)
        // When connectOnce returns, the connection has dropped (or stopped); back off and reconnect.
        backoff = 1000
      } catch (error) {
        if (this.stopped) return
        const err = error instanceof Error ? error : new Error(String(error))
        this.opts.onStatus?.('disconnected', err)
        await sleep(backoff + Math.random() * 500)
        backoff = Math.min(15_000, backoff * 2)
      }
    }
  }

  private async fetchEndpoint(credentials: FeishuCredentials): Promise<FeishuWsEndpoint> {
    const response = await this.fetchImpl(`${domainBase(this.domain)}/callback/ws/endpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ AppID: credentials.appId, AppSecret: credentials.appSecret }),
    })
    const payload = (await response.json()) as {
      code?: number
      msg?: string
      data?: { URL?: string; ClientConfig?: { PingInterval?: number; ReconnectInterval?: number; ReconnectNonce?: number } }
    }
    if (payload.code !== 0 || !payload.data?.URL) {
      throw new FeishuApiError(`feishu ws endpoint failed: ${payload.msg ?? 'unknown error'}`, payload.code, payload.msg)
    }
    const serviceId = parseServiceId(payload.data.URL)
    const pingIntervalMs = (payload.data.ClientConfig?.PingInterval ?? 30) * 1000
    const reconnectIntervalMs = (payload.data.ClientConfig?.ReconnectInterval ?? 30) * 1000
    return { url: payload.data.URL, serviceId, pingIntervalMs, reconnectIntervalMs }
  }

  private connectOnce(endpoint: FeishuWsEndpoint): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const createWebSocket = this.opts.createWebSocket ?? defaultCreateWebSocket
      const ws = createWebSocket(endpoint.url)
      this.ws = ws

      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (this.pingTimer) clearTimeout(this.pingTimer)
        this.pingTimer = null
        if (error) reject(error)
        else resolve()
      }

      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        this.opts.onStatus?.('connected')
        this.armPing(endpoint)
      }

      ws.onmessage = (event) => {
        this.handleFrame(endpoint, toUint8Array(event.data))
      }

      ws.onclose = (event) => {
        if (this.ws === ws) this.ws = null
        finish()
      }

      ws.onerror = (error) => {
        // onclose fires next; only log here, do not resolve (avoid double-settling with onclose).
        void error
      }
    })
  }

  private armPing(endpoint: FeishuWsEndpoint): void {
    if (this.pingTimer) clearTimeout(this.pingTimer)
    this.pingTimer = setTimeout(() => {
      if (this.stopped || !this.ws) return
      try {
        this.ws.send(encodeFrame({ seqId: 0, logId: 0, service: endpoint.serviceId, method: 0, headers: { type: 'ping' }, payload: null }).buffer as ArrayBuffer)
      } catch {
        // Send failures are handled by onclose/onerror.
      }
      this.armPing(endpoint)
    }, endpoint.pingIntervalMs)
    this.pingTimer.unref?.()
  }

  private handleFrame(endpoint: FeishuWsEndpoint, data: Uint8Array): void {
    let frame
    try {
      frame = decodeFrame(data)
    } catch {
      return
    }

    const type = frame.headers['type'] ?? ''
    if (frame.method === 0) {
      // Control frame: pong (server reply); the payload may carry an updated PingInterval, which v1 ignores.
      return
    }
    if (type !== 'event' || frame.payload === null) return

    let payloadText = ''
    try {
      payloadText = new TextDecoder().decode(frame.payload)
      const event = JSON.parse(payloadText) as FeishuEventV2
      this.opts.onEvent?.(event)
    } catch {
      return
    }

    // ACK: echo seqId/logId/service/method with payload `{"code":200}`.
    try {
      this.ws?.send(encodeFrame({
        seqId: frame.seqId,
        logId: frame.logId,
        service: frame.service,
        method: frame.method,
        headers: {},
        payload: new TextEncoder().encode('{"code":200}'),
      }).buffer as ArrayBuffer)
    } catch {
      // ACK failure does not block event handling.
    }
    void payloadText
  }
}

function parseServiceId(url: string): number {
  try {
    const u = new URL(url)
    const value = u.searchParams.get('service_id')
    if (value) return Number(value)
  } catch {
    // ignore
  }
  return 0
}

function defaultCreateWebSocket(url: string): WebSocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
  if (!ctor) throw new Error('feishu long connection requires a global WebSocket (Node >= 22)')
  return new ctor(url)
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength)
  if (typeof data === 'object' && data !== null && 'arrayBuffer' in data) {
    // Blob form: getting arrayBuffer is async; here we cannot get it synchronously so return empty (v1 does not handle it).
    return new Uint8Array(0)
  }
  return new Uint8Array(0)
}

function randomUuid(): string {
  return `dsh-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

// ---- Event types (im.message.receive_v1 v2 schema) ----

export interface FeishuEventV2 {
  schema?: string
  header?: { event_id?: string; event_type?: string; token?: string; app_id?: string; tenant_key?: string }
  event?: FeishuMessageEvent
}

export interface FeishuMessageEvent {
  sender?: { sender_id?: { open_id?: string; union_id?: string; user_id?: string }; sender_type?: string }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: string
    message_type?: string
    content?: string
    create_time?: string
    mentions?: unknown[]
    parent_id?: string
  }
}

export function messageText(event: FeishuMessageEvent): string {
  const message = event.message
  if (!message || message.message_type !== 'text') return ''
  try {
    const parsed = JSON.parse(message.content ?? '{}') as { text?: unknown }
    return typeof parsed.text === 'string' ? parsed.text : ''
  } catch {
    return ''
  }
}

export function hasMedia(event: FeishuMessageEvent): boolean {
  return event.message?.message_type !== undefined && event.message.message_type !== 'text'
}

export function chatTypeOf(event: FeishuMessageEvent): 'direct' | 'group' {
  return event.message?.chat_type === 'group' ? 'group' : 'direct'
}

export function senderId(event: FeishuMessageEvent): string {
  return event.sender?.sender_id?.open_id ?? event.sender?.sender_id?.user_id ?? event.sender?.sender_id?.union_id ?? ''
}

/** Platform-agnostic media facts (isomorphic with dsh-channel's InboundMedia; the client does not depend on the contract package). */
export interface FeishuMedia {
  kind: 'image' | 'document' | 'audio' | 'video'
  fileRef: string
  mimeType?: string
  fileName?: string
}

/** Inbound media facts (fileRef = file_key/image_key; v1 does not download bytes, only hands them over). */
export function mediaFacts(event: FeishuMessageEvent): FeishuMedia[] {
  const message = event.message
  if (!message) return []
  const type = message.message_type ?? ''
  if (type === 'text') return []

  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(message.content ?? '{}') as Record<string, unknown>
  } catch {
    parsed = {}
  }

  const imageKey = typeof parsed.image_key === 'string' ? parsed.image_key : undefined
  const fileKey = typeof parsed.file_key === 'string' ? parsed.file_key : undefined
  const fileName = typeof parsed.file_name === 'string' ? parsed.file_name : undefined

  if (type === 'image' && imageKey) return [{ kind: 'image', fileRef: imageKey }]
  if (type === 'audio' && fileKey) return [{ kind: 'audio', fileRef: fileKey, fileName }]
  if (type === 'file' && fileKey) return [{ kind: 'document', fileRef: fileKey, fileName }]
  if (type === 'media') {
    // Rich media cards can carry both an image and a file.
    const facts: FeishuMedia[] = []
    if (imageKey) facts.push({ kind: 'image', fileRef: imageKey })
    if (fileKey) facts.push({ kind: 'document', fileRef: fileKey, fileName })
    return facts
  }
  if (type === 'video' && fileKey) return [{ kind: 'video', fileRef: fileKey, fileName }]
  // Others (sticker, etc.) only provide the file_key fact.
  if (fileKey) return [{ kind: 'document', fileRef: fileKey, fileName }]
  return []
}
