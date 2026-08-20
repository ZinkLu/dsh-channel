import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

declare module '@deepseek-ai/cordis' {
  interface Context {
    channels: ChannelRegistry
  }
  interface Events {
    /**
     * A normalized inbound message has been received by a provider (after deduplication).
     * Observational event: policy plugins do auditing/statistics here; it carries no routing decision.
     * @mode emit
     */
    'channel/message'(msg: InboundMessage): void
    /**
     * One outbound delivery. Policy plugins may wrap (rewrite text, throttle/delay) or
     * short-circuit (return a suppressed receipt to block the message); pure observers must call next().
     * The innermost default = the registry locates the Channel and calls its send.
     * @mode waterfall
     */
    'channel/deliver'(out: OutboundMessage, next: () => Promise<DeliveryReceipt>): Promise<DeliveryReceipt>
    /**
     * provider connection status changes (connecting/connected/disconnected/fatal).
     * @mode emit
     */
    'channel/status'(channelId: string, status: ChannelStatus, error?: Error): void
    /**
     * A provider has pushed a presentation frame to the platform (streaming draft/status line/final).
     * Observational event: policy plugins audit streaming/tool traffic here; it carries no routing or interception decision.
     * @mode emit
     */
    'channel/present'(frame: PresentationFrame): void
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    channel: {
      kind: 'channel'
      /** provider id, e.g. 'telegram' */
      channel: string
      /** Platform session key (DM = chat id, group = chat id; semantics defined by the provider, just needs to be stable) */
      chatKey: string
      /** Sender platform id */
      senderId: string
      /** Platform message ids composing this user/message (can be multiple after a merge) */
      messageIds: string[]
    }
  }
}

/** Inbound media fact (handoff metadata, no bytes downloaded). After the provider downloads an image it goes through ctx.attachments.saveImage into a model-visible block. */
export interface InboundMedia {
  readonly kind: 'image' | 'document' | 'audio' | 'video'
  /** Platform-side file reference (provider-defined, e.g. Telegram file_id / Feishu file_key) — a handoff fact, no bytes downloaded */
  readonly fileRef: string
  readonly mimeType?: string
  readonly fileName?: string
}

/** Platform-agnostic inbound message. media keeps only placeholder descriptions (provider-defined fileRef); bytes are downloaded by the provider on demand. */
export interface InboundMessage {
  readonly channel: string // provider id
  readonly chatKey: string // stable session key
  readonly senderId: string
  readonly senderName?: string
  readonly messageId: string // platform message id (dedupe key)
  readonly chatType: ChatType // 'direct' | 'group' | 'thread'
  readonly text: string
  readonly timestamp: number // epoch ms
  /** Whether it carries media: merge uses this to "not merge when there's an attachment". */
  readonly hasMedia: boolean
  /** Media facts (fileRef + metadata); the expansion of hasMedia. */
  readonly media?: readonly InboundMedia[]
  /** Whether the bot was @-mentioned in a group chat (provider-determined; v1 group chats are not routed, only recorded) */
  readonly mentionsBot?: boolean
  /** The platform id of the message this one replies to (observed; enables quote/reply parity + thread inference). */
  readonly replyToMessageId?: string
}

/** Outbound media (portable payload: images use an attachment reference, documents use a cwd-relative path; never pass a raw host absolute path). */
export interface OutboundMedia {
  readonly kind: 'image' | 'document'
  /** Image: a ctx.attachments reference (no raw host path, preventing path leaks + R7). */
  readonly attachment?: ImageAttachmentRef
  /** Document: a relative path inside the agent workspace (cwd); bytes are read by the provider and anchored to cwd. */
  readonly filePath?: string
  readonly caption?: string
}

