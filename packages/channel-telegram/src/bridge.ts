import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { InboundMedia, InboundMessage, OutboundMessage, PresentationFrame } from 'dsh-channel'
import {
  chunkText,
  createMemoryStore,
  DEFAULT_MAX_INBOUND_MEDIA_BYTES,
  deliverQueueReduce,
  emptyDeliverQueueState,
  emptyMergeState,
  emptyStreamState,
  mergeReduce,
  parseApprovalReply,
  parsePromptReply,
  promptHint,
  renderApproval,
  renderForTier,
  renderPrompt,
  route,
  streamReduce,
  stripReasoningTags,
  stripToolCallMarkup,
  type ChannelStore,
  type DeliverQueueEffect,
  type DeliverQueueOptions,
  type DeliverQueueState,
  type MergeEffect,
  type MergeState,
  type PendingApproval,
  type PendingPrompt,
  type PromptOptions,
  type QueuedDelivery,
  type RouteDecision,
  type StreamCaps,
  type StreamFrame,
  type StreamInput,
  type StreamState,
} from 'dsh-channel-kit'
import type { TelegramChannel } from './channel.js'
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage, TelegramPhotoSize } from './client.js'
import { hasMedia, messageText, senderName, toChatKey } from './client.js'

export interface TelegramBridgeConfig {
  allowedUserIds: number[]
  provider: string
  model?: string
  cwd?: string
  agentPreset?: string
  pollingTimeoutSec: number
  mergeWindowSec: number
  approvalTimeoutSec: number
  maxInboundMediaBytes?: number
  accountId?: string
  proxyUrl?: string
}

/** Payload carried through the deliver queue for a single chunk. */
interface TelegramDelivery {
  chatKey: string
  markdown: string
  origin?: OutboundMessage['origin']
}

interface MergeBuffered {
  state: MergeState
  messageIds: string[]
}

interface ApprovalEntry extends PendingApproval {
  agentId: string
  chatKey: string
  timer?: NodeJS.Timeout
  resolve?: (outcome: 'allowed-once' | 'rejected' | 'deferred') => void
  messageId?: number
}

interface PromptEntry extends PendingPrompt {
  chatKey: string
  timer?: NodeJS.Timeout
  messageId?: number
}

interface AgentPresetJoin {
  presetId?: string
  mount?: (agentCtx: Context) => Promise<void>
}

/** Minimal duck type for dsh-agent-presets (optional dependency, not imported as a package). */
interface AgentPresetsLike {
  resolve: (id?: string) => Promise<{ id: string }>
  mount: (agentCtx: Context, id?: string) => Promise<unknown>
}

/** Minimal duck type for dsh-user-questions (optional dependency, not imported as a package). */
interface UserQuestionsLike {
  registerProvider(provider: UserQuestionProviderLike): () => void
}
interface UserQuestionProviderLike {
  ask(request: AskUserQuestionRequestLike): Promise<AskUserQuestionAnswerLike>
}
interface AskUserQuestionRequestLike {
  questions: AskUserQuestionItemLike[]
  agent?: { id: string }
  signal?: AbortSignal
}
interface AskUserQuestionItemLike {
  id: string
  question: string
  detail?: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  intent?: { kind: 'plan-review'; approve: string }
}
interface AskUserQuestionAnswerLike {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

/** Minimal duck type for dsh-attachment (optional dependency; when missing, images degrade to fileRef facts). */
interface AttachmentsLike {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRef>
}

export class TelegramBridge {
  private readonly ctx: Context
  private readonly source: () => TelegramBridgeConfig
  private readonly store: ChannelStore
  private readonly channel: TelegramChannel
  private readonly client: TelegramClient

  private readonly mergeStates = new Map<string, MergeState>()
  private readonly mergeMessageIds = new Map<string, string[]>()
  private readonly mergeSenderIds = new Map<string, string>()
  private readonly mergeTimers = new Map<string, NodeJS.Timeout>()
  private readonly sessionChatKeys = new Map<string, string>()
  private readonly ownedHandles = new Map<string, AgentHandle>()
  private readonly pendingApprovals = new Map<number, ApprovalEntry>()
  private readonly pendingPrompts = new Map<number, PromptEntry>()
  private readonly lastTypingAt = new Map<string, number>()
  private readonly streamStates = new Map<string, StreamState>()
  private readonly streamTimers = new Map<string, NodeJS.Timeout>()
  private readonly draftMessageIds = new Map<string, number>()
  private readonly toolCallNames = new Map<string, string>()
  private readonly deliverQueueStates = new Map<string, DeliverQueueState<TelegramDelivery>>()
  private readonly deliverQueueTimers = new Map<string, NodeJS.Timeout>()
  private readonly disposers: Array<() => void> = []

  private promptSeq = 0
  private pollAbort: AbortController | null = null
  private pollPromise: Promise<void> | null = null
  private started = false
  private botIdentity: { id: number; username?: string } | undefined
  private botIdentityPromise: Promise<{ id: number; username?: string } | undefined> | null = null

  constructor(ctx: Context, source: () => TelegramBridgeConfig, store: ChannelStore, channel: TelegramChannel, client: TelegramClient) {
    this.ctx = ctx
    this.source = source
    this.store = store
    this.channel = channel
    this.client = client
  }

  /** Dynamic config read: the settings seam may swap the source at runtime. */
  private get config(): TelegramBridgeConfig {
    return this.source()
  }

  /** Account-qualified session id segment; empty for the default account (backward compatible). */
  private get accountSegment(): string {
    const account = this.channel.accountId
    return account !== 'default' ? `:${account}` : ''
  }

  private sessionIdFor(chatKey: string): string {
    return `channel:${this.channel.id}${this.accountSegment}:${chatKey}`
  }

