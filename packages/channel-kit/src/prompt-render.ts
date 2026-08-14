/**
 * 统一交互提示（offer/选项）渲染与应答解析。
 *
 * 与 `approval-render.ts` 的二进制审批相比，这里覆盖 N 选项 / 多选 / 自由文本 /
 * plan-review 意图，是 `dsh-user-questions` seam 的呈现层（channel-agnostic）：
 * 载荷只含 question + options[]，不含任何平台回调 id；适配是一份能力事实的纯函数；
 * 文本降级只出编号/选项文本，绝不泄漏 callback_data。
 */

/** 呈现上限（Channel.presentationLimits 的结构同款；kit 不依赖 dsh-channel，故在此独立定义）。 */
export interface PresentationLimits {
  /** 单条消息最多按钮数；undefined=无已知上限。超限降级编号文本。 */
  readonly maxOptions?: number
  /** 按钮文字上限（码点）；超限截断加 `…`。 */
  readonly maxLabelLength?: number
  /** 回调数据（callback_data/value）上限（字节）；如 Telegram=64。 */
  readonly maxValueBytes?: number
}

/** 一条待应答的交互提示（桥接层注册表条目；`resolve` 由消费方填）。 */
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
  /** 消费方填：用户应答到达时回填。单选时 custom 覆盖 selected；多选时 custom 补充。 */
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

/** 选项 id 编码：按钮 `prompt:<num>:<idx>`（idx 从 0 起）。受 maxValueBytes 约束（num 短整型）。 */
const CHOICE_ID_PREFIX = 'prompt'

/**
 * 把一条交互提示渲染成平台可呈现的形态：有按钮能力时出 choices（含推荐标记/截断），
 * 否则降级为编号文本（多选/自由文本带说明）。
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
    const text = multiSelect ? `${body}\n（可多选）` : body
    return { kind: 'choices', text, choices }
  }

  const lines = [body, '']
  options.forEach((label, index) => {
    const rec = recommendedIndex === index ? '（推荐）' : ''
    lines.push(`  ${index + 1}. ${label}${rec}`)
  })
  if (allowFreeText) lines.push('', '回复数字选择，或直接输入你的答案。')
  else if (multiSelect) lines.push('', '回复数字（可逗号/空格分隔多选，如 "1, 3"）。')
  else lines.push('', '回复数字或选项文本。')
  return { kind: 'text', text: lines.join('\n') }
}

/** 解析入站应答：按钮回调 id 或文本（编号/选项文本/自由文本）。 */
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

  // `#n ...` 编号形式。
  const numbered = /^#\s*(\d+)(?:\s+(.*))?$/.exec(text)
  if (numbered) {
    const num = Number(numbered[1])
    const entry = active.find((item) => item.num === num)
    if (!entry) return { kind: 'not-an-answer' }
    const rest = numbered[2]?.trim()
    if (rest === undefined || rest === '') return { kind: 'not-an-answer' }
    return answerFromBody(entry, rest)
  }

  // 唯一一条 pending 时：裸数字、选项文本、自由文本都有效。
  if (active.length === 1) {
    return answerFromBody(active[0]!, text)
  }

  return { kind: 'not-an-answer' }
}

function answerFromBody(entry: PendingPrompt, body: string): PromptReply {
  const lower = body.toLowerCase()
  const selected: string[] = []

  // 数字（多选时允许多个，如 "1, 3" / "1 3"）。
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

  // 精确选项文本匹配。
  const exact = entry.options.find((label) => label.toLowerCase() === lower)
  if (exact !== undefined) {
    return { kind: 'answer', num: entry.num, answer: { selected: [exact] } }
  }

  // 自由文本：仅当该条目允许自由文本。
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
