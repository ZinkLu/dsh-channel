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
import type { WeChatChannel } from './channel.js'
import type { WeixinClient, WeixinMessage } from './client.js'
import { chatTypeOf, hasMedia, mediaFacts, messageText, senderId, toChatKey } from './client.js'

export interface WeChatBridgeConfig {
  allowedUserIds: string[]
  /** iLink bot account id (platform-side); when unset, read from the WECHAT_ACCOUNT_ID credential. */
  platformAccountId?: string
  provider: string
  model?: string
  cwd?: string
  agentPreset?: string
  pollingTimeoutSec: number
  mergeWindowSec: number
  approvalTimeoutSec: number
  /** Instance discriminator for multi-account deployments (default 'default'). */
  accountId?: string
  proxyUrl?: string
}

/** Payload carried through the deliver queue for a single chunk. */
interface WeChatDelivery {
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

export class WeChatBridge {
  private readonly ctx: Context
  private readonly source: () => WeChatBridgeConfig
  private readonly store: ChannelStore
  private readonly channel: WeChatChannel
  private readonly client: WeixinClient

  private readonly mergeStates = new Map<string, MergeState>()
  private readonly mergeMessageIds = new Map<string, string[]>()
  private readonly mergeSenderIds = new Map<string, string>()
  private readonly mergeTimers = new Map<string, NodeJS.Timeout>()
  private readonly sessionChatKeys = new Map<string, string>()
  private readonly ownedHandles = new Map<string, AgentHandle>()
  private readonly pendingApprovals = new Map<number, ApprovalEntry>()
  private readonly pendingPrompts = new Map<number, PromptEntry>()
  private readonly typingTickets = new Map<string, string>()
  private readonly deliverQueueStates = new Map<string, DeliverQueueState<WeChatDelivery>>()
  private readonly deliverQueueTimers = new Map<string, NodeJS.Timeout>()
  private readonly disposers: Array<() => void> = []

  private promptSeq = 0
  private pollAbort: AbortController | null = null
  private pollPromise: Promise<void> | null = null
  private started = false

  constructor(ctx: Context, source: () => WeChatBridgeConfig, store: ChannelStore, channel: WeChatChannel, client: WeixinClient) {
    this.ctx = ctx
    this.source = source
    this.store = store
    this.channel = channel
    this.client = client
  }

  /** Dynamic config read: the settings seam may swap the source at runtime. */
  private get config(): WeChatBridgeConfig {
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

    this.ctx.emit('channel/status', 'wechat', 'connecting')
    await this.restore()
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
        // Recovery failure does not block channel startup; the first message retries create.
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
        if (source?.kind !== 'channel' || source.channel !== 'wechat') continue
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
      // Reconciliation: consult the channel before a blind resend (graceful 'unknown' by default).
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
    let syncBuf = ''
    let backoff = 1000
    let first = true

    while (!signal.aborted) {
      try {
        const token = await this.requireToken()
        const response = await this.client.getUpdates(token, {
          syncBuf,
          timeoutMs: this.config.pollingTimeoutSec * 1000,
          signal,
        })

        if (first) {
          first = false
          this.ctx.emit('channel/status', 'wechat', 'connected')
        }

        for (const message of response.msgs ?? []) {
          if (signal.aborted) return
          await this.processMessage(message)
        }
        const nextBuf = String(response.get_updates_buf ?? '')
        if (nextBuf) syncBuf = nextBuf
        backoff = 1000
      } catch (error) {
        if (signal.aborted) return
        this.ctx.emit('channel/status', 'wechat', 'disconnected', error instanceof Error ? error : new Error(String(error)))
        await sleepWithAbort(backoff + Math.random() * 500, signal)
        backoff = Math.min(15_000, backoff * 2)
      }
    }
  }

