/**
 * Approval + prompt broker: the numbered-interaction registry shared by every
 * provider. Owns the pending tables, their timeouts, and the one shared
 * sequence that keeps `#n` numbers unambiguous across both kinds; rendering
 * and reply parsing stay in `policy/` pure functions.
 *
 * Fail-closed is the invariant throughout: an unanswered, undeliverable, or
 * aborted interaction resolves to "no answer" (approval → deferred back to the
 * waterfall, prompt → empty selection), never to an allow.
 */
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { Channel, OutboundMessage } from 'dsh-channel'
import { renderForTier } from '../format/format.js'
import { parseApprovalReply, renderApproval, type PendingApproval } from '../policy/approval-render.js'
import { parsePromptReply, renderPrompt, type PendingPrompt, type PromptAnswer, type PromptOptions } from '../policy/prompt-render.js'

/** Minimal duck type of a dsh-user-questions request (optional dependency; the package is not imported). */
export interface AskUserQuestionRequestLike {
  questions: AskUserQuestionItemLike[]
  agent?: { id: string }
  signal?: AbortSignal
}
export interface AskUserQuestionItemLike {
  id: string
  question: string
  detail?: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  intent?: { kind: 'plan-review'; approve: string }
}
export interface AskUserQuestionAnswerLike {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

/** What the broker needs from its bridge; kept narrow so the broker stays testable. */
export interface InteractionHost {
  readonly channel: Channel
  /** ms until an unanswered approval/prompt fails closed; read per request (config is live). */
  timeoutMs(): number
  /** The chatKey the given agent's conversation is bound to, if any. */
  chatKeyForAgent(agentId: string): string | undefined
  deliver(out: OutboundMessage): Promise<{ platformMessageIds?: readonly string[] }>
  /** Record our own platform message ids for outbound-echo suppression. */
  rememberOwnSends(chatKey: string, platformMessageIds: readonly string[]): void
  accountQualifier(): { accountId?: string }
}

interface ApprovalEntry extends PendingApproval {
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

export class InteractionBroker {
  private readonly host: InteractionHost
  private readonly pendingApprovals = new Map<number, ApprovalEntry>()
  private readonly pendingPrompts = new Map<number, PromptEntry>()
  private seq = 0

  constructor(host: InteractionHost) {
    this.host = host
  }

  /** Whether inbound text answers a pending approval (used by the router's pre-check, without resolving). */
  isApprovalAnswer(text: string): boolean {
    return parseApprovalReply({ text }, [...this.pendingApprovals.values()]).kind === 'answer'
  }

