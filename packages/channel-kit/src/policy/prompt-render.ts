/**
 * Unified interactive prompt (offer/options) rendering and reply parsing.
 *
 * Compared with the binary approval in `approval-render.ts`, this covers N options /
 * multi-select / free text / plan-review intent, and is the channel-agnostic presentation
 * layer of the `dsh-user-questions` seam: the payload only carries question + options[],
 * with no platform callback ids; adaptation is a pure function over capability facts;
 * the text fallback only emits numbered/option text and never leaks callback_data.
 */

/** Presentation limits (same shape as Channel.presentationLimits; the kit does not depend on dsh-channel, so it is defined independently here). */
export interface PresentationLimits {
  /** Max buttons per message; undefined = no known limit. Over the limit, degrade to numbered text. */
  readonly maxOptions?: number
  /** Button label cap (code points); over the limit, truncate and append `…`. */
  readonly maxLabelLength?: number
  /** Callback data (callback_data/value) cap (bytes); e.g. Telegram = 64. */
  readonly maxValueBytes?: number
}

/** One interactive prompt awaiting a reply (a bridge-layer registry entry; `resolve` is filled in by the consumer). */
export interface PendingPrompt {
  readonly num: number
  readonly requestId: string
  readonly question: string
  readonly detail?: string
  readonly options: readonly string[]
  readonly multiSelect: boolean
  readonly allowFreeText: boolean
  readonly recommendedIndex?: number
  readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
  readonly expiresAt: number
  /** Filled in by the consumer: invoked when the user's reply arrives. For single-select, custom overrides selected; for multi-select, custom supplements it. */
  resolve(selected: readonly string[], custom?: string): void
}

export interface PromptOptions {
  supportsChoices: boolean
  supportsMultiSelect: boolean
  presentationLimits?: PresentationLimits
}

export interface PromptChoice {
  readonly id: string
  readonly label: string
}

export type RenderedPrompt =
  | { readonly kind: 'choices'; readonly text: string; readonly choices: readonly PromptChoice[] }
  | { readonly kind: 'text'; readonly text: string }

export type PromptAnswer = { readonly selected: readonly string[]; readonly custom?: string }

export type PromptReply =
  | { readonly kind: 'answer'; readonly num: number; readonly answer: PromptAnswer }
  | { readonly kind: 'not-an-answer' }

export interface RenderPromptInput {
  num: number
  question: string
  detail?: string
  options: readonly string[]
  multiSelect?: boolean
  allowFreeText?: boolean
  recommendedIndex?: number
  intent?: { readonly kind: 'plan-review'; readonly approve: string }
}

/** Option id encoding: button `prompt:<num>:<idx>` (idx is 0-based). Constrained by maxValueBytes (num is a short integer). */
const CHOICE_ID_PREFIX = 'prompt'

/**
 * Render an interactive prompt into a platform-presentable form: emit choices when the
 * platform has buttons (with recommended marker/truncation), otherwise degrade to
 * numbered text (with notes for multi-select/free text).
 */
export function renderPrompt(input: RenderPromptInput, caps: PromptOptions): RenderedPrompt {
  const { num, question, detail, options, multiSelect = false, allowFreeText = false, recommendedIndex, intent } = input
  const body = renderBody(question, detail)
  const maxOptions = caps.presentationLimits?.maxOptions

  const fitsChoices = caps.supportsChoices && (maxOptions === undefined || options.length <= maxOptions)
  if (fitsChoices && options.length > 0) {
    const choices: PromptChoice[] = options.map((label, index) => ({
      id: `${CHOICE_ID_PREFIX}:${num}:${index}`,
      label: formatChoiceLabel(label, index, recommendedIndex, caps.presentationLimits?.maxLabelLength),
    }))
    const text = multiSelect ? `${body}\n(you can select multiple)` : body
    return { kind: 'choices', text, choices }
  }

  const lines = [body, '']
  options.forEach((label, index) => {
    const rec = recommendedIndex === index ? ' (Recommended)' : ''
    lines.push(`  ${index + 1}. ${label}${rec}`)
  })
  if (allowFreeText) lines.push('', 'Reply with a number, or type your answer directly.')
  else if (multiSelect) lines.push('', 'Reply with numbers (comma/space separated for multi-select, e.g. "1, 3").')
  else lines.push('', 'Reply with a number or the option text.')
  return { kind: 'text', text: lines.join('\n') }
}

/** Parse an inbound reply: button callback id or text (numbered/option text/free text). */
export function parsePromptReply(
  input: { readonly text?: string; readonly choiceId?: string; readonly now?: number },
  pending: readonly PendingPrompt[],
): PromptReply {
  const now = input.now ?? Date.now()
  const active = pending.filter((item) => item.expiresAt > now)

  if (input.choiceId !== undefined) {
    const match = /^prompt:(\d+):(\d+)$/.exec(input.choiceId)
    if (!match) return { kind: 'not-an-answer' }
    const num = Number(match[1])
    const index = Number(match[2])
    const entry = active.find((item) => item.num === num)
    if (!entry || index >= entry.options.length) return { kind: 'not-an-answer' }
    return { kind: 'answer', num, answer: { selected: [entry.options[index]!] } }
  }

  const text = input.text?.trim() ?? ''
  if (text === '') return { kind: 'not-an-answer' }

  // `#n ...` numbered form.
  const numbered = /^#\s*(\d+)(?:\s+(.*))?$/.exec(text)
  if (numbered) {
    const num = Number(numbered[1])
    const entry = active.find((item) => item.num === num)
    if (!entry) return { kind: 'not-an-answer' }
    const rest = numbered[2]?.trim()
    if (rest === undefined || rest === '') return { kind: 'not-an-answer' }
    return answerFromBody(entry, rest)
  }

  // With exactly one pending entry: bare numbers, option text, and free text are all valid.
  if (active.length === 1) {
    return answerFromBody(active[0]!, text)
  }

  return { kind: 'not-an-answer' }
}

function answerFromBody(entry: PendingPrompt, body: string): PromptReply {
  const lower = body.toLowerCase()
  const selected: string[] = []

  // Numbers (multiple allowed for multi-select, e.g. "1, 3" / "1 3").
  const tokens = body.split(/[,\s]+/).filter((t) => t !== '')
  if (tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t))) {
    for (const token of tokens) {
      const index = Number(token) - 1
      if (index >= 0 && index < entry.options.length) selected.push(entry.options[index]!)
    }
    if (selected.length > 0 && (entry.multiSelect || selected.length === 1)) {
      return { kind: 'answer', num: entry.num, answer: { selected } }
    }
    if (selected.length === 0) return { kind: 'not-an-answer' }
  }

  // Exact option-text match.
  const exact = entry.options.find((label) => label.toLowerCase() === lower)
  if (exact !== undefined) {
    return { kind: 'answer', num: entry.num, answer: { selected: [exact] } }
  }

  // Free text: only when the entry allows free text.
  if (entry.allowFreeText) {
    return { kind: 'answer', num: entry.num, answer: { selected, custom: body } }
  }

  return { kind: 'not-an-answer' }
}

function renderBody(question: string, detail?: string): string {
  return detail !== undefined && detail !== '' ? `❓ ${question}\n${detail}` : `❓ ${question}`
}

function formatChoiceLabel(label: string, index: number, recommendedIndex: number | undefined, maxLabelLength: number | undefined): string {
  const base = recommendedIndex === index ? `${label} (Recommended)` : label
  const limit = maxLabelLength ?? 64
  const chars = [...base]
  if (chars.length <= limit) return base
  return chars.slice(0, Math.max(0, limit - 1)).join('') + '…'
}