/** Outbound message: semantic content + presentation intent; splitting/escaping is the provider's concern */
export interface OutboundMessage {
  readonly channel: string
  /** Instance discriminator for multi-account deployments; defaults to 'default'. Omitted (or 'default') for the common single-account case. */
  readonly accountId?: string
  readonly chatKey: string
  /** markdown source text; the provider renders it degraded according to its own formatTier */
  readonly markdown: string
  /** Structured choices (approval/clarification); on buttonless platforms the consumer degrades them to numbered text up front */
  readonly choices?: readonly OutboundChoice[]
  /** Outbound media (supportsMedia platforms sendMedia item-by-item; unsupported platforms degrade to a text note) */
  readonly media?: readonly OutboundMedia[]
  /** Idempotency key: a duplicate deliver with the same key should be blocked by the ledger */
  readonly deliveryKey: string
  /** Provenance (for auditing): from which session and which event */
  readonly origin?: { sessionId: string; seq?: number }
  /** Presentation intent: final / new draft / edit draft / status line. Policy plugins decide whether to intercept/rewrite based on this. */
  readonly presentation?: PresentationIntent
  /** The draft's platform message id when presentation='draft-edit'. */
  readonly editTarget?: string
  /** Platform message id to reply to (quote). Only sent when the provider supportsReply. */
  readonly replyTo?: string
  /** Thread/forum-topic id (distinct from reply-to). Only sent when the provider supportsThreads. */
  readonly threadId?: string
  /** Deliver without notifying the user (no buzz). Status lines and heartbeats; only sent when the provider supportsSilent. */
  readonly silent?: boolean
}

export interface OutboundChoice {
  readonly id: string
  readonly label: string
}

/** Machine-readable outbound send error taxonomy.
 *  Provider clients classify platform error codes into one of these kinds. */
export type SendErrorKind =
  | 'too_long'
  | 'bad_format'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'transient'
  | 'unknown'

export interface DeliveryReceipt {
  readonly status: 'sent' | 'suppressed' | 'failed'
  /** Platform-side message id (multiple when split). On a failed multi-part send this keeps the ids of parts that did make it. */
  readonly platformMessageIds?: readonly string[]
  readonly error?: string
  /** Machine-readable error kind, populated by provider clients from platform error codes. */
  readonly errorKind?: SendErrorKind
  /** Platform retry-after hint (ms); providers should honor it only up to the deliver-queue ceiling. */
  readonly retryAfterMs?: number
  /** 1-based index of the part that failed in a multi-part send, when known. */
  readonly failedAtChunk?: number
}

/** Presentation intent: final message / new draft / edit existing draft / status line. */
export type PresentationIntent = 'final' | 'draft-new' | 'draft-edit' | 'status-line'

/** Presentation limits. All undefined = no known limit. */
export interface PresentationLimits {
  /** Maximum buttons per message; beyond this, degrade to numbered text. */
  readonly maxOptions?: number
  /** Button text limit (code points); truncate with … when exceeded. */
  readonly maxLabelLength?: number
  /** Callback data (callback_data/value) limit (bytes); e.g. Telegram=64. */
  readonly maxValueBytes?: number
}

/**
 * Presentation frame: a provider has pushed a presentation fact to the platform
 * (the payload of the channel/present event).
 * Difference from OutboundMessage: OutboundMessage is a "delivery request" (goes
 * through the deliver waterfall and can be wrapped/short-circuited by policy plugins),
 * while PresentationFrame is a "presentation fact that already happened" (emit, read-only).
 */
export type PresentationFrame =
  | { readonly kind: 'final'; readonly channel: string; readonly chatKey: string; readonly deliveryKey: string; readonly text: string }
  | { readonly kind: 'draft-new'; readonly channel: string; readonly chatKey: string; readonly draftKey: string; readonly text: string }
  | { readonly kind: 'draft-edit'; readonly channel: string; readonly chatKey: string; readonly draftKey: string; readonly editTarget: string; readonly text: string }
  | { readonly kind: 'draft-finalize'; readonly channel: string; readonly chatKey: string; readonly draftKey: string }
  | { readonly kind: 'draft-discard'; readonly channel: string; readonly chatKey: string; readonly draftKey: string }
  | { readonly kind: 'status-line'; readonly channel: string; readonly chatKey: string; readonly text: string }

export type ChatType = 'direct' | 'group' | 'thread'
export type ChannelStatus = 'connecting' | 'connected' | 'disconnected' | 'fatal'