  /** accountId for outbound messages; present only when non-default. */
  private get accountQualifier(): { accountId?: string } {
    const account = this.channel.accountId
    return account !== 'default' ? { accountId: account } : {}
  }

  /** Mirror a sessionId → chatKey binding into the registry (cross-provider proactive-push seam). */
  private registerSessionBinding(sessionId: string, chatKey: string): void {
    this.ctx.channels.bindChatKey(sessionId, this.channel.id, chatKey, this.channel.accountId)
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    this.disposers.push(this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.onSessionEvent(session, event)
    }))
    this.disposers.push(this.ctx.on('approval/request', async (req, next) => this.onApprovalRequest(req, next)))

    this.ctx.emit('channel/status', 'telegram', 'connecting')
    await this.restore()
    // Learn the bot's own id/username once up front so group `mentionsBot` can be observed accurately.
    await this.resolveBotIdentity().catch(() => {})
    this.startPolling()
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false

    this.pollAbort?.abort()
    if (this.pollPromise) {
      await this.pollPromise.catch(() => {})
      this.pollPromise = null
    }
    this.pollAbort = null

    for (const disposer of this.disposers.splice(0)) {
      try {
        disposer()
      } catch {
        // Ignore listener disposer errors.
      }
    }

    for (const timer of this.mergeTimers.values()) clearTimeout(timer)
    this.mergeTimers.clear()
    for (const timer of this.streamTimers.values()) clearTimeout(timer)
    this.streamTimers.clear()
    this.streamStates.clear()
    this.draftMessageIds.clear()
    this.toolCallNames.clear()
    for (const timer of this.deliverQueueTimers.values()) clearTimeout(timer)
    this.deliverQueueTimers.clear()
    this.deliverQueueStates.clear()
    for (const entry of this.pendingApprovals.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.resolve?.('deferred')
    }
    this.pendingApprovals.clear()
    for (const entry of this.pendingPrompts.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.resolve([], undefined)
    }
    this.pendingPrompts.clear()

    for (const [sessionId, handle] of [...this.ownedHandles]) {
      try {
        await handle.dispose()
      } catch {
        // The agent may already have been released by another fiber.
      }
      this.ownedHandles.delete(sessionId)
    }