  /** `approval/request` waterfall handler: prompt the chat, or `next()` when this bridge does not own the agent. */
  async handleApprovalRequest(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const chatKey = this.host.chatKeyForAgent(req.agent.id)
    if (!chatKey) return next()

    const num = ++this.seq
    const entry: ApprovalEntry = {
      num,
      requestId: this.requestId(num),
      toolName: req.toolName,
      expiresAt: Date.now() + this.host.timeoutMs(),
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

    entry.timer = this.armTimeout(() => {
      this.pendingApprovals.delete(num)
      settle('deferred')
    })

    const outcome = await verdict
    req.signal?.removeEventListener('abort', onAbort)
    if (entry.timer) clearTimeout(entry.timer)
    if (outcome === 'deferred') return next()
    return outcome
  }

  /** user-questions provider entry point: ask each question in turn over the agent's bound chat. */
  async ask(request: AskUserQuestionRequestLike): Promise<AskUserQuestionAnswerLike> {
    const agentId = request.agent?.id
    const chatKey = agentId !== undefined ? this.host.chatKeyForAgent(agentId) : undefined
    if (chatKey === undefined) return { answers: [] }

    const answers: AskUserQuestionAnswerLike['answers'] = []
    for (const question of request.questions) {
      if (request.signal?.aborted) break
      const answer = await this.askQuestion(chatKey, question, request.signal)
      answers.push({ id: question.id, selected: answer.selected, custom: answer.custom })
    }
    return { answers }
  }

  private askQuestion(
    chatKey: string,
    question: AskUserQuestionItemLike,
    signal?: AbortSignal,
  ): Promise<{ selected: string[]; custom?: string }> {
    const num = ++this.seq
    const options = question.options?.map((option) => option.label) ?? []

    let settle!: (selected: readonly string[], custom?: string) => void
    const verdict = new Promise<{ selected: string[]; custom?: string }>((resolve) => {
      settle = (selected, custom) => resolve({ selected: [...selected], custom })
    })

    const entry: PromptEntry = {
      num,
      requestId: this.requestId(num),
      question: question.question,
      detail: question.detail,
      options,
      multiSelect: question.multiSelect ?? false,
      allowFreeText: true,
      intent: question.intent,
      expiresAt: Date.now() + this.host.timeoutMs(),
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
    // A failed prompt send is not fatal here: the timeout below fails closed with an empty answer.
    void this.sendInteraction(chatKey, rendered, `prompt:${entry.requestId}`, entry).catch(() => {})

    entry.timer = this.armTimeout(() => {
      this.pendingPrompts.delete(num)
      settle([])
    })

    return verdict
  }

  private async sendApprovalPrompt(entry: ApprovalEntry, req: ApprovalRequest): Promise<void> {
    const rendered = renderApproval(
      { toolName: req.toolName, reason: req.reason, num: entry.num },
      { supportsChoices: this.host.channel.supportsChoices },
    )
    try {
      await this.sendInteraction(entry.chatKey, rendered, `approval:${entry.requestId}`, entry)
    } catch {
      // Fail-fast: if the prompt cannot be delivered the user demonstrably cannot
      // answer, so resolve `deferred` immediately instead of waiting out the timeout.
      this.pendingApprovals.delete(entry.num)
      if (entry.timer) clearTimeout(entry.timer)
      entry.resolve?.('deferred')
    }
  }

  /** Deliver one rendered interaction and record the platform message id on its entry. */
  private async sendInteraction(
    chatKey: string,
    rendered: { kind: 'choices'; text: string; choices: ReadonlyArray<{ id: string; label: string }> } | { kind: 'text'; text: string },
    deliveryKey: string,
    entry: { messageId?: number },
  ): Promise<void> {
    const out: OutboundMessage = {
      channel: this.host.channel.id,
      ...this.host.accountQualifier(),
      chatKey,
      markdown: renderForTier(rendered.text, this.host.channel.formatTier),
      ...(rendered.kind === 'choices' ? { choices: rendered.choices.map((c) => ({ id: c.id, label: c.label })) } : {}),
      deliveryKey,
    }
    const receipt = await this.host.deliver(out)
    const platformId = receipt.platformMessageIds?.[0]
    if (platformId) entry.messageId = Number(platformId)
    this.host.rememberOwnSends(chatKey, receipt.platformMessageIds ?? [])
  }

  resolveApproval(num: number, outcome: 'allowed-once' | 'rejected'): void {
    const entry = this.pendingApprovals.get(num)
    if (!entry) return
    this.pendingApprovals.delete(num)
    if (entry.timer) clearTimeout(entry.timer)
    entry.resolve?.(outcome)
  }

  resolvePrompt(num: number, answer: PromptAnswer): void {
    const entry = this.pendingPrompts.get(num)
    if (!entry) return
    this.pendingPrompts.delete(num)
    if (entry.timer) clearTimeout(entry.timer)
    entry.resolve(answer.selected, answer.custom)
  }

  /** Whether inbound text is an approval/prompt answer (and resolve it if so). */
  handleInboundReply(text: string): boolean {
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
  handleInboundChoice(choiceId: string): PromptAnswer | null {
    const reply = parsePromptReply({ choiceId }, [...this.pendingPrompts.values()])
    if (reply.kind !== 'answer') return null
    this.resolvePrompt(reply.num, reply.answer)
    return reply.answer
  }

  /** Settle everything still pending as unanswered (bridge stop). */
  settleAll(): void {
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
  }

  private promptCaps(): PromptOptions {
    return {
      supportsChoices: this.host.channel.supportsChoices,
      supportsMultiSelect: this.host.channel.supportsMultiSelect,
      presentationLimits: this.host.channel.presentationLimits,
    }
  }

  private requestId(num: number): string {
    return `channel-${this.host.channel.id}:${Date.now()}:${num}`
  }

  private armTimeout(fire: () => void): NodeJS.Timeout {
    const timer = setTimeout(fire, this.host.timeoutMs())
    timer.unref?.()
    return timer
  }
}
