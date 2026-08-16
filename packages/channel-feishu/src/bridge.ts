import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { InboundMessage, OutboundMessage } from 'dsh-channel'
import {
  chunkText,
  deliverQueueReduce,
  emptyDeliverQueueState,
  emptyMergeState,
  mergeReduce,
  parseApprovalReply,
  parsePromptReply,
  promptHint,
  renderApproval,
  renderForTier,
  renderPrompt,
  route,
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
} from 'dsh-channel-kit'
import type { FeishuChannel } from './channel.js'
import type { FeishuCredentials, FeishuEventV2, FeishuMessageEvent } from './client.js'
import { FeishuClient, FeishuWsClient, chatTypeOf, hasMedia, mediaFacts, messageText, senderId } from './client.js'

export interface FeishuBridgeConfig {
  allowedUserIds: string[]
  provider: string
  model?: string
  cwd?: string
  agentPreset?: string
  mergeWindowSec: number
  approvalTimeoutSec: number
  domain?: 'feishu' | 'lark'
}

/** Payload carried through the deliver queue for a single chunk. */
interface FeishuDelivery {
  chatKey: string
  markdown: string
  origin?: OutboundMessage['origin']
}

interface ApprovalEntry extends PendingApproval {
  agentId: string
  chatKey: string
  timer?: NodeJS.Timeout
  resolve?: (outcome: 'allowed-once' | 'rejected' | 'deferred') => void
}

interface PromptEntry extends PendingPrompt {
  chatKey: string
  timer?: NodeJS.Timeout
}

interface AgentPresetJoin {
  presetId?: string
  mount?: (agentCtx: Context) => Promise<void>
}

/** Minimal duck type of dsh-agent-presets (optional dependency; the package is not imported). */
interface AgentPresetsLike {
  resolve: (id?: string) => Promise<{ id: string }>
  mount: (agentCtx: Context, id?: string) => Promise<unknown>
}

/** Minimal duck type of dsh-user-questions (optional dependency; the package is not imported). */
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

export class FeishuBridge {
  private readonly ctx: Context
  private readonly source: () => FeishuBridgeConfig
  private readonly store: ChannelStore
  private readonly channel: FeishuChannel
  private readonly client: FeishuClient
  private readonly wsClient: FeishuWsClient

  private readonly mergeStates = new Map<string, MergeState>()
  private readonly mergeMessageIds = new Map<string, string[]>()
  private readonly mergeSenderIds = new Map<string, string>()
  private readonly mergeTimers = new Map<string, NodeJS.Timeout>()
  private readonly sessionChatKeys = new Map<string, string>()
  private readonly ownedHandles = new Map<string, AgentHandle>()
  private readonly pendingApprovals = new Map<number, ApprovalEntry>()
  private readonly pendingPrompts = new Map<number, PromptEntry>()
  private readonly deliverQueueStates = new Map<string, DeliverQueueState<FeishuDelivery>>()
  private readonly deliverQueueTimers = new Map<string, NodeJS.Timeout>()
  private readonly disposers: Array<() => void> = []

  private promptSeq = 0
  private started = false

  constructor(ctx: Context, source: () => FeishuBridgeConfig, store: ChannelStore, channel: FeishuChannel, client: FeishuClient) {
    this.ctx = ctx
    this.source = source
    this.store = store
    this.channel = channel
    this.client = client
    this.wsClient = new FeishuWsClient({
      domain: source().domain,
      resolveCredentials: () => this.resolveCredentials(),
      onEvent: (event) => void this.handleEvent(event),
      onStatus: (status, error) => this.ctx.emit('channel/status', 'feishu', status, error),
    })
  }

