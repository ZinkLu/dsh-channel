/**
 * Approval + prompt broker: the numbered-interaction registry shared by every
 * provider. Owns the pending tables, their timeouts, and the one shared
 * sequence that keeps `#n` numbers unambiguous across both kinds; rendering
 * and reply parsing stay in `policy/` pure functions.
 *
 * Fail-closed is the invariant throughout: an unanswered, undeliverable, or
 * aborted approval resolves to "no answer" (deferred back to the waterfall),
 * never to an allow. A user question instead *rejects* (ASK_TIMED_OUT /
 * ASK_ABORTED): dsh 0.2 reads an empty selection as "user skipped", so failing
 * closed means failing the tool call, not answering for the user.
 */
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { Channel, DeliveryReceipt, OutboundMessage } from 'dsh-channel'
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

/**
 * The 0.2 answerer waterfall, declared structurally: dsh-user-questions is an
 * optional dependency, and the method-syntax declaration merges cleanly with
 * the real one when the package is present.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'user-questions/request'(request: AskUserQuestionRequestLike, next: () => Promise<AskUserQuestionAnswerLike>): Promise<AskUserQuestionAnswerLike>
  }
}

/**
 * UserQuestionError-shaped failure without importing the (optional) package;
 * the 0.2 service restores answerer rejections by `name === 'UserQuestionError'`
 * plus a string `code`, and maps ASK_TIMED_OUT to its pending result.
 */
function askError(code: 'ASK_TIMED_OUT' | 'ASK_ABORTED', message: string): Error {
  const error = new Error(message) as Error & { code: string }
  error.name = 'UserQuestionError'
  error.code = code
  return error
}

/** What the broker needs from its bridge; kept narrow so the broker stays testable. */
export interface InteractionHost {
  readonly channel: Channel
  /** ms until an unanswered approval/prompt fails closed; read per request (config is live). */
  timeoutMs(): number
  /**
   * The chatKeys the given agent's interaction should reach. With a session
   * manager this is every subscriber chat of the session (plus its focus
   * chat); without one it is the single bound chat. Multiple chats all
   * receive the prompt; the first answer wins (resolve is single-shot).
   */
  chatKeysForAgent(agentId: string, kind: 'approval' | 'question'): string[]
  deliver(out: OutboundMessage): Promise<DeliveryReceipt>
  /** Record our own platform message ids for outbound-echo suppression. */
  rememberOwnSends(chatKey: string, platformMessageIds: readonly string[]): void
  accountQualifier(): { accountId?: string }
  /** Diagnostics sink (`debug` for the normal path, `warn` for anything that loses an answer). */
  log(level: 'debug' | 'warn', message: string): void
}

interface ApprovalEntry extends PendingApproval {
  chatKeys: string[]
  timer?: NodeJS.Timeout
  resolve?: (outcome: 'allowed-once' | 'rejected' | 'deferred') => void
  messageId?: number
}

interface PromptEntry extends PendingPrompt {
  chatKeys: string[]
  timer?: NodeJS.Timeout
  messageId?: number
  /** Fail-closed path: the question rejects rather than resolving with an empty ("skipped") selection. */
  reject?: (error: Error) => void
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

  /** `approval/request` waterfall handler: prompt the subscriber chats, or `next()` when this bridge does not own the agent. */
  async handleApprovalRequest(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const chatKeys = this.host.chatKeysForAgent(req.agent.id, 'approval')
    if (chatKeys.length === 0) {
      this.host.log('debug', `approval/request for ${req.agent.id} (${req.toolName}) is not ours → next()`)
      return next()
    }

    const num = ++this.seq
    this.host.log('debug', `approval #${num} for ${req.agent.id} (${req.toolName}) → chats [${chatKeys.join(', ')}], timeout ${this.host.timeoutMs()}ms`)
    const entry: ApprovalEntry = {
      num,
      requestId: this.requestId(num),
      toolName: req.toolName,
      expiresAt: Date.now() + this.host.timeoutMs(),
      chatKeys,
    }

    let settle!: (outcome: 'allowed-once' | 'rejected' | 'deferred') => void
    const verdict = new Promise<'allowed-once' | 'rejected' | 'deferred'>((resolve) => {
      settle = resolve
      entry.resolve = resolve
      this.pendingApprovals.set(num, entry)
    })

    const onAbort = () => {
      this.host.log('warn', `approval #${num} withdrawn by the request signal → next()`)
      this.pendingApprovals.delete(num)
      if (entry.timer) clearTimeout(entry.timer)
      settle('deferred')
    }
    req.signal?.addEventListener('abort', onAbort, { once: true })

    await this.sendApprovalPrompt(entry, req)
    this.host.log('debug', `approval #${num} prompt sent as platform message ${entry.messageId ?? '?'}`)
    // The entry can already be gone here for two reasons: the send failed /
    // the request aborted (both settled 'deferred' → fall back to the
    // waterfall), or the user answered while the prompt send was in flight
    // (the verdict already holds their answer — honor it, never discard it).
    // Every removal path settles the verdict first, so awaiting it below
    // distinguishes the two without a race.
    if (this.pendingApprovals.has(num)) {
      entry.timer = this.armTimeout(() => {
        this.host.log('warn', `approval #${num} unanswered after ${this.host.timeoutMs()}ms → next()`)
        this.pendingApprovals.delete(num)
        settle('deferred')
      })
    }

    const outcome = await verdict
    this.host.log('debug', `approval #${num} settled: ${outcome}`)
    req.signal?.removeEventListener('abort', onAbort)
    if (entry.timer) clearTimeout(entry.timer)
    if (outcome === 'deferred') return next()
    return outcome
  }

