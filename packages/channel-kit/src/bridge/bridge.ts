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
import type { Channel, InboundMessage, OutboundMessage, PresentationFrame, SendErrorKind } from 'dsh-channel'
import { chunkText } from '../format/chunk.js'
import { renderForTier } from '../format/format.js'
import { promptHint } from '../format/prompt-hint.js'
import { parseApprovalReply, renderApproval, type PendingApproval } from '../policy/approval-render.js'
import { resolveBusyAction, type BusyAction } from '../policy/busy.js'
import {
  deliverQueueReduce,
  emptyDeliverQueueState,
  type DeliverQueueEffect,
  type DeliverQueueOptions,
  type DeliverQueueState,
  type QueuedDelivery,
} from '../policy/deliver-queue.js'
import { draftThrottleReduce, emptyDraftThrottleState, type DraftThrottleState } from '../policy/draft-throttle.js'
import { resolveFinalization } from '../policy/finalization.js'
import { emptyMergeState, mergeReduce, type MergeEffect, type MergeState } from '../policy/merge.js'
import { emptyOutboundEchoState, outboundEchoReduce, type OutboundEchoState } from '../policy/outbound-echo.js'
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
  /** Max wait to acquire the per-sessionId turn guard before a visible rejection. Default 120. */
  readonly sessionTurnTimeoutSec?: number
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

/** One buffered merge entry: the message text and its platform ids, kept aligned with MergeState.buffer. */
interface MergeEntry {
  messageIds: string[]
  senderId: string
}

/** A message queued behind a running turn (busy policy fallback). */
interface BusyQueuedMessage {
  chatKey: string
  text: string
  messageIds: string[]
  senderId: string
  images: readonly ImageAttachmentRef[]
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
  private readonly mergeEntries = new Map<string, MergeEntry[]>()
  private readonly mergeTimers = new Map<string, NodeJS.Timeout>()
  private readonly sessionChatKeys = new Map<string, string>()
  private readonly ownedHandles = new Map<string, AgentHandle>()
  private readonly pendingApprovals = new Map<number, ApprovalEntry>()
  private readonly pendingPrompts = new Map<number, PromptEntry>()
  private readonly lastTypingAt = new Map<string, number>()
  private readonly streamStates = new Map<string, StreamState>()
  private readonly streamTimers = new Map<string, NodeJS.Timeout>()
  private readonly draftThrottleStates = new Map<string, DraftThrottleState>()
  private readonly draftThrottleTimers = new Map<string, NodeJS.Timeout>()
  /** Last draft text the platform *accepted*, per session — the append-tail baseline. */
  private readonly shownDraftText = new Map<string, string>()
  protected readonly draftMessageIds = new Map<string, number>()
  private readonly toolCallNames = new Map<string, string>()
  private readonly deliverQueueStates = new Map<string, DeliverQueueState<BridgeDelivery>>()
  private readonly deliverQueueTimers = new Map<string, NodeJS.Timeout>()
  private readonly outboundEchoStates = new Map<string, OutboundEchoState>()
  private readonly busyQueues = new Map<string, BusyQueuedMessage[]>()
  private readonly sessionTurnTails = new Map<string, Promise<void>>()
  private readonly statusWaiters: Array<() => void> = []
  private readonly disposers: Array<() => void> = []

  private promptSeq = 0
  private started = false
  private channelStatus: 'connecting' | 'connected' | 'disconnected' | 'fatal' = 'disconnected'

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
    this.disposers.push(this.ctx.on('channel/status', (channelId: string, status: 'connecting' | 'connected' | 'disconnected' | 'fatal') => {
      if (channelId !== this.channel.id) return
      this.channelStatus = status
      if (status === 'connected') {
        for (const resolve of this.statusWaiters.splice(0)) resolve()
      }
    }))

    this.channelStatus = 'connecting'
    this.ctx.emit('channel/status', this.channel.id, 'connecting')
    await this.restore()
    await this.connect()
    // Startup recovery only runs once the provider reached `connected`, so a
    // failed-connect boot does not burn attempts for messages never once sent.
    if (await this.waitForConnected()) {
      await this.recover()
    } else {
      this.warn('channel did not reach connected status; skipping startup recovery')
    }
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
    for (const timer of this.draftThrottleTimers.values()) clearTimeout(timer)
    this.draftThrottleTimers.clear()
    this.draftThrottleStates.clear()
    this.shownDraftText.clear()
    this.draftMessageIds.clear()
    this.toolCallNames.clear()
    for (const timer of this.deliverQueueTimers.values()) clearTimeout(timer)
    this.deliverQueueTimers.clear()
    this.deliverQueueStates.clear()
    this.busyQueues.clear()
    this.sessionTurnTails.clear()
    this.outboundEchoStates.clear()
    for (const resolve of this.statusWaiters.splice(0)) resolve()
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