/**
 * Abstract base class for platform providers. A plain abstract class rather than a
 * Service (aligned with LlmAdapter): the lifecycle is carried by the provider plugin's
 * own fiber, and registration goes through ctx.channels.register().
 * The required surface is deliberately minimal; capability differences always go
 * through "capability facts + degradation".
 */
export abstract class Channel {
  /** Stable provider id ('telegram', 'discord', …), the registry key */
  abstract readonly id: string

  /**
   * Instance discriminator for multi-account deployments. `id` stays the
   * provider-family key ('telegram') for capability-fact purposes; two instances
   * of the same `id` are disambiguated by `accountId`. Default 'default' preserves
   * today's single-account behavior with zero config changes.
   */
  get accountId(): string {
    return 'default'
  }

  // ---- capability facts: conservative base defaults, overridden by implementations ----

  /** Maximum characters per message; undefined = no known limit */
  get maxMessageChars(): number | undefined {
    return undefined
  }
  /** Rich-text tier: the consumer picks a format degradation path based on this */
  get formatTier(): 'plain' | 'markdown' | 'html' {
    return 'plain'
  }
  /** Whether structured choices (buttons/cards) are supported; when false, approval degrades to a numbered reply */
  get supportsChoices(): boolean {
    return false
  }
  /** Whether editing already-sent messages is supported (prerequisite for draft-style streaming, v2) */
  get supportsEdit(): boolean {
    return false
  }
  /** Whether typing indicators are supported */
  get supportsTyping(): boolean {
    return false
  }
  /** Supported session shapes */
  get chatTypes(): readonly ChatType[] {
    return ['direct']
  }

  // ---- presentation capability facts: conservative base defaults (mirrors the FileSystem.sandboxMode pattern) ----

  /** Streaming tier. 'off' = final only; 'progress' = one editable status draft + final; 'block' = chunked draft (v2).
   *  Requires supportsEdit to be anything other than off; platforms without editing stay off forever. */
  get streamingMode(): 'off' | 'block' | 'progress' {
    return 'off'
  }
  /** Whether to present a "doing X…" status line as text; textless platforms stay false. */
  get supportsStatusText(): boolean {
    return false
  }
  /** Thinking presentation level. 'off' = never hand thinking down (default); 'on' = fold the final block into a status line; 'stream' = status line per delta. */
  get thinkingLevel(): 'off' | 'on' | 'stream' {
    return 'off'
  }
  /** @deprecated use `thinkingLevel !== 'off'` */
  get supportsThinking(): boolean {
    return this.thinkingLevel !== 'off'
  }
  /** Presentation limits (button count/button text/callback data). */
  get presentationLimits(): PresentationLimits {
    return {}
  }
  /** Whether multi-select choices are supported; when false, multi-select degrades to "single-select one-by-one + a text supplement". */
  get supportsMultiSelect(): boolean {
    return false
  }
  /** Whether sending media (images/documents) is supported. When false, outbound media degrades to a "could not deliver" text. */
  get supportsMedia(): boolean {
    return false
  }
  /** Whether replying to (quoting) a specific inbound message is supported on the outbound side. */
  get supportsReply(): boolean {
    return false
  }
  /** Whether threads (forum topics / Slack threads, distinct from reply-to) are supported. */
  get supportsThreads(): boolean {
    return false
  }
  /** Whether silent / no-notification delivery is supported (status lines and heartbeats shouldn't buzz). */
  get supportsSilent(): boolean {
    return false
  }
  /** Whether the provider can reconcile a prior delivery by querying the platform before a blind resend. */
  get supportsReconciliation(): boolean {
    return false
  }

  // ---- required behavior ----

  /**
   * Send a piece of text already rendered against platform constraints (optionally with choices).
   * Splitting is the caller's job; the implementation only handles a single send and error reporting.
   */
  abstract send(
    chatKey: string,
    text: string,
    opts?: {
      choices?: readonly OutboundChoice[]
      signal?: AbortSignal
      /** Reply to (quote) this platform message id. */
      replyTo?: string
      /** Thread / forum-topic id (distinct from reply-to). */
      threadId?: string
      /** Deliver without notifying the user. */
      silent?: boolean
    },
  ): Promise<{ platformMessageId: string }>