  /**
   * `user-questions/request` waterfall handler: ask each question in turn over
   * the agent's bound chat, or next() when the agent is not ours. An unanswered
   * or aborted question rejects — in 0.2 an empty `selected` means "user
   * skipped", so failing closed means failing the tool call.
   */
  async handleUserQuestion(request: AskUserQuestionRequestLike, next: () => Promise<AskUserQuestionAnswerLike>): Promise<AskUserQuestionAnswerLike> {
    const agentId = request.agent?.id
    const chatKeys = agentId !== undefined ? this.host.chatKeysForAgent(agentId, 'question') : []
    if (chatKeys.length === 0) {
      this.host.log('debug', `user-questions/request for ${agentId ?? '(no agent)'} is not ours → next()`)
      return next()
    }

    const answers: AskUserQuestionAnswerLike['answers'] = []
    for (const question of request.questions) {
      if (request.signal?.aborted) throw askError('ASK_ABORTED', 'ask_user_question was aborted before the user answered')
      const answer = await this.askQuestion(chatKeys, question, request.signal)
      answers.push({ id: question.id, selected: answer.selected, custom: answer.custom })
    }
    return { answers }
  }

  private askQuestion(
    chatKeys: string[],
    question: AskUserQuestionItemLike,
    signal?: AbortSignal,
  ): Promise<{ selected: string[]; custom?: string }> {
    const num = ++this.seq
    const options = question.options?.map((option) => option.label) ?? []

    let settle!: (selected: readonly string[], custom?: string) => void
    let fail!: (error: Error) => void
    const verdict = new Promise<{ selected: string[]; custom?: string }>((resolve, reject) => {
      settle = (selected, custom) => resolve({ selected: [...selected], custom })
      fail = reject
    })
    // The verdict outlives its consumer on bridge stop (settleAll rejects every
    // pending prompt); a rejection nobody awaits must not crash the process.
    void verdict.catch(() => {})

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
      reject: (error) => fail(error),
      chatKeys,
    }
    this.pendingPrompts.set(num, entry)

    const onAbort = () => {
      this.pendingPrompts.delete(num)
      if (entry.timer) clearTimeout(entry.timer)
      fail(askError('ASK_ABORTED', 'ask_user_question was aborted before the user answered'))
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
    // A failed prompt send fails fast: the user demonstrably cannot answer.
    // With several subscriber chats, only an ALL-chats failure gives up; one
    // reachable chat keeps the question alive for its answer.
    void this.sendInteractionToAll(chatKeys, rendered, `prompt:${entry.requestId}`, entry).then((delivered) => {
      if (delivered > 0 || !this.pendingPrompts.delete(num)) return
      if (entry.timer) clearTimeout(entry.timer)
      fail(new Error('the question prompt could not be delivered to any subscriber chat'))
    })

    entry.timer = this.armTimeout(() => {
      this.pendingPrompts.delete(num)
      fail(askError('ASK_TIMED_OUT', 'ask_user_question timed out before the user answered'))
    })

    return verdict
  }

  private async sendApprovalPrompt(entry: ApprovalEntry, req: ApprovalRequest): Promise<void> {
    const rendered = renderApproval(
      { toolName: req.toolName, reason: req.reason, num: entry.num },
      { supportsChoices: this.host.channel.supportsChoices },
    )
    try {
      const delivered = await this.sendInteractionToAll(entry.chatKeys, rendered, `approval:${entry.requestId}`, entry)
      if (delivered === 0) throw new Error('the approval prompt could not be delivered to any subscriber chat')
    } catch (error) {
      // Fail-fast: if the prompt cannot be delivered the user demonstrably cannot
      // answer, so resolve `deferred` immediately instead of waiting out the timeout.
      this.host.log('warn', `approval #${entry.num} prompt could not be delivered (${error instanceof Error ? error.message : String(error)}) → next()`)
      this.pendingApprovals.delete(entry.num)
      if (entry.timer) clearTimeout(entry.timer)
      entry.resolve?.('deferred')
    }
  }

  /** Deliver one interaction to every subscriber chat; counts the chats that accepted it. */
  private async sendInteractionToAll(
    chatKeys: readonly string[],
    rendered: { kind: 'choices'; text: string; choices: ReadonlyArray<{ id: string; label: string }> } | { kind: 'text'; text: string },
    deliveryKey: string,
    entry: { messageId?: number },
  ): Promise<number> {
    let delivered = 0
    for (const chatKey of chatKeys) {
      try {
        await this.sendInteraction(chatKey, rendered, delivered === 0 ? deliveryKey : `${deliveryKey}:${chatKey}`, entry)
        delivered += 1
      } catch {
        // One unreachable chat must not mute the others; an all-chats failure
        // is handled by the caller.
      }
    }
    return delivered
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
    // The registry's deliver never throws: a failed send comes back as a receipt.
    if (receipt.status === 'failed') throw new Error(receipt.error ?? 'delivery failed')
    const platformId = receipt.platformMessageIds?.[0]
    if (platformId) entry.messageId = Number(platformId)
    this.host.rememberOwnSends(chatKey, receipt.platformMessageIds ?? [])
  }

  /** Settle a pending approval; false when `num` is unknown (already settled, timed out, or from another instance). */
  resolveApproval(num: number, outcome: 'allowed-once' | 'rejected'): boolean {
    const entry = this.pendingApprovals.get(num)
    if (!entry) {
      this.host.log('warn', `approval reply for #${num} matches no pending approval (pending: [${[...this.pendingApprovals.keys()].join(', ')}])`)
      return false
    }
    this.pendingApprovals.delete(num)
    if (entry.timer) clearTimeout(entry.timer)
    entry.resolve?.(outcome)
    return true
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
      entry.reject?.(askError('ASK_ABORTED', 'ask_user_question was aborted before the user answered'))
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