  /** Whether this platform sender is on the configured allowlist (the security boundary; no permissive default). */
  protected abstract isAllowed(senderId: string): boolean

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
      this.mergeStates.set(chatKey, {
        buffer: buffer.map((text) => [text]),
        deadline: now + this.config.mergeWindowSec * 1000,
        firstAt: now,
      })
      this.mergeEntries.set(chatKey, buffer.map(() => ({ messageIds: [], senderId: '0' })))
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
  }

  /** Resolve once `channel/status` reaches connected, or after a bounded fallback (never hang start). */
  private async waitForConnected(): Promise<boolean> {
    if (this.channelStatus === 'connected') return true
    const timeoutMs = 15_000
    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      timer.unref?.()
      this.statusWaiters.push(done)
    })
    return (this.channelStatus as string) === 'connected'
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
      // Enqueue only; the deliver queue owns the attempt and its ledger marks.
      this.sendOutbound(action.item.chatKey, (action.marker ?? '') + action.text, action.item.key, {
        origin: action.origin,
        recover: action.item.state,
      })
    }
  }

  private resolveAssistantText(sessionId: string, seq: number): string {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    const event = agent?.session.events[seq]
    if (!agent || !event || event.type !== 'assistant/message') return ''
    return assistantMessageText((event.data as { message?: unknown }).message)
  }

  // ---- inbound ----

  /**
   * The shared inbound pipeline. Providers normalize their transport payload
   * into an `InboundMessage` and hand it here; the order below is the design's,
   * not theirs to vary:
   *
   *   group drop → allowlist → echo suppression → dedupe → approval/prompt reply
   *   → ingest → command → media → merge
   *
   * Two orderings are load-bearing. Approval/prompt answers are resolved *before*
   * merge/router, so a "yes" can never queue behind the very turn that is blocked
   * waiting for it (openclaw's control-command iron rule). And commands and media
   * both flush the merge buffer first, so nothing is delayed by the debounce
   * window or welded onto an attachment's batch.
   *
   * @param raw the untouched platform message, handed back to `downloadInboundImages`.
   */
  protected async handleInbound(inbound: InboundMessage, raw?: unknown): Promise<void> {
    const { chatKey, senderId, messageId, text } = inbound

    // v1 does not route group chats, but the fact is still broadcast so policy
    // plugins can audit them (chatnode's stance on the prompt-injection surface).
    if (inbound.chatType !== 'direct') {
      this.ctx.channels.ingest(inbound)
      return
    }

    if (!this.isAllowed(senderId)) {
      await this.sendLocal(chatKey, '⚠️ You are not authorized to use this bot.')
      return
    }

    if (messageId !== '') {
      if (this.isOwnEcho(chatKey, messageId)) return
      if (this.store.seenInbound(messageId)) return
      this.store.markInbound(messageId, 'handling')
    }

    try {
      await this.routeInbound(inbound, raw)
      if (messageId !== '') this.store.markInbound(messageId, 'done')
    } catch (error) {
      // One unhandleable message must not tear down the transport loop; record
      // the outcome so a webhook redelivery can tell "gave up" from "answered".
      if (messageId !== '') this.store.markInbound(messageId, 'failed')
      this.warn(`inbound handling failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async routeInbound(inbound: InboundMessage, raw: unknown): Promise<void> {
    const { chatKey, senderId, messageId, text } = inbound
    const messageIds = messageId !== '' ? [messageId] : []

    if (await this.handleInboundReply(text)) return

    this.ctx.channels.ingest(inbound)

    const trimmed = text.trim()
    if (trimmed.startsWith('/')) {
      await this.flushBuffered(chatKey)
      await this.handleCommand(trimmed, chatKey)
      return
    }

    if (inbound.hasMedia) {
      await this.flushBuffered(chatKey)
      const images = await this.downloadInboundImages(raw)
      if (trimmed !== '' || images.length > 0) {
        await this.dispatchText(chatKey, text, messageIds, senderId, images)
      }
      return
    }

    if (trimmed === '') return
    await this.mergeMessage(chatKey, text, messageId, senderId)
  }

  // ---- inbound merge ----

  protected async flushBuffered(chatKey: string): Promise<void> {
    const state = this.mergeStates.get(chatKey)
    if (!state || state.buffer.length === 0) return
    const texts = state.buffer.map((entry) => entry.join(''))
    const entries = this.mergeEntries.get(chatKey) ?? []
    this.mergeStates.set(chatKey, emptyMergeState)
    this.mergeEntries.delete(chatKey)
    this.store.setMergeBuffer(chatKey, [])
    this.clearMergeTimer(chatKey)
    for (let i = 0; i < texts.length; i++) {
      await this.dispatchText(chatKey, texts[i]!, entries[i]?.messageIds ?? [], entries[i]?.senderId ?? '0')
    }
  }

  /** Feed one (non-command, non-media) text message through the merge reducer. */
  protected async mergeMessage(chatKey: string, text: string, messageId?: string, senderId = '0'): Promise<void> {
    const oldState = this.mergeStates.get(chatKey) ?? emptyMergeState
    const oldLen = oldState.buffer.length
    const result = mergeReduce(
      oldState,
      { kind: 'message', text, hasMedia: false, isCommand: false, now: Date.now() },
      { windowMs: this.config.mergeWindowSec * 1000 },
    )
    this.mergeStates.set(chatKey, result.state)

    // Keep the bridge's per-message ids/sender aligned with the reducer's buffer
    // entries. A message that only re-arms the window (empty `..` payload) does
    // not create a buffer entry.
    const entries = this.mergeEntries.get(chatKey) ?? []
    const grew = result.state.buffer.length > oldLen
    const flushedImmediately = result.state.buffer.length === 0 && result.effects.some((effect) => effect.kind === 'flush')
    if (grew || (flushedImmediately && text.trim() !== '')) {
      entries.push({ messageIds: messageId ? [messageId] : [], senderId })
      this.mergeEntries.set(chatKey, entries)
    }
    this.store.setMergeBuffer(chatKey, result.state.buffer.map((entry) => entry.join('')))
    await this.handleMergeEffects(chatKey, result.state, result.effects, messageId)
  }

  private async handleMergeEffects(chatKey: string, _state: MergeState, effects: MergeEffect[], ackMessageId?: string): Promise<void> {
    for (const effect of effects) {
      if (effect.kind === 'armTimer') {
        this.armMergeTimer(chatKey, effect.at)
      } else if (effect.kind === 'ack-long') {
        await this.ackLong(chatKey, ackMessageId)
      } else if (effect.kind === 'flush') {
        const entries = this.mergeEntries.get(chatKey) ?? []
        this.mergeEntries.delete(chatKey)
        this.mergeStates.set(chatKey, emptyMergeState)
        this.store.setMergeBuffer(chatKey, [])
        this.clearMergeTimer(chatKey)
        for (let i = 0; i < effect.texts.length; i++) {
          await this.dispatchText(chatKey, effect.texts[i]!, entries[i]?.messageIds ?? [], entries[i]?.senderId ?? '0')
        }
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
    this.store.setMergeBuffer(chatKey, result.state.buffer.map((entry) => entry.join('')))
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

    const message = this.buildUserMessage(chatKey, text, messageIds, senderId, images)
    const action = this.resolveBusyActionFor(agent.status)

    const queued: BusyQueuedMessage = { chatKey, text, messageIds, senderId, images }
    if (action === 'queue') {
      this.queueBehindRunningTurn(agent, queued)
      return
    }

    await this.runSerializedSessionTurn(agent.id, chatKey, async () => {
      if (action === 'steer') {
        // Mandatory fallback: if steer is unavailable or fails, buffer the
        // message behind the running turn — never drop it.
        try {
          const accepted = (await agent.steer(message)) as unknown
          if (accepted === false) {
            this.queueBehindRunningTurn(agent, queued)
            return
          }
        } catch {
          this.queueBehindRunningTurn(agent, queued)
          return
        }
      } else {
        agent.followup(message)
      }
      this.sessionChatKeys.set(agent.id, chatKey)
    })
  }

  private resolveBusyActionFor(agentStatus: string): BusyAction {
    // The channel bridge supports steer and queue (turn-end flush), so both
    // capability gates are true; the decision reduces to the agent status.
    return resolveBusyAction(agentStatus, 'text', { supportsSteer: true, supportsQueue: true })
  }

  private buildUserMessage(
    chatKey: string,
    text: string,
    messageIds: string[],
    senderId: string,
    images: readonly ImageAttachmentRef[],
  ): UserMessage {
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef }> = []
    if (text !== '') content.push({ type: 'text', text })
    for (const attachment of images) content.push({ type: 'image', attachment })

    return createUserMessage({
      content,
      source: {
        kind: 'channel' as const,
        channel: this.channel.id,
        chatKey,
        senderId,
        messageIds: [...messageIds],
      },
    })
  }

  private queueBehindRunningTurn(agent: Agent, message: BusyQueuedMessage): void {
    const queue = this.busyQueues.get(agent.id) ?? []
    queue.push(message)
    this.busyQueues.set(agent.id, queue)
    // The turn may have ended between reading `agent.status` and queueing, in
    // which case no turn-end is coming to flush this. Never strand a message.
    if (agent.status !== 'running') void this.flushBusyQueue(agent.id).catch(() => {})
  }

  /** Flush messages queued behind a turn once that turn ends. */
  private async flushBusyQueue(sessionId: string): Promise<void> {
    const queue = this.busyQueues.get(sessionId)
    if (!queue || queue.length === 0) return
    this.busyQueues.delete(sessionId)

    await this.runSerializedSessionTurn(sessionId, queue[0]!.chatKey, async () => {
      const agent = this.ctx.agents.get(SessionId(sessionId))
      if (!agent) return
      for (const queued of queue) {
        const message = this.buildUserMessage(queued.chatKey, queued.text, queued.messageIds, queued.senderId, queued.images)
        agent.followup(message)
        this.sessionChatKeys.set(sessionId, queued.chatKey)
      }
    })
  }

  /**
   * Serialize dispatch per resolved sessionId so two chats bound to one session
   * cannot interleave turns (`/bind` makes chatKey→sessionId many-to-one).
   *
   * The gate is installed before awaiting the predecessor, so concurrent callers
   * queue behind this turn rather than beside it. Release is identity-checked:
   * only our own gate is resolved and only our own tail is reclaimed, so a stale
   * unwind can never free a newer turn's guard.
   */
  private async runSerializedSessionTurn(sessionId: string, chatKey: string, run: () => Promise<void>): Promise<void> {
    const previous = this.sessionTurnTails.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => gate, () => gate)
    this.sessionTurnTails.set(sessionId, tail)

    const done = () => {
      release()
      if (this.sessionTurnTails.get(sessionId) === tail) this.sessionTurnTails.delete(sessionId)
    }

    if (!(await settledWithin(previous, (this.config.sessionTurnTimeoutSec ?? 120) * 1000))) {
      // Reject visibly, never run unserialized.
      done()
      await this.sendLocal(chatKey, '⚠️ The previous turn is still running; please resend your message.')
      return
    }

    try {
      await run()
    } finally {
      done()
    }
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
      this.rememberOwnSends(chatKey, receipt.platformMessageIds ?? [])
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
        this.clearDraftThrottle(sessionId)
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
        // Busy-policy queue: messages buffered behind the running turn flush on turn-end.
        void this.flushBusyQueue(sessionId).catch(() => {})
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
        this.sendOutbound(chatKey, frame.text, deliveryKey, { origin: { sessionId, seq } })
        return
      }
      case 'draft':
        this.sendDraftThrottled(sessionId, chatKey, frame.text)
        return
      case 'draft-finalize':
        void this.finalizeDraft(chatKey, sessionId, frame.editFailed).catch(() => {})
        return
      case 'status-line':
        void this.sendLocal(chatKey, frame.text, { silent: this.channel.supportsSilent }).catch(() => {})
        return
      case 'arm-timer':
        this.armStreamTimer(sessionId, chatKey, frame.at)
        return
    }
  }

  /**
   * Decide what happens to the preview draft now that the turn produced its
   * final text. `resolveFinalization` is the decision; the bridge only executes
   * it. `finalVisible` is false because v1 never renders the answer into the
   * preview (block streaming is v2), so `preview-finalized` stays unreachable
   * here and the live split is discard vs retain.
   */
  private async finalizeDraft(chatKey: string, sessionId: string, editFailed: boolean): Promise<void> {
    const target = this.draftMessageIds.get(sessionId)
    if (target === undefined) return
    this.draftMessageIds.delete(sessionId)

    const outcome = resolveFinalization(
      { streamingMode: this.channel.streamingMode, supportsEdit: this.channel.supportsEdit },
      { draftStarted: true, editFailed },
      { ok: !editFailed, finalVisible: false },
    )
    if (outcome === 'preview-retained') {
      // Edit-in-place died mid-stream, so the preview still holds the prefix the
      // user actually saw and the tail went out as separate status lines.
      // Deleting it here would erase visible context.
      return
    }

    try {
      await this.deleteDraft(chatKey, String(target))
    } catch (error) {
      // Draft deletion is best-effort; the final answer is already sent separately.
      this.warn(`draft finalize failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.ctx.emit('channel/present', { kind: 'draft-discard', channel: this.channel.id, chatKey, draftKey: `draft:${sessionId}` } satisfies PresentationFrame)
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

  private clearDraftThrottle(sessionId: string): void {
    const timer = this.draftThrottleTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.draftThrottleTimers.delete(sessionId)
    }
    this.draftThrottleStates.delete(sessionId)
    this.shownDraftText.delete(sessionId)
  }

  /** Draft edits go through the adaptive throttle: flood doubles, success resets, retry_after capped. */
  private sendDraftThrottled(sessionId: string, chatKey: string, text: string): void {
    const now = Date.now()
    const state = this.draftThrottleStates.get(sessionId) ?? emptyDraftThrottleState
    const attempt = draftThrottleReduce(state, { kind: 'attempt', now })
    this.draftThrottleStates.set(sessionId, attempt.state)

    if (attempt.effect.kind === 'delay') {
      const existing = this.draftThrottleTimers.get(sessionId)
      if (existing !== undefined) clearTimeout(existing)
      const delay = Math.max(0, attempt.effect.at - now)
      const timer = setTimeout(() => {
        this.draftThrottleTimers.delete(sessionId)
        this.sendDraftThrottled(sessionId, chatKey, text)
      }, delay)
      timer.unref?.()
      this.draftThrottleTimers.set(sessionId, timer)
      return
    }

    if (attempt.effect.kind === 'fail-over') {
      // Server retry_after exceeded the ceiling: degrade instead of stalling the preview.
      this.warn('draft edit throttle fail-over; switching to append-tail mode')
      this.feedStream(sessionId, chatKey, { kind: 'edit-failed', visiblePrefix: this.shownDraftText.get(sessionId) })
      return
    }

    void this.showDraft(chatKey, sessionId, text)
      .then(() => {
        // Only an accepted render becomes the append-tail baseline.
        this.shownDraftText.set(sessionId, text)
        const next = draftThrottleReduce(this.draftThrottleStates.get(sessionId) ?? emptyDraftThrottleState, { kind: 'success', now: Date.now() })
        this.draftThrottleStates.set(sessionId, next.state)
      })
      .catch((error: unknown) => {
        this.warn(`draft presentation failed: ${error instanceof Error ? error.message : String(error)}`)
        const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs
        const next = draftThrottleReduce(
          this.draftThrottleStates.get(sessionId) ?? emptyDraftThrottleState,
          { kind: 'failure', now: Date.now(), retryAfterMs },
        )
        this.draftThrottleStates.set(sessionId, next.state)
        // Edit-in-place died mid-stream: hand the reducer what the user actually
        // saw so it can append only the tail from here on.
        this.feedStream(sessionId, chatKey, { kind: 'edit-failed', visiblePrefix: this.shownDraftText.get(sessionId) })
      })
  }

  private async onTurnStart(chatKey: string): Promise<void> {
    if (!this.channel.supportsTyping) return
    const now = Date.now()
    const last = this.lastTypingAt.get(chatKey) ?? 0
    if (now - last < 5000) return
    this.lastTypingAt.set(chatKey, now)
    await this.channel.sendTyping(chatKey)
  }

  /** Remember our own platform message ids for outbound-echo suppression (30s TTL, bounded). */
  private rememberOwnSends(chatKey: string, platformMessageIds: readonly string[]): void {
    let state = this.outboundEchoStates.get(chatKey) ?? emptyOutboundEchoState
    for (const messageId of platformMessageIds) {
      if (messageId === '') continue
      state = outboundEchoReduce(state, {
        kind: 'sent',
        channel: this.channel.id,
        accountId: this.channel.accountId,
        chatKey,
        messageId,
        now: Date.now(),
      }).state
    }
    this.outboundEchoStates.set(chatKey, state)
  }

  /** True when an inbound platform message is an echo of one of our own recent sends. */
  protected isOwnEcho(chatKey: string, messageId: string): boolean {
    if (messageId === '') return false
    const state = this.outboundEchoStates.get(chatKey) ?? emptyOutboundEchoState
    const result = outboundEchoReduce(state, {
      kind: 'inbound',
      channel: this.channel.id,
      accountId: this.channel.accountId,
      chatKey,
      messageId,
      now: Date.now(),
    })
    this.outboundEchoStates.set(chatKey, result.state)
    return result.matches
  }

  /**
   * Render → chunk → record in the ledger → hand to the deliver queue. Returns
   * once the chunks are enqueued, not once they are sent: the queue owns the
   * attempt, its retries, and the ledger marks for every outcome.
   */
  protected sendOutbound(
    chatKey: string,
    markdown: string,
    deliveryKey: string,
    opts: { origin?: OutboundMessage['origin']; recover?: 'pending' | 'attempting' | 'failed' } = {},
  ): void {
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
          this.store.markFailed(effect.item.key, effect.error, effect.errorKind)
          break
        case 'reject-backpressure':
          // Distinguishable in the ledger: backpressure is retryable, not terminal.
          this.store.markFailed(effect.item.key, 'delivery queue full (backpressure)', 'transient')
          break
      }
    }
  }

  private async performAttempt(chatKey: string, item: QueuedDelivery<BridgeDelivery>): Promise<void> {
    // Never burn an attempt budget when the provider never connected this boot.
    if (this.channelStatus !== 'connected') {
      this.feedAttemptResult(chatKey, item.key, 'failed', 'channel not connected', 'transient')
      return
    }
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
        this.rememberOwnSends(item.value.chatKey, receipt.platformMessageIds ?? [])
        this.feedAttemptResult(chatKey, item.key, 'sent')
      } else if (receipt.status === 'suppressed') {
        this.store.markDelivered(item.key, [])
        this.feedAttemptResult(chatKey, item.key, 'suppressed')
      } else {
        this.feedAttemptResult(chatKey, item.key, 'failed', receipt.error ?? 'delivery failed', receipt.errorKind, receipt.retryAfterMs)
      }
    } catch (error) {
      const classified = error as Error & { errorKind?: SendErrorKind; retryAfterMs?: number }
      this.feedAttemptResult(chatKey, item.key, 'failed', error instanceof Error ? error.message : String(error), classified.errorKind, classified.retryAfterMs)
    }
  }

  private feedAttemptResult(
    chatKey: string,
    key: string,
    outcome: 'sent' | 'suppressed' | 'failed',
    error?: string,
    errorKind?: SendErrorKind,
    retryAfterMs?: number,
  ): void {
    const state = this.deliverQueueStates.get(chatKey) ?? emptyDeliverQueueState<BridgeDelivery>()
    const result = deliverQueueReduce(
      state,
      { kind: 'attempt-result', key, outcome, error, errorKind, retryAfterMs, now: Date.now() },
      this.deliverQueueOptions(),
    )
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
      const receipt = await this.ctx.channels.deliver({
        channel: this.channel.id,
        ...this.accountQualifier,
        chatKey,
        markdown: chunks[i]!,
        deliveryKey: `local:${chatKey}:${Date.now()}:${i}`,
        silent: opts.silent ? true : undefined,
      })
      this.rememberOwnSends(chatKey, receipt.platformMessageIds ?? [])
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
      this.rememberOwnSends(entry.chatKey, receipt.platformMessageIds ?? [])
    } catch {
      // Fail-fast: if the prompt cannot be delivered the user demonstrably
      // cannot answer, so resolve `deferred` immediately instead of waiting
      // out approvalTimeoutSec (hermes approval.py:3504-3510).
      this.pendingApprovals.delete(entry.num)
      if (entry.timer) clearTimeout(entry.timer)
      entry.resolve?.('deferred')
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

/** True when `promise` settled (either way) within `timeoutMs`; false on timeout. */
function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref?.()
    void promise.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(true)
      },
    )
  })
}