  // ---- optional behavior: harmless defaults by degradation ----

  /** typing indicator; no-op by default */
  async sendTyping(_chatKey: string): Promise<void> {}

  /**
   * Send one piece of media (image/document). Implemented only by supportsMedia
   * platforms; the base class throws (optional method + degradation — consumers
   * should check supportsMedia first).
   */
  async sendMedia(
    _chatKey: string,
    _media: OutboundMedia,
    _opts?: { signal?: AbortSignal },
  ): Promise<{ platformMessageId: string }> {
    throw new Error(`${this.id} does not support media`)
  }

  /**
   * Cheaply acknowledge an inbound message (the ack-long UX) in whatever form the
   * platform has — a reaction, a marker, nothing. Returns true when something
   * visible was shown; false (the default) or a throw both tell the caller to
   * fall back to a text ack. The platform vocabulary (which emoji, which API)
   * stays inside the provider; the caller only owns the timing.
   */
  async ackInbound(_chatKey: string, _messageId: string): Promise<boolean> {
    return false
  }

  /**
   * Reconcile a prior delivery by querying the platform before a blind resend
   * (recovery path). Defaults to 'unknown' — graceful absence (R2). A provider
   * may implement it to return 'confirmed-sent' (skip the resend) or
   * 'confirmed-absent' (safe to resend) by inspecting platform state.
   */
  async reconcile(
    _chatKey: string,
    _deliveryKey: string,
    _textHash: string,
  ): Promise<'confirmed-sent' | 'confirmed-absent' | 'unknown'> {
    return 'unknown'
  }
}

/**
 * Sibling optional interface for interactive/pairing login (QR, OAuth device
 * flow). Deliberately NOT on `Channel` itself — only some platforms need it
 * (R6), and it is consumed by a CLI/setup command, never by the bridge runtime.
 * A provider package may additionally export an implementation of this shape.
 * None of the three current providers implement it (all use static bot tokens).
 */
export interface ChannelLoginOptions {
  signal?: AbortSignal
}

export interface ChannelLoginResult {
  ok: boolean
  /** Optional persisted auth fact (e.g. a credential ref name the caller should now resolve). */
  credentialRef?: string
  error?: string
}

export interface ChannelLogin {
  login(opts?: ChannelLoginOptions): Promise<ChannelLoginResult>
}

/** Install the registry as a service on the current context (plugin entry point). */
export function apply(ctx: Context): void {
  new ChannelRegistry(ctx)
}

export class ChannelRegistry extends Service {
  /** Keyed by `${id}:${accountId}` so multiple instances of the same provider family can coexist. */
  private entries = new Map<string, Channel>()
  /** sessionId → outbound target binding (registry-wide, cross-provider), for proactive push discovery. */
  private sessionBindings = new Map<string, { channel: string; accountId?: string; chatKey: string }>()

  constructor(ctx: Context) {
    super(ctx, 'channels')
  }

  /**
   * Register a provider. A duplicate `(id, accountId)` throws (two accounts of
   * the same platform are fine; two instances with the same discriminator are
   * not). Returns a disposer via ctx.effect: the registration is automatically
   * reclaimed when the provider unloads.
   */
  register(channel: Channel): () => void {
    return this.ctx.effect(() => {
      // Defensive: `register` is reachable with a duck-typed channel that has no
      // `accountId` getter, which would otherwise key the entry as `id:undefined`.
      const account = channel.accountId ?? 'default'
      const key = registryKey(channel.id, account)
      if (this.entries.has(key)) {
        throw new Error(`channel "${channel.id}" account "${account}" is already registered`)
      }
      this.entries.set(key, channel)
      return () => {
        this.entries.delete(key)
      }
    }, 'channels.register()') as () => void
  }

  /** Look up by provider id; `accountId` defaults to 'default' (the single-account case). */
  get(id: string, accountId = 'default'): Channel | undefined {
    return this.entries.get(registryKey(id, accountId))
  }

  list(): Channel[] {
    return [...this.entries.values()]
  }

