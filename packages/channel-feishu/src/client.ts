import { decodeFrame, encodeFrame } from './proto.js'

/**
 * 飞书 / Lark Open API client + 长连接（WebSocket）入站客户端。
 *
 * 发送走 HTTP（tenant_access_token 鉴权），入站走**长连接模式**（`callback/ws/endpoint`
 * 拿到 wss 地址后建立持久连接），因此与 Telegram/WeChat 一样**无需公网地址、无需 webhook**。
 * 参考：openclaw feishu 插件（`@larksuiteoapi/node-sdk`）/ mimiclaw feishu_bot.c。
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
  /** tenant token 缓存失效阈值（秒）；默认提前 300s 续期。 */
  tokenRefreshAheadSec?: number
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

export function domainBase(domain: FeishuDomain = 'feishu'): string {
  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
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
    this.fetchImpl = opts.fetch ?? fetch
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

  /** 回复到指定消息（原消息上下文里的 thread）。 */
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

// ---- 长连接（WebSocket）----

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
        // connectOnce 返回时连接已断开（或 stop）；退避后重连。
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
        // onclose 会随后触发；这里只记录，不 resolve（避免与 onclose 双 settle）。
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
        // 发送失败由 onclose/onerror 接管。
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
      // 控制帧：pong（服务端回包）；payload 可能带更新后的 PingInterval，v1 忽略。
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

    // ACK：回显 seqId/logId/service/method，负载 `{"code":200}`。
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
      // ACK 失败不阻塞事件处理。
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
    // Blob 形态：异步拿 arrayBuffer，这里同步拿不到就返回空（v1 不处理）。
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

// ---- 事件类型（im.message.receive_v1 v2 schema）----

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

/** 平台无关的媒体事实（与 dsh-channel 的 InboundMedia 同构，客户端不依赖契约包）。 */
export interface FeishuMedia {
  kind: 'image' | 'document' | 'audio' | 'video'
  fileRef: string
  mimeType?: string
  fileName?: string
}

/** 入站媒体事实（fileRef = file_key/image_key；v1 不下载字节，仅交接）。 */
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
    // 富媒体卡片可同时带图片与文件。
    const facts: FeishuMedia[] = []
    if (imageKey) facts.push({ kind: 'image', fileRef: imageKey })
    if (fileKey) facts.push({ kind: 'document', fileRef: fileKey, fileName })
    return facts
  }
  if (type === 'video' && fileKey) return [{ kind: 'video', fileRef: fileKey, fileName }]
  // 其余（sticker 等）只给 file_key 事实。
  if (fileKey) return [{ kind: 'document', fileRef: fileKey, fileName }]
  return []
}
