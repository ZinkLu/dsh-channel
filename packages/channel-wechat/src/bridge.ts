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
  type MergeEffect,
  type MergeState,
  type PendingApproval,
  type PendingPrompt,
  type PromptOptions,
  type RouteDecision,
} from 'dsh-channel-kit'
import type { WeChatChannel } from './channel.js'
import type { WeixinClient, WeixinMessage } from './client.js'
import { chatTypeOf, hasMedia, mediaFacts, messageText, senderId, toChatKey } from './client.js'

export interface WeChatBridgeConfig {
  allowedUserIds: string[]
  accountId?: string
  provider: string
  model?: string
  cwd?: string
  agentPreset?: string
  pollingTimeoutSec: number
  mergeWindowSec: number
  approvalTimeoutSec: number
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

/** dsh-agent-presets 的最小鸭子类型（可选依赖，不 import 包）。 */
interface AgentPresetsLike {
  resolve: (id?: string) => Promise<{ id: string }>
  mount: (agentCtx: Context, id?: string) => Promise<unknown>
}

/** dsh-user-questions 的最小鸭子类型（可选依赖，不 import 包）。 */
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
  private readonly config: WeChatBridgeConfig
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
  private readonly disposers: Array<() => void> = []

  private promptSeq = 0
  private pollAbort: AbortController | null = null
  private pollPromise: Promise<void> | null = null
  private started = false