  /**
   * Register a sessionId → (channel, chatKey) binding so policy plugins (monitor,
   * reminder, cron) can discover where to push a proactive message without poking
   * into a bridge's private maps. Idempotent; re-established on restore.
   */
  bindChatKey(sessionId: string, channelId: string, chatKey: string, accountId?: string): void {
    this.sessionBindings.set(sessionId, {
      channel: channelId,
      ...(accountId !== undefined && accountId !== 'default' ? { accountId } : {}),
      chatKey,
    })
  }

  /** Read-only reverse lookup: which channel + chatKey is this session bound to. */
  chatKeyOf(sessionId: string): { channel: string; accountId?: string; chatKey: string } | undefined {
    return this.sessionBindings.get(sessionId)
  }

  /** Called when a provider receives a deduplicated inbound message: normalization assertion + broadcast */
  ingest(msg: InboundMessage): void {
    assertInboundMessage(msg)
    this.ctx.emit('channel/message', msg)
  }

  /**
   * Unified outbound entry point: goes through the channel/deliver waterfall; the
   * innermost default locates the provider and sends. Policy plugins
   * (rate-limiting/redaction/auditing) wrap or short-circuit on the waterfall.
   */
  async deliver(out: OutboundMessage): Promise<DeliveryReceipt> {
    return this.ctx.waterfall('channel/deliver', out, async (): Promise<DeliveryReceipt> => {
      const channel = this.entries.get(registryKey(out.channel, out.accountId ?? 'default'))
      if (channel === undefined) {
        const label = out.accountId && out.accountId !== 'default' ? `${out.channel}:${out.accountId}` : out.channel
        return { status: 'failed', error: `no channel "${label}"` }
      }
      const platformMessageIds: string[] = []
      try {
        // text (empty text is not sent out; when media-only, don't send an empty bubble).
        if (out.markdown !== '') {
          const result = await channel.send(out.chatKey, out.markdown, {
            choices: out.choices,
            replyTo: out.replyTo,
            threadId: out.threadId,
            silent: out.silent,
          })
          platformMessageIds.push(result.platformMessageId)
        }
        // media: supportsMedia platforms go through sendMedia; otherwise degrade to a "could not deliver" text (never echo the host path back).
        for (const media of out.media ?? []) {
          if (channel.supportsMedia) {
            const result = await channel.sendMedia(out.chatKey, media)
            platformMessageIds.push(result.platformMessageId)
          } else {
            const result = await channel.send(out.chatKey, mediaUnsupportedText(media.kind))
            platformMessageIds.push(result.platformMessageId)
          }
        }
        return { status: 'sent', platformMessageIds }
      } catch (error) {
        const classified = error as Error & { errorKind?: SendErrorKind; retryAfterMs?: number }
        // A failed multi-part send keeps the ids of parts that made it, so the ledger can retry only the remainder.
        return {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          ...(classified.errorKind !== undefined ? { errorKind: classified.errorKind } : {}),
          ...(classified.retryAfterMs !== undefined ? { retryAfterMs: classified.retryAfterMs } : {}),
          ...(platformMessageIds.length > 0 ? { platformMessageIds } : {}),
          failedAtChunk: platformMessageIds.length + 1,
        }
      }
    })
  }
}

export default ChannelRegistry

function registryKey(id: string, accountId: string): string {
  return `${id}:${accountId}`
}

function mediaUnsupportedText(kind: 'image' | 'document'): string {
  return kind === 'image' ? '⚠️ Could not deliver the image attachment.' : '⚠️ Could not deliver the file attachment.'
}

function assertInboundMessage(msg: InboundMessage): void {
  if (!msg.channel) throw new Error('InboundMessage.channel must be a non-empty string')
  if (!msg.chatKey) throw new Error('InboundMessage.chatKey must be a non-empty string')
  if (!msg.senderId) throw new Error('InboundMessage.senderId must be a non-empty string')
  if (!msg.messageId) throw new Error('InboundMessage.messageId must be a non-empty string')
  if (!Number.isFinite(msg.timestamp)) throw new Error('InboundMessage.timestamp must be a finite number')
}
