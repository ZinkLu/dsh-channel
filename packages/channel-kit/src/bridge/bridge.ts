/**
 * ChannelBridge: the shared handler.
 *
 * Owns the orchestration that used to be copy-pasted into each provider bridge —
 * inbound merge/router/dispatch, the session-event → presentation-frame pipeline,
 * the outbound deliver queue + startup recovery, and the approval/prompt broker.
 * Every decision delegates to either a kit pure function (merge/route/render/chunk/
 * deliver-queue) or one of the two policy seams (presentation / recovery); every
 * platform-specific behavior is an abstract/protected transport hook.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Channel, OutboundMessage, PresentationFrame } from 'dsh-channel'
import { chunkText } from '../format/chunk.js'
import { renderForTier } from '../format/format.js'
import { promptHint } from '../format/prompt-hint.js'
import { parseApprovalReply, renderApproval, type PendingApproval } from '../policy/approval-render.js'
import {
  deliverQueueReduce,
  emptyDeliverQueueState,
  type DeliverQueueEffect,
  type DeliverQueueOptions,
  type DeliverQueueState,
  type QueuedDelivery,
} from '../policy/deliver-queue.js'
import { emptyMergeState, mergeReduce, type MergeEffect, type MergeState } from '../policy/merge.js'
import {
  assistantMessageText,
  defaultPresentationPolicy,
  projectSessionEvent,
  turnEndLabel,
  type PresentationPolicy,
} from '../policy/presentation.js'
import { parsePromptReply, renderPrompt, type PendingPrompt, type PromptOptions } from '../policy/prompt-render.js'
import { defaultRecoveryPolicy, hashText, type RecoveryPolicy } from '../policy/recovery.js'
import { route, type RouteDecision } from '../policy/router.js'
import { emptyStreamState, type StreamFrame, type StreamInput, type StreamState } from '../policy/stream.js'
import type { ChannelStore } from './store.js'

/** Common config surface the base handler reads; providers widen it with their own fields. */
export interface BridgeConfig {
  readonly provider: string
  readonly model?: string
  readonly cwd?: string
  readonly agentPreset?: string
  readonly mergeWindowSec: number
  readonly approvalTimeoutSec: number
}

/** The two policy seams; each defaults to today's behavior. */
export interface BridgePolicyOverrides {
  readonly presentation?: PresentationPolicy
  readonly recovery?: RecoveryPolicy
}

/** Payload carried through the deliver queue for a single chunk. */
export interface BridgeDelivery {
  chatKey: string
  markdown: string
  origin?: OutboundMessage['origin']
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

export abstract class ChannelBridge<TCfg extends BridgeConfig> {
  protected readonly ctx: Context
  protected readonly channel: Channel
  protected readonly store: ChannelStore
  protected readonly presentation: PresentationPolicy
  protected readonly recovery: RecoveryPolicy

  protected abstract readonly config: TCfg

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
  protected readonly draftMessageIds = new Map<string, number>()
  private readonly toolCallNames = new Map<string, string>()
  private readonly deliverQueueStates = new Map<string, DeliverQueueState<BridgeDelivery>>()
  private readonly deliverQueueTimers = new Map<string, NodeJS.Timeout>()
  private readonly disposers: Array<() => void> = []

  private promptSeq = 0
  private started = false

  constructor(ctx: Context, channel: Channel, store: ChannelStore, policies?: BridgePolicyOverrides) {
    this.ctx = ctx
    this.channel = channel
    this.store = store
    this.presentation = policies?.presentation ?? defaultPresentationPolicy
    this.recovery = policies?.recovery ?? defaultRecoveryPolicy
  }