    await this.store.flush()
  }

  // ---- Startup restore ----

  private async restore(): Promise<void> {
    // Undelivered merge-window buffers: after restore, treat them as just arrived and restart the window.
    const now = Date.now()
    const buffers = this.store.mergeBuffers()
    for (const [chatKey, buffer] of Object.entries(buffers)) {
      this.mergeStates.set(chatKey, { buffer, deadline: now + this.config.mergeWindowSec * 1000 })
      this.mergeMessageIds.set(chatKey, [])
      this.armMergeTimer(chatKey, now + this.config.mergeWindowSec * 1000)
    }

    // Restore bindings: chatKey → sessionId.
    for (const [chatKey, sessionId] of Object.entries(this.store.bindings())) {
      this.sessionChatKeys.set(sessionId, chatKey)
      try {
        await this.ensureAgent(sessionId, chatKey, false)
      } catch {
        // A failed restore does not block channel startup; the first message retries create.
      }
    }

    this.markSeenFromSessionLogs()
    await this.recoverDeliveries()
  }

  private markSeenFromSessionLogs(): void {
    for (const agent of this.ctx.agents.list()) {
      const chatKey = this.sessionChatKeys.get(agent.id)
      if (!chatKey) continue
      for (const event of agent.session.events) {
        if (event.type !== 'user/message') continue
        const source = event.data.source as { kind?: string; channel?: string; messageIds?: readonly string[] } | undefined
        if (source?.kind !== 'channel' || source.channel !== 'telegram') continue
        for (const messageId of source.messageIds ?? []) {
          this.store.markInbound(messageId)
        }
      }
    }
  }

  private async recoverDeliveries(): Promise<void> {
    const recoverable = this.store.sweepRecoverable()
    for (const item of recoverable) {
      const { sessionId, seq } = splitDeliveryKey(item.key)
      if (sessionId === undefined || seq === undefined) {
        this.store.markFailed(item.key, `recovery: cannot parse delivery key ${item.key}`)
        continue
      }
      const agent = this.ctx.agents.get(SessionId(sessionId))
      const event = agent?.session.events[seq]
      if (!agent || !event || event.type !== 'assistant/message') {
        this.store.markFailed(item.key, `recovery: session event ${item.key} unavailable`)
        continue
      }
      const text = assistantMessageText(event.data.message)
      if (text === '') {
        this.store.markFailed(item.key, `recovery: empty assistant message ${item.key}`)
        continue
      }
      // Reconciliation: for uncertain (attempting/failed) deliveries, ask the channel
      // whether it already landed before a blind resend. 'confirmed-absent' and 'unknown'
      // fall through to a (marked) resend; a reconcile failure degrades to 'unknown'.
      if (item.state !== 'pending' && this.channel.supportsReconciliation) {
        try {
          const verdict = await this.channel.reconcile(item.chatKey, item.key, hashText(text))
          if (verdict === 'confirmed-sent') {
            this.store.markDelivered(item.key, [])
            continue
          }
        } catch {
          // fall through to resend
        }
      }
      const marker = item.state === 'pending' ? '' : '(resumed resend, may duplicate)\n'
      try {
        await this.sendOutbound(item.chatKey, marker + text, item.key, { origin: { sessionId, seq }, recover: item.state })
      } catch (error) {
        this.store.markFailed(item.key, error instanceof Error ? error.message : String(error))
      }
    }
  }

  // ---- Polling ----

  private startPolling(): void {
    this.pollAbort = new AbortController()
    this.pollPromise = this.pollLoop(this.pollAbort.signal)
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
    const chat = message.chat
    const chatKey = toChatKey(chat)
    const senderId = message.from ? String(message.from.id) : ''
    if (message.from?.is_bot) return

    if (chat.type !== 'private') {
      // v1 group chats are not routed, but facts are still ingested (usable for policy-plugin auditing).
      this.ingest(chatKey, senderId, message, chat.type === 'supergroup' || chat.type === 'group' ? 'group' : 'direct')
      return
    }

    const allowed = this.config.allowedUserIds.includes(Number(senderId))
    if (!allowed) {
      await this.sendLocal(chatKey, '⚠️ You are not authorized to use this bot.')
      return
    }

    const messageId = String(message.message_id)
    if (this.store.seenInbound(messageId)) return

    // Approval/prompt replies take priority over merge/router and must be handled immediately (openclaw control-command iron rule).
    const activePending = [...this.pendingApprovals.values()]
    const approvalReply = parseApprovalReply({ text: messageText(message) }, activePending)
    if (approvalReply.kind === 'answer') {
      this.resolveApproval(approvalReply.num, approvalReply.outcome)
      this.store.markInbound(messageId)
      return
    }
    const promptReply = parsePromptReply({ text: messageText(message) }, [...this.pendingPrompts.values()])
    if (promptReply.kind === 'answer') {
      this.resolvePrompt(promptReply.num, promptReply.answer)
      this.store.markInbound(messageId)
      return
    }

    const text = messageText(message)
    const isCommand = text.trim().startsWith('/')

    this.ingest(chatKey, senderId, message, 'direct')

    if (isCommand) {
      await this.flushBuffered(chatKey)
      await this.handleCommand(text.trim(), chatKey)
      this.store.markInbound(messageId)
      return
    }

    if (hasMedia(message)) {
      await this.flushBuffered(chatKey)
      // Download images → saveImage → model-visible image block; other media only carry fileRef facts (not downloaded).
      const images = await this.downloadInboundImages(message)
      if (text.trim() !== '' || images.length > 0) {
        await this.dispatchText(chatKey, text, [messageId], senderId, images)
      }
      this.store.markInbound(messageId)
      return
    }

    if (text.trim() === '') {
      this.store.markInbound(messageId)
      return
    }

    const oldState = this.mergeStates.get(chatKey) ?? emptyMergeState
    const result = mergeReduce(
      oldState,
      { kind: 'message', text, hasMedia: false, isCommand: false, now: Date.now() },
      { windowMs: this.config.mergeWindowSec * 1000 },
    )
    this.mergeStates.set(chatKey, result.state)
    this.mergeMessageIds.set(chatKey, [...(this.mergeMessageIds.get(chatKey) ?? []), messageId])
    this.mergeSenderIds.set(chatKey, senderId)
    this.store.setMergeBuffer(chatKey, result.state.buffer)

    await this.handleMergeEffects(chatKey, result.state, result.effects, messageId)
    this.store.markInbound(messageId)
  }

  private ingest(chatKey: string, senderId: string, message: TelegramMessage, chatType: 'direct' | 'group'): void {
    const media = mediaFacts(message)
    const inbound: InboundMessage = {
      channel: 'telegram',
      chatKey,
      senderId,
      senderName: senderName(message.from),
      messageId: String(message.message_id),
      chatType,
      text: messageText(message),
      timestamp: message.date * 1000,
      hasMedia: hasMedia(message),
      media,
      mentionsBot: mentionsBotOf(message, this.botIdentity),
      replyToMessageId: message.reply_to_message ? String(message.reply_to_message.message_id) : undefined,
    }
    this.ctx.channels.ingest(inbound)
  }

  /** Download inbound images and store via `ctx.attachments.saveImage` (visible to the R7 model); missing/failure degrades to fileRef facts. */
  private async downloadInboundImages(message: TelegramMessage): Promise<ImageAttachmentRef[]> {
    const photo = largestPhoto(message.photo)
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

  private async flushBuffered(chatKey: string): Promise<void> {
    const state = this.mergeStates.get(chatKey)
    if (!state || state.buffer.length === 0) return
    const text = state.buffer.join('\n')
    const ids = this.mergeMessageIds.get(chatKey) ?? []
    const senderId = this.mergeSenderIds.get(chatKey) ?? '0'
    this.mergeStates.set(chatKey, emptyMergeState)
    this.mergeMessageIds.set(chatKey, [])
    this.mergeSenderIds.delete(chatKey)
    this.store.setMergeBuffer(chatKey, [])
    this.clearMergeTimer(chatKey)
    await this.dispatchText(chatKey, text, ids, senderId)
  }

  private async handleMergeEffects(chatKey: string, state: MergeState, effects: MergeEffect[], ackMessageId?: string): Promise<void> {
    for (const effect of effects) {
      if (effect.kind === 'armTimer') {
        this.armMergeTimer(chatKey, effect.at)
      } else if (effect.kind === 'ack-long') {
        await this.ackLong(chatKey, ackMessageId)
      } else if (effect.kind === 'flush') {
        const ids = this.mergeMessageIds.get(chatKey) ?? []
        const senderId = this.mergeSenderIds.get(chatKey) ?? '0'
        this.mergeMessageIds.set(chatKey, [])
        this.mergeSenderIds.delete(chatKey)
        this.mergeStates.set(chatKey, emptyMergeState)
        this.store.setMergeBuffer(chatKey, [])
        this.clearMergeTimer(chatKey)
        await this.dispatchText(chatKey, effect.text, ids, senderId)
      }
    }
  }

  /** ack-long: react to the inbound message when supported, otherwise fall back to a text ack. */
  private async ackLong(chatKey: string, messageId?: string): Promise<void> {
    if (this.channel.supportsReactions && messageId !== undefined) {
      try {
        await this.channel.react(chatKey, messageId, '👀')
        return
      } catch {
        // Reaction failed (decorative); fall through to the text ack.
      }
    }
    await this.sendLocal(chatKey, 'Received, working on it…')
  }

  private armMergeTimer(chatKey: string, at: number): void {
    this.clearMergeTimer(chatKey)
    const delay = Math.max(0, at - Date.now())
    const timer = setTimeout(() => {
      this.mergeTimers.delete(chatKey)
      void this.onMergeTick(chatKey)
    }, delay)
    timer.unref?.()
    this.mergeTimers.set(chatKey, timer)
  }

  private clearMergeTimer(chatKey: string): void {
    const timer = this.mergeTimers.get(chatKey)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.mergeTimers.delete(chatKey)
    }
  }

  private async onMergeTick(chatKey: string): Promise<void> {
    const state = this.mergeStates.get(chatKey) ?? emptyMergeState
    const result = mergeReduce(state, { kind: 'tick', now: Date.now() }, { windowMs: this.config.mergeWindowSec * 1000 })
    this.mergeStates.set(chatKey, result.state)
    this.store.setMergeBuffer(chatKey, result.state.buffer)
    await this.handleMergeEffects(chatKey, result.state, result.effects)
  }

  // ---- Routing and delivery ----

  private routeContext() {
    return {
      channel: 'telegram',
      accountId: this.channel.accountId,
      boundSessions: this.store.bindings(),
      liveSessionIds: this.ctx.agents.list().map((agent) => agent.id),
    }
  }

  private async dispatchText(chatKey: string, text: string, messageIds: string[], senderId = '0', images: readonly ImageAttachmentRef[] = []): Promise<void> {
    const decision = route(
      { chatKey, text, chatType: 'direct' },
      this.routeContext(),
      { isApprovalReply: (value) => parseApprovalReply({ text: value }, [...this.pendingApprovals.values()]).kind === 'answer' },
    )

    if (decision.kind === 'drop') return
    if (decision.kind === 'approval-reply') return
    if (decision.kind === 'command') {
      await this.handleCommand(`/${decision.command} ${decision.args}`.trim(), chatKey)
      return
    }

    const agent = await this.ensureAgent(decision.sessionId, chatKey, decision.create)
    if (!agent) {
      await this.sendLocal(chatKey, '⚠️ Unable to create or resume session.')
      return
    }

    const content: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef }> = []
    if (text !== '') content.push({ type: 'text', text })
    for (const attachment of images) content.push({ type: 'image', attachment })

    const message: UserMessage = createUserMessage({
      content,
      source: {
        kind: 'channel' as const,
        channel: 'telegram',
        chatKey,
        senderId,
        messageIds: [...messageIds],
      },
    })

    if (agent.status === 'running') {
      agent.steer(message)
    } else {
      agent.followup(message)
    }
    this.sessionChatKeys.set(agent.id, chatKey)
  }

  private async ensureAgent(sessionId: string, chatKey: string, create: boolean): Promise<Agent | undefined> {
    this.sessionChatKeys.set(sessionId, chatKey)
    this.registerSessionBinding(sessionId, chatKey)
    const existing = this.ctx.agents.get(SessionId(sessionId))
    if (existing) return existing

    const agentOptions = {
      provider: this.config.provider,
      ...(this.config.model !== undefined ? { model: this.config.model } : {}),
    }

    // Tools are the preset's (agent-plane) responsibility: join the host default preset and keep the stock capabilities.
    const preset = await this.resolveAgentPreset()
    const setup = (agentCtx: Context) => this.setupAgent(agentCtx, preset.mount)

    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions,
        setup,
      })
      this.ownedHandles.set(sessionId, handle)
      return handle.agent
    } catch {
      if (!create) return undefined
      const handle = await this.ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: {
          // cwd must be provided: the persona's {{cwd}} variable, the fs workspace, and the session workspace key all depend on it.
          // By default it uses process.cwd() (the directory where dsh was started), the same workspace as Web sessions.
          cwd: this.config.cwd ?? process.cwd(),
          ...(preset.presetId !== undefined ? { agentPreset: preset.presetId } : {}),
        },
        agentOptions,
        setup,
      })
      this.ownedHandles.set(sessionId, handle)
      return handle.agent
    }
  }

  /**
   * Resolve the preset the agent should join: an explicit `config.agentPreset` wins,
   * otherwise the host default preset (`dsh-agent-presets`'s `defaultId`) is used.
   * With no preset roster, return empty — the agent goes through the host global
   * layer (TUI single session / no-roster deployment).
   */
  private async resolveAgentPreset(): Promise<AgentPresetJoin> {
    const presets = this.ctx.get('agentPresets') as AgentPresetsLike | undefined
    if (presets === undefined) return {}
    const resolvedId = (await presets.resolve(this.config.agentPreset)).id
    return {
      presetId: resolvedId,
      mount: (agentCtx) => presets.mount(agentCtx, resolvedId).then(() => {}),
    }
  }

  private async setupAgent(agentCtx: Context, mount?: (agentCtx: Context) => Promise<void>): Promise<void> {
    try {
      const systemPrompt = agentCtx.get('systemPrompt')
      systemPrompt?.section({
        name: 'dsh-channel-telegram',
        order: 120,
        text: promptHint({
          id: 'telegram',
          formatTier: this.channel.formatTier,
          maxMessageChars: this.channel.maxMessageChars,
          supportsChoices: this.channel.supportsChoices,
        }),
      })
    } catch {
      // systemPrompt is an optional dependency; a missing/broken one does not block agent creation.
    }
    this.registerUserQuestionsProvider(agentCtx)
    // Joining the preset must happen inside the agent factory's setup; failure rolls back the whole creation.
    if (mount !== undefined) {
      await mount(agentCtx)
    }
  }

  /**
   * Register the user-questions provider in the agent scope (dsh's "options A/B" seam).
   * Duck typing + ctx.get: `dsh-user-questions` is not in inject; when missing, skip
   * gracefully — that agent's questions go through another provider or fail-closed
   * (NO_PROVIDER), and messaging is unaffected (R2/A3).
   * registerProvider is a single slot; degrade silently on DUPLICATE_PROVIDER.
   */
  private registerUserQuestionsProvider(agentCtx: Context): void {
    const userQuestions = agentCtx.get('userQuestions') as UserQuestionsLike | undefined
    if (userQuestions === undefined) return
    try {
      userQuestions.registerProvider({ ask: (request) => this.askUserQuestions(request) })
    } catch {
      // Single-slot conflict: this scope already has a provider; don't grab it, and don't block agent creation.
    }
  }

  private async askUserQuestions(request: AskUserQuestionRequestLike): Promise<AskUserQuestionAnswerLike> {
    const agentId = request.agent?.id
    const chatKey = agentId !== undefined ? this.sessionChatKeys.get(agentId) : undefined
    if (chatKey === undefined) return { answers: [] }

    const answers: Array<{ id: string; selected: string[]; custom?: string }> = []
    for (const question of request.questions) {
      if (request.signal?.aborted) break
      const num = ++this.promptSeq
      const answer = await this.askQuestion(chatKey, num, question, request.signal)
      answers.push({ id: question.id, selected: answer.selected, custom: answer.custom })
    }
    return { answers }
  }

  private askQuestion(
    chatKey: string,
    num: number,
    question: AskUserQuestionItemLike,
    signal?: AbortSignal,
  ): Promise<{ selected: string[]; custom?: string }> {
    const options = question.options?.map((option) => option.label) ?? []

    let settle!: (selected: readonly string[], custom?: string) => void
    const verdict = new Promise<{ selected: string[]; custom?: string }>((resolve) => {
      settle = (selected, custom) => resolve({ selected: [...selected], custom })
    })

    const entry: PromptEntry = {
      num,
      requestId: `channel-telegram:${Date.now()}:${num}`,
      question: question.question,
      detail: question.detail,
      options,
      multiSelect: question.multiSelect ?? false,
      allowFreeText: true, // Free text is always available (hermes clarify's "Other" / openclaw's isOther:true).
      intent: question.intent,
      expiresAt: Date.now() + this.config.approvalTimeoutSec * 1000,
      resolve: (selected, custom) => settle(selected, custom),
      chatKey,
    }
    this.pendingPrompts.set(num, entry)

    const onAbort = () => {
      this.pendingPrompts.delete(num)
      if (entry.timer) clearTimeout(entry.timer)
      settle([])
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const rendered = renderPrompt(
      {
        num,
        question: question.question,
        detail: question.detail,
        options,
        multiSelect: question.multiSelect,
        allowFreeText: true,
        intent: question.intent,
      },
      this.promptCaps(),
    )
    void this.sendPromptRendered(chatKey, num, rendered, entry).catch(() => {})

    entry.timer = setTimeout(() => {
      this.pendingPrompts.delete(num)
      settle([])
    }, this.config.approvalTimeoutSec * 1000)
    entry.timer.unref?.()

    return verdict
  }

  private promptCaps(): PromptOptions {
    return {
      supportsChoices: this.channel.supportsChoices,
      supportsMultiSelect: this.channel.supportsMultiSelect,
      presentationLimits: this.channel.presentationLimits,
    }
  }

  private async sendPromptRendered(
    chatKey: string,
    _num: number,
    rendered: { kind: 'choices'; text: string; choices: ReadonlyArray<{ id: string; label: string }> } | { kind: 'text'; text: string },
    entry: PromptEntry,
  ): Promise<void> {
    const deliveryKey = `prompt:${entry.requestId}`
    const text = renderForTier(rendered.text, this.channel.formatTier)
    const out: OutboundMessage =
      rendered.kind === 'choices'
        ? { channel: 'telegram', ...this.accountQualifier, chatKey, markdown: text, choices: rendered.choices.map((c) => ({ id: c.id, label: c.label })), deliveryKey }
        : { channel: 'telegram', ...this.accountQualifier, chatKey, markdown: text, deliveryKey }
    try {
      const receipt = await this.ctx.channels.deliver(out)
      const platformId = receipt.platformMessageIds?.[0]
      if (platformId) entry.messageId = Number(platformId)
    } catch {
      // Prompt send failed: the answerer fails closed after timeout (empty answer); never default to allowing.
    }
  }

  // ---- Outbound ----

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const chatKey = this.sessionChatKeys.get(session.id)
    if (!chatKey) return

    if (event.type === 'turn/start') {
      void this.onTurnStart(chatKey).catch(() => {})
      this.feedStream(session.id, chatKey, { kind: 'turn-start' })
    } else if (event.type === 'assistant/message') {
      const text = assistantMessageText(event.data.message)
      if (text !== '') {
        this.feedStream(session.id, chatKey, { kind: 'assistant-message', text }, { seq: event.seq })
      }
    } else if (event.type === 'tool/call') {
      this.toolCallNames.set(String(event.data.callId), event.data.name)
      this.feedStream(session.id, chatKey, { kind: 'tool-call', callId: String(event.data.callId), name: event.data.name, arguments: event.data.arguments })
    } else if (event.type === 'tool/result') {
      const callId = String(event.data.message.content[0].toolCallId)
      const name = this.toolCallNames.get(callId) ?? 'tool'
      this.toolCallNames.delete(callId)
      this.feedStream(session.id, chatKey, { kind: 'tool-result', callId, name, ok: event.data.error === undefined, summary: event.data.error?.name })
    } else if (event.type === 'turn/end' && event.data.reason.kind !== 'completed') {
      const label = turnEndLabel(event.data.reason.kind)
      void this.sendLocal(chatKey, `⏹ Turn ended: ${label}`, { silent: true }).catch(() => {})
      this.feedStream(session.id, chatKey, { kind: 'turn-end', reason: event.data.reason.kind })
    }
  }

  // ---- Streaming presentation (streamReduce frame executor) ----

  private streamCaps(): StreamCaps {
    return {
      streamingMode: this.channel.streamingMode,
      supportsEdit: this.channel.supportsEdit,
      supportsStatusText: this.channel.supportsStatusText,
      supportsThinking: this.channel.supportsThinking,
    }
  }

  private feedStream(sessionId: string, chatKey: string, input: StreamInput, deliveryCtx?: { seq?: number }): void {
    if (input.kind !== 'tick') this.clearStreamTimer(sessionId)
    const state = this.streamStates.get(sessionId) ?? emptyStreamState
    const result = streamReduce(state, input, this.streamCaps(), Date.now())
    this.streamStates.set(sessionId, result.state)
    for (const frame of result.frames) this.executeStreamFrame(sessionId, chatKey, frame, deliveryCtx)
  }

  private executeStreamFrame(sessionId: string, chatKey: string, frame: StreamFrame, deliveryCtx?: { seq?: number }): void {
    switch (frame.kind) {
      case 'noop':
        return
      case 'final': {
        const seq = deliveryCtx?.seq
        const deliveryKey = seq !== undefined ? `${sessionId}:${seq}` : `stream:${sessionId}:${Date.now()}`
        void this.sendOutbound(chatKey, frame.text, deliveryKey, { origin: { sessionId, seq } }).catch(() => {})
        return
      }
      case 'draft':
        void this.showDraft(chatKey, sessionId, frame.text).catch(() => {})
        return
      case 'draft-finalize':
        void this.finalizeDraft(chatKey, sessionId).catch(() => {})
        return
      case 'arm-timer':
        this.armStreamTimer(sessionId, chatKey, frame.at)
        return
    }
  }

  private async showDraft(chatKey: string, sessionId: string, text: string): Promise<void> {
    const token = await this.requireToken()
    const html = renderForTier(text, 'html')
    const existing = this.draftMessageIds.get(sessionId)
    const draftKey = `draft:${sessionId}`
    if (existing === undefined) {
      const sent = await this.client.sendMessage(token, chatKey, html, { parseMode: 'HTML' })
      this.draftMessageIds.set(sessionId, sent.message_id)
      this.ctx.emit('channel/present', { kind: 'draft-new', channel: 'telegram', chatKey, draftKey, text } satisfies PresentationFrame)
    } else {
      await this.client.editMessageText(token, chatKey, existing, html, { parseMode: 'HTML' })
      this.ctx.emit('channel/present', { kind: 'draft-edit', channel: 'telegram', chatKey, draftKey, editTarget: String(existing), text } satisfies PresentationFrame)
    }
  }

  private async finalizeDraft(chatKey: string, sessionId: string): Promise<void> {
    const existing = this.draftMessageIds.get(sessionId)
    if (existing === undefined) return
    this.draftMessageIds.delete(sessionId)
    try {
      const token = await this.requireToken()
      await this.client.deleteMessage(token, chatKey, existing)
    } catch {
      // Draft deletion is best-effort; the final answer is already sent separately.
    }
    this.ctx.emit('channel/present', { kind: 'draft-finalize', channel: 'telegram', chatKey, draftKey: `draft:${sessionId}` } satisfies PresentationFrame)
  }

  private armStreamTimer(sessionId: string, chatKey: string, at: number): void {
    this.clearStreamTimer(sessionId)
    const delay = Math.max(0, at - Date.now())
    const timer = setTimeout(() => {
      this.streamTimers.delete(sessionId)
      this.feedStream(sessionId, chatKey, { kind: 'tick' })
    }, delay)
    timer.unref?.()
    this.streamTimers.set(sessionId, timer)
  }

  private clearStreamTimer(sessionId: string): void {
    const timer = this.streamTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.streamTimers.delete(sessionId)
    }
  }

  private async onTurnStart(chatKey: string): Promise<void> {
    if (!this.channel.supportsTyping) return
    const now = Date.now()
    const last = this.lastTypingAt.get(chatKey) ?? 0
    if (now - last < 5000) return
    this.lastTypingAt.set(chatKey, now)
    await this.channel.sendTyping(chatKey)
  }

  private sendOutbound(
    chatKey: string,
    markdown: string,
    deliveryKey: string,
    opts: { origin?: OutboundMessage['origin']; recover?: 'pending' | 'attempting' | 'failed' } = {},
  ): Promise<void> {
    const html = renderForTier(markdown, 'html')
    const maxChars = this.channel.maxMessageChars ?? 4096
    const chunks = chunkText(html, { maxChars, countBy: 'utf16' })

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      const key = chunks.length === 1 ? deliveryKey : `${deliveryKey}:${i + 1}`
      if (!opts.recover) {
        this.store.recordDelivery(key, { chatKey, textHash: hashText(chunk) })
      }
      this.enqueueDelivery(chatKey, { key, value: { chatKey, markdown: chunk, origin: opts.origin } })
    }
    return Promise.resolve()
  }

  // ---- Deliver queue (serial worker + retry + backpressure per chatKey) ----

  private deliverQueueOptions(): DeliverQueueOptions {
    return { maxRetries: 3, baseDelayMs: 1000, maxQueue: 32, spacingMs: 1000 }
  }

  private enqueueDelivery(chatKey: string, item: QueuedDelivery<TelegramDelivery>): void {
    const state = this.deliverQueueStates.get(chatKey) ?? emptyDeliverQueueState<TelegramDelivery>()
    const result = deliverQueueReduce(state, { kind: 'enqueue', item, now: Date.now() }, this.deliverQueueOptions())
    this.deliverQueueStates.set(chatKey, result.state)
    this.runDeliverEffects(chatKey, result.effects)
  }

  private runDeliverEffects(chatKey: string, effects: DeliverQueueEffect<TelegramDelivery>[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'attempt':
          void this.performAttempt(chatKey, effect.item)
          break
        case 'retry-after':
          this.armDeliverTimer(chatKey, effect.at)
          break
        case 'give-up':
          this.store.markFailed(effect.item.key, effect.error)
          break
        case 'reject-backpressure':
          this.store.markFailed(effect.item.key, 'delivery queue full (backpressure)')
          break
      }
    }
  }

  private async performAttempt(chatKey: string, item: QueuedDelivery<TelegramDelivery>): Promise<void> {
    this.store.markAttempting(item.key)
    try {
      const receipt = await this.ctx.channels.deliver({
        channel: 'telegram',
        ...this.accountQualifier,
        chatKey: item.value.chatKey,
        markdown: item.value.markdown,
        deliveryKey: item.key,
        origin: item.value.origin,
      })
      if (receipt.status === 'sent') {
        this.store.markDelivered(item.key, receipt.platformMessageIds ?? [])
        this.feedAttemptResult(chatKey, item.key, 'sent')
      } else if (receipt.status === 'suppressed') {
        this.store.markDelivered(item.key, [])
        this.feedAttemptResult(chatKey, item.key, 'suppressed')
      } else {
        this.feedAttemptResult(chatKey, item.key, 'failed', receipt.error ?? 'delivery failed')
      }
    } catch (error) {
      this.feedAttemptResult(chatKey, item.key, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  private feedAttemptResult(chatKey: string, key: string, outcome: 'sent' | 'suppressed' | 'failed', error?: string): void {
    const state = this.deliverQueueStates.get(chatKey) ?? emptyDeliverQueueState<TelegramDelivery>()
    const result = deliverQueueReduce(state, { kind: 'attempt-result', key, outcome, error, now: Date.now() }, this.deliverQueueOptions())
    this.deliverQueueStates.set(chatKey, result.state)
    this.runDeliverEffects(chatKey, result.effects)
  }

  private armDeliverTimer(chatKey: string, at: number): void {
    this.clearDeliverTimer(chatKey)
    const delay = Math.max(0, at - Date.now())
    const timer = setTimeout(() => {
      this.deliverQueueTimers.delete(chatKey)
      this.onDeliverTick(chatKey)
    }, delay)
    timer.unref?.()
    this.deliverQueueTimers.set(chatKey, timer)
  }

  private clearDeliverTimer(chatKey: string): void {
    const timer = this.deliverQueueTimers.get(chatKey)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.deliverQueueTimers.delete(chatKey)
    }
  }

  private onDeliverTick(chatKey: string): void {
    const state = this.deliverQueueStates.get(chatKey) ?? emptyDeliverQueueState<TelegramDelivery>()
    const result = deliverQueueReduce(state, { kind: 'tick', now: Date.now() }, this.deliverQueueOptions())
    this.deliverQueueStates.set(chatKey, result.state)
    this.runDeliverEffects(chatKey, result.effects)
  }

  private async sendLocal(chatKey: string, markdown: string, opts: { silent?: boolean } = {}): Promise<void> {
    const html = renderForTier(markdown, 'html')
    const maxChars = this.channel.maxMessageChars ?? 4096
    const chunks = chunkText(html, { maxChars, countBy: 'utf16' })
    for (let i = 0; i < chunks.length; i++) {
      await this.ctx.channels.deliver({
        channel: 'telegram',
        ...this.accountQualifier,
        chatKey,
        markdown: chunks[i]!,
        deliveryKey: `local:${chatKey}:${Date.now()}:${i}`,
        silent: opts.silent ? true : undefined,
      })
      if (i < chunks.length - 1) await sleepWithAbort(1000, this.pollAbort?.signal)
    }
  }

  // ---- Commands ----

  private async handleCommand(commandText: string, chatKey: string): Promise<void> {
    const match = /^\/([^\s@]+)\s*(.*)$/.exec(commandText)
    const command = (match?.[1] ?? '').toLowerCase()
    const args = (match?.[2] ?? '').trim()

    if (command === 'start' || command === 'help') {
      await this.sendLocal(chatKey, 'Available commands:\n/start - Get started\n/new - New session\n/status - Session status\n/bind <sessionId> - Bind session\n/help - Help')
      return
    }
    if (command === 'new') {
      const sessionId = `${this.sessionIdFor(chatKey)}:${Date.now()}`
      this.store.setBinding(chatKey, sessionId)
      this.sessionChatKeys.set(sessionId, chatKey)
      this.registerSessionBinding(sessionId, chatKey)
      await this.sendLocal(chatKey, `✅ Created new session: ${sessionId}`)
      return
    }
    if (command === 'bind') {
      if (!args) {
        await this.sendLocal(chatKey, 'Usage: /bind <sessionId>')
        return
      }
      this.store.setBinding(chatKey, args)
      this.sessionChatKeys.set(args, chatKey)
      this.registerSessionBinding(args, chatKey)
      await this.sendLocal(chatKey, `✅ Bound to session: ${args}`)
      return
    }
    if (command === 'status') {
      const binding = this.store.bindings()[chatKey]
      const sessionId = binding ?? this.sessionIdFor(chatKey)
      const agent = this.ctx.agents.get(SessionId(sessionId))
      await this.sendLocal(chatKey, agent ? `Session ${sessionId} status: ${agent.status}` : `Session ${sessionId} is not running.`)
      return
    }
    await this.sendLocal(chatKey, `Unknown command: ${command}. Use /help for help.`)
  }

  // ---- Approval ----

  private onApprovalRequest = async (req: import('@deepseek-ai/dsh-user-approval').ApprovalRequest, next: () => Promise<import('@deepseek-ai/dsh-user-approval').ApprovalOutcome>): Promise<import('@deepseek-ai/dsh-user-approval').ApprovalOutcome> => {
    const chatKey = this.sessionChatKeys.get(req.agent.id)
    if (!chatKey) return next()

    const num = ++this.promptSeq
    const entry: ApprovalEntry = {
      num,
      requestId: `channel-telegram:${Date.now()}:${num}`,
      toolName: req.toolName,
      expiresAt: Date.now() + this.config.approvalTimeoutSec * 1000,
      agentId: req.agent.id,
      chatKey,
    }

    let settle!: (outcome: 'allowed-once' | 'rejected' | 'deferred') => void
    const verdict = new Promise<'allowed-once' | 'rejected' | 'deferred'>((resolve) => {
      settle = resolve
      entry.resolve = resolve
      this.pendingApprovals.set(num, entry)
    })

    const onAbort = () => {
      this.pendingApprovals.delete(num)
      if (entry.timer) clearTimeout(entry.timer)
      settle('deferred')
    }
    req.signal?.addEventListener('abort', onAbort, { once: true })

    await this.sendApprovalPrompt(entry, req)
    if (!this.pendingApprovals.has(num)) {
      req.signal?.removeEventListener('abort', onAbort)
      return next()
    }

    entry.timer = setTimeout(() => {
      this.pendingApprovals.delete(num)
      settle('deferred')
    }, this.config.approvalTimeoutSec * 1000)
    entry.timer.unref?.()

    const outcome = await verdict
    req.signal?.removeEventListener('abort', onAbort)
    if (entry.timer) clearTimeout(entry.timer)
    if (outcome === 'deferred') return next()
    return outcome
  }

  private async sendApprovalPrompt(entry: ApprovalEntry, req: import('@deepseek-ai/dsh-user-approval').ApprovalRequest): Promise<void> {
    const rendered = renderApproval(
      { toolName: req.toolName, reason: req.reason, num: entry.num },
      { supportsChoices: this.channel.supportsChoices },
    )
    const deliveryKey = `approval:${entry.requestId}`
    const text = renderForTier(rendered.text, this.channel.formatTier)
    const out: OutboundMessage =
      rendered.kind === 'choices'
        ? { channel: 'telegram', ...this.accountQualifier, chatKey: entry.chatKey, markdown: text, choices: rendered.choices, deliveryKey }
        : { channel: 'telegram', ...this.accountQualifier, chatKey: entry.chatKey, markdown: text, deliveryKey }

    try {
      const receipt = await this.ctx.channels.deliver(out)
      const platformId = receipt.platformMessageIds?.[0]
      if (platformId) entry.messageId = Number(platformId)
    } catch {
      // When the approval prompt fails to send, the answerer calls next() after timeout; never default to allowing.
    }
  }

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
      const reply = parsePromptReply({ choiceId: data }, [...this.pendingPrompts.values()])
      if (reply.kind === 'answer') {
        this.resolvePrompt(reply.num, reply.answer)
        const chatKey = callbackQuery.message ? toChatKey(callbackQuery.message.chat) : undefined
        const messageId = callbackQuery.message?.message_id
        if (chatKey && messageId !== undefined) {
          try {
            const token = await this.requireToken()
            const chosen = reply.answer.selected.join(', ') || reply.answer.custom || ''
            await this.client.editMessageText(token, chatKey, messageId, `✅ Selected: ${chosen}`, { parseMode: 'HTML' })
          } catch {
            // A failed edit does not block the reply.
          }
        }
      }
      return
    }
  }

  private resolveApproval(num: number, outcome: 'allowed-once' | 'rejected'): void {
    const entry = this.pendingApprovals.get(num)
    if (!entry) return
    this.pendingApprovals.delete(num)
    if (entry.timer) clearTimeout(entry.timer)
    entry.resolve?.(outcome)
  }

  private resolvePrompt(num: number, answer: { selected: readonly string[]; custom?: string }): void {
    const entry = this.pendingPrompts.get(num)
    if (!entry) return
    this.pendingPrompts.delete(num)
    if (entry.timer) clearTimeout(entry.timer)
    entry.resolve(answer.selected, answer.custom)
  }

  private async requireToken(): Promise<string> {
    const token = await this.resolveToken()
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured')
    return token
  }
}

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

function splitDeliveryKey(key: string): { sessionId?: string; seq?: number } {
  const sep = key.lastIndexOf(':')
  if (sep <= 0) return {}
  const seq = Number(key.slice(sep + 1))
  if (!Number.isInteger(seq)) return {}
  return { sessionId: key.slice(0, sep), seq }
}

function assistantMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: Array<{ type?: string; text?: string }> }).content
  if (!Array.isArray(content)) return ''
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  return stripReasoningTags(stripToolCallMarkup(text))
}

function turnEndLabel(kind: string): string {
  switch (kind) {
    case 'aborted':
      return 'Aborted'
    case 'blocked':
      return 'Blocked'
    case 'error':
      return 'Error'
    case 'max-tokens':
      return 'Max tokens'
    case 'interrupted':
      return 'Interrupted'
    default:
      return kind
  }
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

function hashText(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}