  private async resolveToken(): Promise<string | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef('WECHAT_TOKEN'))
    return resolved?.value
  }

  private async resolveAccountId(): Promise<string | undefined> {
    if (this.config.platformAccountId) return this.config.platformAccountId
    const resolved = await this.ctx.credentials.resolve(credentialRef('WECHAT_ACCOUNT_ID'))
    return resolved?.value
  }

  private async processMessage(message: WeixinMessage): Promise<void> {
    const accountId = (await this.resolveAccountId()) ?? ''
    const sender = senderId(message)
    // Self-message loopback guard (hermes: sender_id == account_id).
    if (!sender || sender === accountId || message.msg_type === 2) return

    const chatType = chatTypeOf(message, accountId)
    const chatKey = toChatKey(message, accountId)
    const messageId = String(message.message_id ?? message.client_id ?? '')
    if (!chatKey) return

    // Group chats are not routed in v1, but facts are still emitted (usable for policy-plugin auditing).
    if (chatType !== 'direct') {
      this.ingest(message, chatKey, 'group')
      return
    }

    const allowed = this.config.allowedUserIds.includes(sender)
    if (!allowed) {
      await this.sendLocal(chatKey, '⚠️ You are not authorized to use this bot.')
      return
    }

    if (messageId && this.store.seenInbound(messageId)) return

    // context_token echo + typing ticket warm-up (hermes ContextTokenStore / _maybe_fetch_typing_ticket).
    const contextToken = message.context_token
    if (contextToken) this.client.setContextToken(chatKey, contextToken)
    void this.warmTypingTicket(chatKey, contextToken)

    // Approval/prompt answers take priority over merge/router (openclaw control-command iron rule).
    const activePending = [...this.pendingApprovals.values()]
    const approvalReply = parseApprovalReply({ text: messageText(message) }, activePending)
    if (approvalReply.kind === 'answer') {
      this.resolveApproval(approvalReply.num, approvalReply.outcome)
      if (messageId) this.store.markInbound(messageId)
      return
    }
    const promptReply = parsePromptReply({ text: messageText(message) }, [...this.pendingPrompts.values()])
    if (promptReply.kind === 'answer') {
      this.resolvePrompt(promptReply.num, promptReply.answer)
      if (messageId) this.store.markInbound(messageId)
      return
    }

    const text = messageText(message)
    const isCommand = text.trim().startsWith('/')

    this.ingest(message, chatKey, 'direct')

    if (isCommand) {
      await this.flushBuffered(chatKey)
      await this.handleCommand(text.trim(), chatKey)
      if (messageId) this.store.markInbound(messageId)
      return
    }

    if (hasMedia(message)) {
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

    await this.handleMergeEffects(chatKey, result.state, result.effects)
    if (messageId) this.store.markInbound(messageId)
  }

  private async warmTypingTicket(chatKey: string, contextToken?: string): Promise<void> {
    try {
      const token = await this.resolveToken()
      if (!token) return
      const { typingTicket } = await this.client.getConfig(token, chatKey, { contextToken })
      if (typingTicket) this.typingTickets.set(chatKey, typingTicket)
    } catch {
      // If the ticket cannot be obtained, degrade to not sending typing.
    }
  }

  private ingest(message: WeixinMessage, chatKey: string, chatType: 'direct' | 'group'): void {
    const inbound: InboundMessage = {
      channel: 'wechat',
      chatKey,
      senderId: senderId(message),
      messageId: String(message.message_id ?? message.client_id ?? ''),
      chatType,
      text: messageText(message),
      timestamp: Date.now(),
      hasMedia: hasMedia(message),
      media: mediaFacts(message),
      // iLink messages carry no mention/at metadata, so group mentions are not observable here (unlike Telegram/Feishu).
      mentionsBot: false,
    }
    this.ctx.channels.ingest(inbound)
  }

  private async flushBuffered(chatKey: string): Promise<void> {
    const state = this.mergeStates.get(chatKey)
    if (!state || state.buffer.length === 0) return
    const text = state.buffer.join('\n')
    const ids = this.mergeMessageIds.get(chatKey) ?? []
    const senderId = this.mergeSenderIds.get(chatKey) ?? ''
    this.mergeStates.set(chatKey, emptyMergeState)
    this.mergeMessageIds.set(chatKey, [])
    this.mergeSenderIds.delete(chatKey)
    this.store.setMergeBuffer(chatKey, [])
    this.clearMergeTimer(chatKey)
    await this.dispatchText(chatKey, text, ids, senderId)
  }

  private async handleMergeEffects(chatKey: string, state: MergeState, effects: MergeEffect[]): Promise<void> {
    for (const effect of effects) {
      if (effect.kind === 'armTimer') {
        this.armMergeTimer(chatKey, effect.at)
      } else if (effect.kind === 'ack-long') {
        await this.sendLocal(chatKey, 'Received, working on it…')
      } else if (effect.kind === 'flush') {
        const ids = this.mergeMessageIds.get(chatKey) ?? []
        const senderId = this.mergeSenderIds.get(chatKey) ?? ''
        this.mergeMessageIds.set(chatKey, [])
        this.mergeSenderIds.delete(chatKey)
        this.mergeStates.set(chatKey, emptyMergeState)
        this.store.setMergeBuffer(chatKey, [])
        this.clearMergeTimer(chatKey)
        await this.dispatchText(chatKey, effect.text, ids, senderId)
      }
    }
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
      channel: 'wechat',
      accountId: this.channel.accountId,
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
      await this.sendLocal(chatKey, '⚠️ Could not create or resume the session.')
      return
    }

    const message: UserMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'channel' as const,
        channel: 'wechat',
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
        name: 'dsh-channel-wechat',
        order: 120,
        text: promptHint({
          id: 'wechat',
          formatTier: this.channel.formatTier,
          maxMessageChars: this.channel.maxMessageChars,
          supportsChoices: this.channel.supportsChoices,
        }),
      })
    } catch {
      // systemPrompt is an optional dependency; its absence or failure does not block agent creation.
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
      // Single-slot conflict: this scope already has a provider; do not steal it or block agent creation.
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
      requestId: `channel-wechat:${Date.now()}:${num}`,
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
        ? { channel: 'wechat', ...this.accountQualifier, chatKey, markdown: rendered.text, choices: rendered.choices.map((c) => ({ id: c.id, label: c.label })), deliveryKey: `prompt:${chatKey}:${Date.now()}` }
        : { channel: 'wechat', ...this.accountQualifier, chatKey, markdown: rendered.text, deliveryKey: `prompt:${chatKey}:${Date.now()}` }
    try {
      await this.ctx.channels.deliver(out)
    } catch {
      // Prompt send failure: the answerer fail-closes (empty answer) after timeout; never allow by default.
    }
  }

  // ---- Outbound ----

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const chatKey = this.sessionChatKeys.get(session.id)
    if (!chatKey) return

    if (event.type === 'turn/start') {
      void this.channel.sendTyping(chatKey).catch(() => {})
    } else if (event.type === 'assistant/message') {
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
    const maxChars = this.channel.maxMessageChars ?? 2000
    const chunks = chunkText(markdown, { maxChars })

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

  private enqueueDelivery(chatKey: string, item: QueuedDelivery<WeChatDelivery>): void {
    const state = this.deliverQueueStates.get(chatKey) ?? emptyDeliverQueueState<WeChatDelivery>()
    const result = deliverQueueReduce(state, { kind: 'enqueue', item, now: Date.now() }, this.deliverQueueOptions())
    this.deliverQueueStates.set(chatKey, result.state)
    this.runDeliverEffects(chatKey, result.effects)
  }

  private runDeliverEffects(chatKey: string, effects: DeliverQueueEffect<WeChatDelivery>[]): void {
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

  private async performAttempt(chatKey: string, item: QueuedDelivery<WeChatDelivery>): Promise<void> {
    this.store.markAttempting(item.key)
    try {
      const receipt = await this.ctx.channels.deliver({
        channel: 'wechat',
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
    const state = this.deliverQueueStates.get(chatKey) ?? emptyDeliverQueueState<WeChatDelivery>()
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
    const state = this.deliverQueueStates.get(chatKey) ?? emptyDeliverQueueState<WeChatDelivery>()
    const result = deliverQueueReduce(state, { kind: 'tick', now: Date.now() }, this.deliverQueueOptions())
    this.deliverQueueStates.set(chatKey, result.state)
    this.runDeliverEffects(chatKey, result.effects)
  }

  private async sendLocal(chatKey: string, markdown: string): Promise<void> {
    const maxChars = this.channel.maxMessageChars ?? 2000
    const chunks = chunkText(markdown, { maxChars })
    for (let i = 0; i < chunks.length; i++) {
      await this.ctx.channels.deliver({
        channel: 'wechat',
        ...this.accountQualifier,
        chatKey,
        markdown: chunks[i]!,
        deliveryKey: `local:${chatKey}:${Date.now()}:${i}`,
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
      await this.sendLocal(chatKey, 'Available commands:\n/start - Start\n/new - New session\n/status - Session status\n/bind <sessionId> - Bind session\n/help - Help')
      return
    }
    if (command === 'new') {
      const sessionId = `${this.sessionIdFor(chatKey)}:${Date.now()}`
      this.store.setBinding(chatKey, sessionId)
      this.sessionChatKeys.set(sessionId, chatKey)
      this.registerSessionBinding(sessionId, chatKey)
      await this.sendLocal(chatKey, `✅ New session created: ${sessionId}`)
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
      await this.sendLocal(chatKey, `✅ Session bound: ${args}`)
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
      requestId: `channel-wechat:${Date.now()}:${num}`,
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
        ? { channel: 'wechat', ...this.accountQualifier, chatKey: entry.chatKey, markdown: rendered.text, choices: rendered.choices, deliveryKey: `approval:${entry.requestId}` }
        : { channel: 'wechat', ...this.accountQualifier, chatKey: entry.chatKey, markdown: rendered.text, deliveryKey: `approval:${entry.requestId}` }

    try {
      await this.ctx.channels.deliver(out)
    } catch {
      // When the approval prompt fails to send, the answerer calls next() after timeout; never allow by default.
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
    if (!token) throw new Error('WECHAT_TOKEN is not configured')
    return token
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