  constructor(ctx: Context, config: WeChatBridgeConfig, store: ChannelStore, channel: WeChatChannel, client: WeixinClient) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.channel = channel
    this.client = client
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
        // 忽略 listener disposer 错误。
      }
    }

    for (const timer of this.mergeTimers.values()) clearTimeout(timer)
    this.mergeTimers.clear()
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
        // agent 可能已被其他 fiber 释放。
      }
      this.ownedHandles.delete(sessionId)
    }

    await this.store.flush()
  }

  // ---- 启动恢复 ----

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
        // 恢复失败不阻塞渠道启动；首条消息会再试 create。
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
      const marker = item.state === 'pending' ? '' : '（恢复重发，可能重复）\n'
      try {
        await this.sendOutbound(item.chatKey, marker + text, item.key, { origin: { sessionId, seq }, recover: item.state })
      } catch (error) {
        this.store.markFailed(item.key, error instanceof Error ? error.message : String(error))
      }
    }
  }

  // ---- 轮询 ----

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
    if (this.config.accountId) return this.config.accountId
    const resolved = await this.ctx.credentials.resolve(credentialRef('WECHAT_ACCOUNT_ID'))
    return resolved?.value
  }

  private async processMessage(message: WeixinMessage): Promise<void> {
    const accountId = (await this.resolveAccountId()) ?? ''
    const sender = senderId(message)
    // 自消息防回环（hermes：sender_id == account_id）。
    if (!sender || sender === accountId || message.msg_type === 2) return

    const chatType = chatTypeOf(message, accountId)
    const chatKey = toChatKey(message, accountId)
    const messageId = String(message.message_id ?? message.client_id ?? '')
    if (!chatKey) return

    // 群聊 v1 不路由，但事实照发（策略插件审计可用）。
    if (chatType !== 'direct') {
      this.ingest(message, chatKey, 'group')
      return
    }

    const allowed = this.config.allowedUserIds.includes(sender)
    if (!allowed) {
      await this.sendLocal(chatKey, '⚠️ 你没有权限使用本机器人。')
      return
    }

    if (messageId && this.store.seenInbound(messageId)) return

    // context_token 回显 + typing ticket 预热（hermes ContextTokenStore / _maybe_fetch_typing_ticket）。
    const contextToken = message.context_token
    if (contextToken) this.client.setContextToken(chatKey, contextToken)
    void this.warmTypingTicket(chatKey, contextToken)

    // 审批/提问应答优先于 merge/router（openclaw 控制命令铁律）。
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
      // ticket 拿不到就降级为不打 typing。
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
        await this.sendLocal(chatKey, '收到，处理中…')
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

  // ---- 路由与投递 ----

  private routeContext() {
    return {
      channel: 'wechat',
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
      await this.sendLocal(chatKey, '⚠️ 无法创建或恢复会话。')
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
      // systemPrompt 是可选依赖，缺失/异常都不阻塞 agent 创建。
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
      // 单槽冲突：本作用域已有 provider，不抢、不阻塞 agent 创建。
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
        ? { channel: 'wechat', chatKey, markdown: rendered.text, choices: rendered.choices.map((c) => ({ id: c.id, label: c.label })), deliveryKey: `prompt:${chatKey}:${Date.now()}` }
        : { channel: 'wechat', chatKey, markdown: rendered.text, deliveryKey: `prompt:${chatKey}:${Date.now()}` }
    try {
      await this.ctx.channels.deliver(out)
    } catch {
      // 提示发送失败：answerer 超时后 fail-closed（空回答），绝不默认放行。
    }
  }

  // ---- 出站 ----

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
      void this.sendLocal(chatKey, `⏹ 本轮结束：${label}`).catch(() => {})
    }
  }

  private async sendOutbound(
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
      this.store.markAttempting(key)
      const receipt = await this.ctx.channels.deliver({
        channel: 'wechat',
        chatKey,
        markdown: chunk,
        deliveryKey: key,
        origin: opts.origin,
      })
      if (receipt.status === 'sent') {
        this.store.markDelivered(key, receipt.platformMessageIds ?? [])
      } else if (receipt.status === 'suppressed') {
        this.store.markDelivered(key, [])
      } else {
        this.store.markFailed(key, receipt.error ?? 'delivery failed')
        return
      }
      if (i < chunks.length - 1) {
        await sleepWithAbort(1000, this.pollAbort?.signal)
        if (this.pollAbort?.signal.aborted) return
      }
    }
  }

  private async sendLocal(chatKey: string, markdown: string): Promise<void> {
    const maxChars = this.channel.maxMessageChars ?? 2000
    const chunks = chunkText(markdown, { maxChars })
    for (let i = 0; i < chunks.length; i++) {
      await this.ctx.channels.deliver({
        channel: 'wechat',
        chatKey,
        markdown: chunks[i]!,
        deliveryKey: `local:${chatKey}:${Date.now()}:${i}`,
      })
      if (i < chunks.length - 1) await sleepWithAbort(1000, this.pollAbort?.signal)
    }
  }

  // ---- 命令 ----

  private async handleCommand(commandText: string, chatKey: string): Promise<void> {
    const match = /^\/([^\s@]+)\s*(.*)$/.exec(commandText)
    const command = (match?.[1] ?? '').toLowerCase()
    const args = (match?.[2] ?? '').trim()

    if (command === 'start' || command === 'help') {
      await this.sendLocal(chatKey, '可用命令：\n/start - 开始使用\n/new - 新建会话\n/status - 会话状态\n/bind <sessionId> - 绑定会话\n/help - 帮助')
      return
    }
    if (command === 'new') {
      const sessionId = `channel:wechat:${chatKey}:${Date.now()}`
      this.store.setBinding(chatKey, sessionId)
      this.sessionChatKeys.set(sessionId, chatKey)
      await this.sendLocal(chatKey, `✅ 已创建新会话：${sessionId}`)
      return
    }
    if (command === 'bind') {
      if (!args) {
        await this.sendLocal(chatKey, '用法：/bind <sessionId>')
        return
      }
      this.store.setBinding(chatKey, args)
      this.sessionChatKeys.set(args, chatKey)
      await this.sendLocal(chatKey, `✅ 已绑定会话：${args}`)
      return
    }
    if (command === 'status') {
      const binding = this.store.bindings()[chatKey]
      const sessionId = binding ?? `channel:wechat:${chatKey}`
      const agent = this.ctx.agents.get(SessionId(sessionId))
      await this.sendLocal(chatKey, agent ? `会话 ${sessionId} 状态：${agent.status}` : `会话 ${sessionId} 未在运行。`)
      return
    }
    await this.sendLocal(chatKey, `未知命令：${command}，使用 /help 查看帮助。`)
  }

  // ---- 审批 ----

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
        ? { channel: 'wechat', chatKey: entry.chatKey, markdown: rendered.text, choices: rendered.choices, deliveryKey: `approval:${entry.requestId}` }
        : { channel: 'wechat', chatKey: entry.chatKey, markdown: rendered.text, deliveryKey: `approval:${entry.requestId}` }

    try {
      await this.ctx.channels.deliver(out)
    } catch {
      // 审批提示发送失败时，answerer 超时后 next()；绝不默认放行。
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
      return '已中止'
    case 'blocked':
      return '已阻塞'
    case 'error':
      return '出错'
    case 'max-tokens':
      return '达到 token 上限'
    case 'interrupted':
      return '已中断'
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