  // ---- lifecycle ----

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    this.disposers.push(this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.onSessionEvent(session, event)
    }))
    this.disposers.push(this.ctx.on('approval/request', async (req, next) => this.onApprovalRequest(req, next)))

    this.ctx.emit('channel/status', this.channel.id, 'connecting')
    await this.restore()
    await this.connect()
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false

    await this.disconnect()

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

  // ---- transport hooks (the ONLY per-platform surface) ----

  protected abstract connect(): Promise<void>
  protected abstract disconnect(): Promise<void>

  /** Download inbound images into model-visible attachment refs; default none (facts-only). */
  protected async downloadInboundImages(_message: unknown): Promise<ImageAttachmentRef[]> {
    return []
  }

  protected async showDraft(_chatKey: string, _sessionId: string, _text: string): Promise<void> {
    throw new Error(`${this.channel.id} does not support draft streaming`)
  }

  protected async deleteDraft(_chatKey: string, _target: string): Promise<void> {
    throw new Error(`${this.channel.id} does not support draft streaming`)
  }

  // ---- shared helpers ----

  /** Account-qualified session id segment; empty for the default account (backward compatible). */
  protected get accountSegment(): string {
    const account = this.channel.accountId
    return account !== 'default' ? `:${account}` : ''
  }

  protected sessionIdFor(chatKey: string): string {
    return `channel:${this.channel.id}${this.accountSegment}:${chatKey}`
  }

  /** accountId for outbound messages; present only when non-default. */
  protected get accountQualifier(): { accountId?: string } {
    const account = this.channel.accountId
    return account !== 'default' ? { accountId: account } : {}
  }

  /** Mirror a sessionId → chatKey binding into the registry (cross-provider proactive-push seam). */
  protected registerSessionBinding(sessionId: string, chatKey: string): void {
    this.ctx.channels.bindChatKey(sessionId, this.channel.id, chatKey, this.channel.accountId)
  }

  private warn(message: string): void {
    this.ctx.logger(`dsh-channel-${this.channel.id}`).warn(message)
  }

  // ---- startup recovery ----

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
        // A failed restore does not block channel startup; the first message retries create.
      }
    }

    this.markSeenFromSessionLogs()
    await this.recover()
  }

  private markSeenFromSessionLogs(): void {
    for (const agent of this.ctx.agents.list()) {
      const chatKey = this.sessionChatKeys.get(agent.id)
      if (!chatKey) continue
      for (const event of agent.session.events) {
        if (event.type !== 'user/message') continue
        const source = event.data.source as { kind?: string; channel?: string; messageIds?: readonly string[] } | undefined
        if (source?.kind !== 'channel' || source.channel !== this.channel.id) continue
        for (const messageId of source.messageIds ?? []) {
          this.store.markInbound(messageId)
        }
      }
    }
  }

  /** Execute the recovery policy's decisions against the ledger (look up text, resend/skip/abandon). */
  private async recover(): Promise<void> {
    const recoverable = this.store.sweepRecoverable()
    const actions = await this.recovery.sweep(recoverable, {
      channel: this.channel,
      resolveText: (sessionId, seq) => this.resolveAssistantText(sessionId, seq),
    })
    for (const action of actions) {
      if (action.kind === 'skip') {
        this.store.markDelivered(action.item.key, [])
        continue
      }
      if (action.kind === 'abandon') {
        this.store.markFailed(action.item.key, action.reason)
        continue
      }
      if (action.text === '') {
        this.store.markFailed(action.item.key, `recovery: empty assistant text ${action.item.key}`)
        continue
      }
      try {
        await this.sendOutbound(action.item.chatKey, (action.marker ?? '') + action.text, action.item.key, {
          origin: action.origin,
          recover: action.item.state,
        })
      } catch (error) {
        this.store.markFailed(action.item.key, error instanceof Error ? error.message : String(error))
      }
    }
  }

  private resolveAssistantText(sessionId: string, seq: number): string {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    const event = agent?.session.events[seq]
    if (!agent || !event || event.type !== 'assistant/message') return ''
    return assistantMessageText((event.data as { message?: unknown }).message)
  }

  // ---- inbound merge ----

  protected async flushBuffered(chatKey: string): Promise<void> {
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

  /** Feed one (non-command, non-media) text message through the merge reducer. */
  protected async mergeMessage(chatKey: string, text: string, messageId?: string, senderId = '0'): Promise<void> {
    const oldState = this.mergeStates.get(chatKey) ?? emptyMergeState
    const result = mergeReduce(
      oldState,
      { kind: 'message', text, hasMedia: false, isCommand: false, now: Date.now() },
      { windowMs: this.config.mergeWindowSec * 1000 },
    )
    this.mergeStates.set(chatKey, result.state)
    this.mergeMessageIds.set(chatKey, [...(this.mergeMessageIds.get(chatKey) ?? []), ...(messageId ? [messageId] : [])])
    this.mergeSenderIds.set(chatKey, senderId)
    this.store.setMergeBuffer(chatKey, result.state.buffer)
    await this.handleMergeEffects(chatKey, result.state, result.effects, messageId)
  }

  private async handleMergeEffects(chatKey: string, _state: MergeState, effects: MergeEffect[], ackMessageId?: string): Promise<void> {
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
    if (this.channel.supportsReactions && messageId !== undefined && messageId !== '') {
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

  // ---- routing and delivery ----

  protected routeContext() {
    return {
      channel: this.channel.id,
      accountId: this.channel.accountId,
      boundSessions: this.store.bindings(),
      liveSessionIds: this.ctx.agents.list().map((agent) => agent.id),
    }
  }

  protected async dispatchText(chatKey: string, text: string, messageIds: string[], senderId = '0', images: readonly ImageAttachmentRef[] = []): Promise<void> {
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

    const content: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef }> = []
    if (text !== '') content.push({ type: 'text', text })
    for (const attachment of images) content.push({ type: 'image', attachment })

    const message: UserMessage = createUserMessage({
      content,
      source: {
        kind: 'channel' as const,
        channel: this.channel.id,
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
        name: `dsh-channel-${this.channel.id}`,
        order: 120,
        text: promptHint({
          id: this.channel.id,
          formatTier: this.channel.formatTier,
          maxMessageChars: this.channel.maxMessageChars,
          supportsChoices: this.channel.supportsChoices,
        }),
      })
    } catch {
      // systemPrompt is an optional dependency; a missing/broken one does not block agent creation.
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
      requestId: `channel-${this.channel.id}:${Date.now()}:${num}`,
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
    void this.sendPromptRendered(chatKey, rendered, entry).catch(() => {})

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
    entry?: PromptEntry,
  ): Promise<void> {
    const text = renderForTier(rendered.text, this.channel.formatTier)
    const deliveryKey = entry !== undefined ? `prompt:${entry.requestId}` : `prompt:${chatKey}:${Date.now()}`
    const out: OutboundMessage =
      rendered.kind === 'choices'
        ? { channel: this.channel.id, ...this.accountQualifier, chatKey, markdown: text, choices: rendered.choices.map((c) => ({ id: c.id, label: c.label })), deliveryKey }
        : { channel: this.channel.id, ...this.accountQualifier, chatKey, markdown: text, deliveryKey }
    try {
      const receipt = await this.ctx.channels.deliver(out)
      const platformId = receipt.platformMessageIds?.[0]
      if (platformId && entry) entry.messageId = Number(platformId)
    } catch {
      // Prompt send failed: the answerer fails closed after timeout (empty answer); never default to allowing.
    }
  }

  // ---- outbound (session events → frames) ----

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const chatKey = this.sessionChatKeys.get(session.id)
    if (!chatKey) return

    const inputs = this.presentation.project({ type: event.type, seq: event.seq, data: event.data }, (callId) => this.toolCallNames.get(callId))
    for (const input of inputs) {
      this.handleStreamInput(session.id, chatKey, input, event.seq)
    }
  }

  private handleStreamInput(sessionId: string, chatKey: string, input: StreamInput, seq: number): void {
    switch (input.kind) {
      case 'turn-start':
        void this.onTurnStart(chatKey).catch(() => {})
        break
      case 'assistant-message':
        if (input.text === '') return
        break
      case 'tool-call':
        this.toolCallNames.set(input.callId, input.name)
        break
      case 'tool-result':
        this.toolCallNames.delete(input.callId)
        break
      case 'turn-end':
        if (input.reason !== 'completed') {
          void this.sendLocal(chatKey, `⏹ Turn ended: ${turnEndLabel(input.reason)}`, { silent: this.channel.supportsSilent }).catch(() => {})
        }
        break
      case 'step-start':
      case 'step-end':
      case 'text-delta':
      case 'reasoning-delta':
      case 'reasoning-block':
        break
    }

    const deliveryCtx = input.kind === 'assistant-message' ? { seq } : undefined
    this.feedStream(sessionId, chatKey, input, deliveryCtx)
  }

  private streamCaps() {
    return {
      streamingMode: this.channel.streamingMode,
      supportsEdit: this.channel.supportsEdit,
      supportsStatusText: this.channel.supportsStatusText,
      thinkingLevel: this.channel.thinkingLevel,
    }
  }

  private feedStream(sessionId: string, chatKey: string, input: StreamInput, deliveryCtx?: { seq?: number }): void {
    if (input.kind !== 'tick') this.clearStreamTimer(sessionId)
    const state = this.streamStates.get(sessionId) ?? emptyStreamState
    const result = this.presentation.reduce(state, input, this.streamCaps(), Date.now(), this.presentation)
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
        void this.showDraft(chatKey, sessionId, frame.text).catch((error: unknown) => {
          this.warn(`draft presentation failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        return
      case 'draft-finalize':
        void this.finalizeDraft(chatKey, sessionId).catch(() => {})
        return
      case 'status-line':
        void this.sendLocal(chatKey, frame.text, { silent: this.channel.supportsSilent }).catch(() => {})
        return
      case 'arm-timer':
        this.armStreamTimer(sessionId, chatKey, frame.at)
        return
    }
  }

  private async finalizeDraft(chatKey: string, sessionId: string): Promise<void> {
    const existing = this.draftMessageIds.get(sessionId)
    if (existing === undefined) return
    this.draftMessageIds.delete(sessionId)
    try {
      await this.deleteDraft(chatKey, String(existing))
    } catch (error) {
      // Draft deletion is best-effort; the final answer is already sent separately.
      this.warn(`draft finalize failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.ctx.emit('channel/present', { kind: 'draft-finalize', channel: this.channel.id, chatKey, draftKey: `draft:${sessionId}` } satisfies PresentationFrame)
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

  protected sendOutbound(
    chatKey: string,
    markdown: string,
    deliveryKey: string,
    opts: { origin?: OutboundMessage['origin']; recover?: 'pending' | 'attempting' | 'failed' } = {},
  ): Promise<void> {
    const rendered = renderForTier(markdown, this.channel.formatTier)
    const maxChars = this.channel.maxMessageChars ?? 4096
    const chunks = chunkText(rendered, { maxChars, countBy: this.chunkCountBy })

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

  /** Chunk counting mode: Telegram counts UTF-16 code units; the default counts code points. */
  protected get chunkCountBy(): 'codepoint' | 'utf16' {
    return 'codepoint'
  }

  // ---- deliver queue (serial worker + retry + backpressure per chatKey) ----

  private deliverQueueOptions(): DeliverQueueOptions {
    return { maxRetries: 3, baseDelayMs: 1000, maxQueue: 32, spacingMs: 1000 }
  }

  private enqueueDelivery(chatKey: string, item: QueuedDelivery<BridgeDelivery>): void {
    const state = this.deliverQueueStates.get(chatKey) ?? emptyDeliverQueueState<BridgeDelivery>()
    const result = deliverQueueReduce(state, { kind: 'enqueue', item, now: Date.now() }, this.deliverQueueOptions())
    this.deliverQueueStates.set(chatKey, result.state)
    this.runDeliverEffects(chatKey, result.effects)
  }

  private runDeliverEffects(chatKey: string, effects: DeliverQueueEffect<BridgeDelivery>[]): void {
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

  private async performAttempt(chatKey: string, item: QueuedDelivery<BridgeDelivery>): Promise<void> {
    this.store.markAttempting(item.key)
    try {
      const receipt = await this.ctx.channels.deliver({
        channel: this.channel.id,
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
    const state = this.deliverQueueStates.get(chatKey) ?? emptyDeliverQueueState<BridgeDelivery>()
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
    const state = this.deliverQueueStates.get(chatKey) ?? emptyDeliverQueueState<BridgeDelivery>()
    const result = deliverQueueReduce(state, { kind: 'tick', now: Date.now() }, this.deliverQueueOptions())
    this.deliverQueueStates.set(chatKey, result.state)
    this.runDeliverEffects(chatKey, result.effects)
  }

  protected async sendLocal(chatKey: string, markdown: string, opts: { silent?: boolean } = {}): Promise<void> {
    const rendered = renderForTier(markdown, this.channel.formatTier)
    const maxChars = this.channel.maxMessageChars ?? 4096
    const chunks = chunkText(rendered, { maxChars, countBy: this.chunkCountBy })
    for (let i = 0; i < chunks.length; i++) {
      await this.ctx.channels.deliver({
        channel: this.channel.id,
        ...this.accountQualifier,
        chatKey,
        markdown: chunks[i]!,
        deliveryKey: `local:${chatKey}:${Date.now()}:${i}`,
        silent: opts.silent ? true : undefined,
      })
      if (i < chunks.length - 1) await sleep(1000)
    }
  }

  // ---- commands ----

  protected async handleCommand(commandText: string, chatKey: string): Promise<void> {
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

  // ---- approval ----

  private onApprovalRequest = async (
    req: import('@deepseek-ai/dsh-user-approval').ApprovalRequest,
    next: () => Promise<import('@deepseek-ai/dsh-user-approval').ApprovalOutcome>,
  ): Promise<import('@deepseek-ai/dsh-user-approval').ApprovalOutcome> => {
    const chatKey = this.sessionChatKeys.get(req.agent.id)
    if (!chatKey) return next()

    const num = ++this.promptSeq
    const entry: ApprovalEntry = {
      num,
      requestId: `channel-${this.channel.id}:${Date.now()}:${num}`,
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

  private async sendApprovalPrompt(
    entry: ApprovalEntry,
    req: import('@deepseek-ai/dsh-user-approval').ApprovalRequest,
  ): Promise<void> {
    const rendered = renderApproval(
      { toolName: req.toolName, reason: req.reason, num: entry.num },
      { supportsChoices: this.channel.supportsChoices },
    )
    const text = renderForTier(rendered.text, this.channel.formatTier)
    const out: OutboundMessage =
      rendered.kind === 'choices'
        ? { channel: this.channel.id, ...this.accountQualifier, chatKey: entry.chatKey, markdown: text, choices: rendered.choices, deliveryKey: `approval:${entry.requestId}` }
        : { channel: this.channel.id, ...this.accountQualifier, chatKey: entry.chatKey, markdown: text, deliveryKey: `approval:${entry.requestId}` }

    try {
      const receipt = await this.ctx.channels.deliver(out)
      const platformId = receipt.platformMessageIds?.[0]
      if (platformId) entry.messageId = Number(platformId)
    } catch {
      // When the approval prompt fails to send, the answerer calls next() after timeout; never default to allowing.
    }
  }

  protected resolveApproval(num: number, outcome: 'allowed-once' | 'rejected'): void {
    const entry = this.pendingApprovals.get(num)
    if (!entry) return
    this.pendingApprovals.delete(num)
    if (entry.timer) clearTimeout(entry.timer)
    entry.resolve?.(outcome)
  }

  protected resolvePrompt(num: number, answer: { selected: readonly string[]; custom?: string }): void {
    const entry = this.pendingPrompts.get(num)
    if (!entry) return
    this.pendingPrompts.delete(num)
    if (entry.timer) clearTimeout(entry.timer)
    entry.resolve(answer.selected, answer.custom)
  }

  /** Whether inbound text is an approval/prompt answer (and resolve it if so). */
  protected async handleInboundReply(text: string): Promise<boolean> {
    const approvalReply = parseApprovalReply({ text }, [...this.pendingApprovals.values()])
    if (approvalReply.kind === 'answer') {
      this.resolveApproval(approvalReply.num, approvalReply.outcome)
      return true
    }
    const promptReply = parsePromptReply({ text }, [...this.pendingPrompts.values()])
    if (promptReply.kind === 'answer') {
      this.resolvePrompt(promptReply.num, promptReply.answer)
      return true
    }
    return false
  }

  /** Resolve a button-callback choice (prompt:<num>:<idx>); returns the answer, or null. */
  protected handleInboundChoice(choiceId: string): { selected: readonly string[]; custom?: string } | null {
    const reply = parsePromptReply({ choiceId }, [...this.pendingPrompts.values()])
    if (reply.kind !== 'answer') return null
    this.resolvePrompt(reply.num, reply.answer)
    return reply.answer
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