  /** Dynamic config read: the settings seam may swap the source at runtime. */
  private get config(): FeishuBridgeConfig {
    return this.source()
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    this.disposers.push(this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.onSessionEvent(session, event)
    }))
    this.disposers.push(this.ctx.on('approval/request', async (req, next) => this.onApprovalRequest(req, next)))

    this.ctx.emit('channel/status', 'feishu', 'connecting')
    await this.restore()
    await this.wsClient.start()
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false

    await this.wsClient.stop()

    for (const disposer of this.disposers.splice(0)) {
      try {
        disposer()
      } catch {
        // Ignore listener disposer errors.
      }
    }

    for (const timer of this.mergeTimers.values()) clearTimeout(timer)
    this.mergeTimers.clear()
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
        // The agent may already have been disposed by another fiber.
      }
      this.ownedHandles.delete(sessionId)
    }

    await this.store.flush()
  }

  // ---- Startup recovery ----

  private async restore(): Promise<void> {
    const now = Date.now()
    const buffers = this.store.mergeBuffers()
    for (const [chatKey, buffer] of Object.entries(buffers)) {
      this.mergeStates.set(chatKey, { buffer, deadline: now + this.config.mergeWindowSec * 1000 })
      this.mergeMessageIds.set(chatKey, [])
      this.armMergeTimer(chatKey, now + this.config.mergeWindowSec * 1000)
    }

    for (const [chatKey, sessionId] of Object.entries(this.store.bindings())) {
      this.sessionChatKeys.set(sessionId, chatKey)
      try {
        await this.ensureAgent(sessionId, chatKey, false)
      } catch {
        // Recovery failure does not block channel startup; the first message will retry create.
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
        if (source?.kind !== 'channel' || source.channel !== 'feishu') continue
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
      const marker = item.state === 'pending' ? '' : '(resumed resend, may duplicate)\n'
      try {
        await this.sendOutbound(item.chatKey, marker + text, item.key, { origin: { sessionId, seq }, recover: item.state })
      } catch (error) {
        this.store.markFailed(item.key, error instanceof Error ? error.message : String(error))
      }
    }
  }

  // ---- Credentials ----

  private async resolveCredentials(): Promise<FeishuCredentials | undefined> {
    const appId = await this.ctx.credentials.resolve(credentialRef('FEISHU_APP_ID'))
    const appSecret = await this.ctx.credentials.resolve(credentialRef('FEISHU_APP_SECRET'))
    if (!appId?.value || !appSecret?.value) return undefined
    return { appId: appId.value, appSecret: appSecret.value }
  }

  // ---- Inbound ----

  /**
   * Unified inbound event entry point: called internally by the long-connection client;
   * the host may also feed events directly in webhook mode.
   * Only `im.message.receive_v1` text events are processed; other event types are silently ignored.
   */
  async handleEvent(event: FeishuEventV2): Promise<void> {
    if (event.header?.event_type !== 'im.message.receive_v1' || event.event === undefined) return
    const messageEvent: FeishuMessageEvent = event.event

    const message = messageEvent.message
    const chatKey = message?.chat_id ?? ''
    const sender = senderId(messageEvent)
    if (!chatKey || !sender) return

    const chatType = chatTypeOf(messageEvent)
    const messageId = message?.message_id ?? ''

    // Group chats are not routed in v1, but capability facts are still emitted.
    if (chatType !== 'direct') {
      this.ingest(messageEvent, chatKey, 'group')
      return
    }

    const allowed = this.config.allowedUserIds.includes(sender)
    if (!allowed) {
      await this.sendLocal(chatKey, '⚠️ You are not authorized to use this bot.')
      return
    }

    if (messageId && this.store.seenInbound(messageId)) return

    // Approval/question replies take precedence over merge/router (openclaw control-command iron rule).
    const text = messageText(messageEvent)
    const activePending = [...this.pendingApprovals.values()]
    const approvalReply = parseApprovalReply({ text }, activePending)
    if (approvalReply.kind === 'answer') {
      this.resolveApproval(approvalReply.num, approvalReply.outcome)
      if (messageId) this.store.markInbound(messageId)
      return
    }
    const promptReply = parsePromptReply({ text }, [...this.pendingPrompts.values()])
    if (promptReply.kind === 'answer') {
      this.resolvePrompt(promptReply.num, promptReply.answer)
      if (messageId) this.store.markInbound(messageId)
      return
    }

    const isCommand = text.trim().startsWith('/')

    this.ingest(messageEvent, chatKey, 'direct')

    if (isCommand) {
      await this.flushBuffered(chatKey)
      await this.handleCommand(text.trim(), chatKey)
      if (messageId) this.store.markInbound(messageId)
      return
    }

    if (hasMedia(messageEvent)) {
      await this.flushBuffered(chatKey)
      if (text.trim() !== '') {
        await this.dispatchText(chatKey, text, [messageId].filter(Boolean), sender)
      }
      if (messageId) this.store.markInbound(messageId)
      return
    }

    if (text.trim() === '') {
      if (messageId) this.store.markInbound(messageId)
      return
    }

    const oldState = this.mergeStates.get(chatKey) ?? emptyMergeState
    const result = mergeReduce(
      oldState,
      { kind: 'message', text, hasMedia: false, isCommand: false, now: Date.now() },
      { windowMs: this.config.mergeWindowSec * 1000 },
    )
    this.mergeStates.set(chatKey, result.state)
    this.mergeMessageIds.set(chatKey, [...(this.mergeMessageIds.get(chatKey) ?? []), ...(messageId ? [messageId] : [])])
    this.mergeSenderIds.set(chatKey, sender)
    this.store.setMergeBuffer(chatKey, result.state.buffer)

    await this.handleMergeEffects(chatKey, result.state, result.effects, messageId)
    if (messageId) this.store.markInbound(messageId)
  }

  private ingest(messageEvent: FeishuMessageEvent, chatKey: string, chatType: 'direct' | 'group'): void {
    const message = messageEvent.message
    const inbound: InboundMessage = {
      channel: 'feishu',
      chatKey,
      senderId: senderId(messageEvent),
      messageId: message?.message_id ?? '',
      chatType,
      text: messageText(messageEvent),
      timestamp: message?.create_time ? Number(message.create_time) : Date.now(),
      hasMedia: hasMedia(messageEvent),
      media: mediaFacts(messageEvent),
      mentionsBot: (message?.mentions?.length ?? 0) > 0,
    }
    this.ctx.channels.ingest(inbound)
  }

  private async flushBuffered(chatKey: string): Promise<void> {
    const state = this.mergeStates.get(chatKey)
    if (!state || state.buffer.length === 0) return
    const text = state.buffer.join('\n')
    const ids = this.mergeMessageIds.get(chatKey) ?? []
    const sender = this.mergeSenderIds.get(chatKey) ?? ''
    this.mergeStates.set(chatKey, emptyMergeState)
    this.mergeMessageIds.set(chatKey, [])
    this.mergeSenderIds.delete(chatKey)
    this.store.setMergeBuffer(chatKey, [])
    this.clearMergeTimer(chatKey)
    await this.dispatchText(chatKey, text, ids, sender)
  }

  private async handleMergeEffects(chatKey: string, state: MergeState, effects: MergeEffect[], ackMessageId?: string): Promise<void> {
    for (const effect of effects) {
      if (effect.kind === 'armTimer') {
        this.armMergeTimer(chatKey, effect.at)
      } else if (effect.kind === 'ack-long') {
        await this.ackLong(chatKey, ackMessageId)
      } else if (effect.kind === 'flush') {
        const ids = this.mergeMessageIds.get(chatKey) ?? []
        const sender = this.mergeSenderIds.get(chatKey) ?? ''
        this.mergeMessageIds.set(chatKey, [])
        this.mergeSenderIds.delete(chatKey)
        this.mergeStates.set(chatKey, emptyMergeState)
        this.store.setMergeBuffer(chatKey, [])
        this.clearMergeTimer(chatKey)
        await this.dispatchText(chatKey, effect.text, ids, sender)
      }
    }
  }

  /** ack-long: react to the inbound message when supported, otherwise fall back to a text ack. */
  private async ackLong(chatKey: string, messageId?: string): Promise<void> {
    if (this.channel.supportsReactions && messageId) {
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
      channel: 'feishu',
      boundSessions: this.store.bindings(),
      liveSessionIds: this.ctx.agents.list().map((agent) => agent.id),
    }
  }

  private async dispatchText(chatKey: string, text: string, messageIds: string[], senderId = ''): Promise<void> {
    const decision: RouteDecision = route(
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

    const message: UserMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'channel' as const,
        channel: 'feishu',
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
    const existing = this.ctx.agents.get(SessionId(sessionId))
    if (existing) return existing

    const agentOptions = {
      provider: this.config.provider,
      ...(this.config.model !== undefined ? { model: this.config.model } : {}),
    }

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
        name: 'dsh-channel-feishu',
        order: 120,
        text: promptHint({
          id: 'feishu',
          formatTier: this.channel.formatTier,
          maxMessageChars: this.channel.maxMessageChars,
          supportsChoices: this.channel.supportsChoices,
        }),
      })
    } catch {
      // systemPrompt is an optional dependency; absence/errors must not block agent creation.
    }
    this.registerUserQuestionsProvider(agentCtx)
    if (mount !== undefined) {
      await mount(agentCtx)
    }
  }

  private registerUserQuestionsProvider(agentCtx: Context): void {
    const userQuestions = agentCtx.get('userQuestions') as UserQuestionsLike | undefined
    if (userQuestions === undefined) return
    try {
      userQuestions.registerProvider({ ask: (request) => this.askUserQuestions(request) })
    } catch {
      // Single-slot conflict: a provider already exists in this scope; do not steal it or block agent creation.
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
      requestId: `channel-feishu:${Date.now()}:${num}`,
      question: question.question,
      detail: question.detail,
      options,
      multiSelect: question.multiSelect ?? false,
      allowFreeText: true,
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
    void this.sendPromptRendered(chatKey, rendered).catch(() => {})

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
    rendered: { kind: 'choices'; text: string; choices: ReadonlyArray<{ id: string; label: string }> } | { kind: 'text'; text: string },
  ): Promise<void> {
    const out: OutboundMessage =
      rendered.kind === 'choices'
        ? { channel: 'feishu', chatKey, markdown: rendered.text, choices: rendered.choices.map((c) => ({ id: c.id, label: c.label })), deliveryKey: `prompt:${chatKey}:${Date.now()}` }
        : { channel: 'feishu', chatKey, markdown: rendered.text, deliveryKey: `prompt:${chatKey}:${Date.now()}` }
    try {
      await this.ctx.channels.deliver(out)
    } catch {
      // Prompt send failed: the answerer fails closed (empty answer) after timeout; never allow by default.
    }
  }

  // ---- Outbound ----

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const chatKey = this.sessionChatKeys.get(session.id)
    if (!chatKey) return

    if (event.type === 'assistant/message') {
      const text = assistantMessageText(event.data.message)
      if (text !== '') {
        void this.sendOutbound(chatKey, text, `${session.id}:${event.seq}`, { origin: { sessionId: session.id, seq: event.seq } }).catch(() => {})
      }
    } else if (event.type === 'turn/end' && event.data.reason.kind !== 'completed') {
      const label = turnEndLabel(event.data.reason.kind)
      void this.sendLocal(chatKey, `⏹ Turn ended: ${label}`).catch(() => {})
    }
  }

  private sendOutbound(
    chatKey: string,
    markdown: string,
    deliveryKey: string,
    opts: { origin?: OutboundMessage['origin']; recover?: 'pending' | 'attempting' | 'failed' } = {},
  ): Promise<void> {
    const plain = renderForTier(markdown, 'plain')
    const maxChars = this.channel.maxMessageChars ?? 4096
    const chunks = chunkText(plain, { maxChars })

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

  private enqueueDelivery(chatKey: string, item: QueuedDelivery<FeishuDelivery>): void {
    const state = this.deliverQueueStates.get(chatKey) ?? emptyDeliverQueueState<FeishuDelivery>()
    const result = deliverQueueReduce(state, { kind: 'enqueue', item, now: Date.now() }, this.deliverQueueOptions())
    this.deliverQueueStates.set(chatKey, result.state)
    this.runDeliverEffects(chatKey, result.effects)
  }

  private runDeliverEffects(chatKey: string, effects: DeliverQueueEffect<FeishuDelivery>[]): void {
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

  private async performAttempt(chatKey: string, item: QueuedDelivery<FeishuDelivery>): Promise<void> {
    this.store.markAttempting(item.key)
    try {
      const receipt = await this.ctx.channels.deliver({
        channel: 'feishu',
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
    const state = this.deliverQueueStates.get(chatKey) ?? emptyDeliverQueueState<FeishuDelivery>()
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
    const state = this.deliverQueueStates.get(chatKey) ?? emptyDeliverQueueState<FeishuDelivery>()
    const result = deliverQueueReduce(state, { kind: 'tick', now: Date.now() }, this.deliverQueueOptions())
    this.deliverQueueStates.set(chatKey, result.state)
    this.runDeliverEffects(chatKey, result.effects)
  }

  private async sendLocal(chatKey: string, markdown: string): Promise<void> {
    const plain = renderForTier(markdown, 'plain')
    const maxChars = this.channel.maxMessageChars ?? 4096
    const chunks = chunkText(plain, { maxChars })
    for (let i = 0; i < chunks.length; i++) {
      await this.ctx.channels.deliver({
        channel: 'feishu',
        chatKey,
        markdown: chunks[i]!,
        deliveryKey: `local:${chatKey}:${Date.now()}:${i}`,
      })
      if (i < chunks.length - 1) await sleep(1000)
    }
  }

  // ---- Commands ----

  private async handleCommand(commandText: string, chatKey: string): Promise<void> {
    const match = /^\/([^\s@]+)\s*(.*)$/.exec(commandText)
    const command = (match?.[1] ?? '').toLowerCase()
    const args = (match?.[2] ?? '').trim()

    if (command === 'start' || command === 'help') {
      await this.sendLocal(chatKey, 'Available commands:\n/start - Start using the bot\n/new - Create a new session\n/status - Show session status\n/bind <sessionId> - Bind a session\n/help - Show help')
      return
    }
    if (command === 'new') {
      const sessionId = `channel:feishu:${chatKey}:${Date.now()}`
      this.store.setBinding(chatKey, sessionId)
      this.sessionChatKeys.set(sessionId, chatKey)
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
      await this.sendLocal(chatKey, `✅ Bound session: ${args}`)
      return
    }
    if (command === 'status') {
      const binding = this.store.bindings()[chatKey]
      const sessionId = binding ?? `channel:feishu:${chatKey}`
      const agent = this.ctx.agents.get(SessionId(sessionId))
      await this.sendLocal(chatKey, agent ? `Session ${sessionId} status: ${agent.status}` : `Session ${sessionId} is not running.`)
      return
    }
    await this.sendLocal(chatKey, `Unknown command: ${command}. Use /help for help.`)
  }

  // ---- Approvals ----

  private onApprovalRequest = async (req: import('@deepseek-ai/dsh-user-approval').ApprovalRequest, next: () => Promise<import('@deepseek-ai/dsh-user-approval').ApprovalOutcome>): Promise<import('@deepseek-ai/dsh-user-approval').ApprovalOutcome> => {
    const chatKey = this.sessionChatKeys.get(req.agent.id)
    if (!chatKey) return next()

    const num = ++this.promptSeq
    const entry: ApprovalEntry = {
      num,
      requestId: `channel-feishu:${Date.now()}:${num}`,
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
    const out: OutboundMessage =
      rendered.kind === 'choices'
        ? { channel: 'feishu', chatKey: entry.chatKey, markdown: rendered.text, choices: rendered.choices, deliveryKey: `approval:${entry.requestId}` }
        : { channel: 'feishu', chatKey: entry.chatKey, markdown: rendered.text, deliveryKey: `approval:${entry.requestId}` }

    try {
      await this.ctx.channels.deliver(out)
    } catch {
      // When the approval prompt fails to send, the answerer calls next() after timeout; never default to allowing.
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

function hashText(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
