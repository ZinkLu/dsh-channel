export interface ApprovalChoice {
  readonly id: string
  readonly label: string
}

export interface PendingApproval {
  readonly num: number
  readonly requestId: string
  readonly toolName: string
  readonly expiresAt: number
}

export interface ApprovalRenderOptions {
  /** 供测试注入时间；缺省用 Date.now()。 */
  now?: number
}

export function renderApproval(
  req: { toolName: string; reason?: string; num: number },
  caps: { supportsChoices: boolean },
  _opts: ApprovalRenderOptions = {},
): { kind: 'choices'; text: string; choices: ApprovalChoice[] } | { kind: 'text'; text: string } {
  const title = `⚠️ 需要批准 #${req.num}：${req.toolName}`
  const reason = req.reason ? `\n原因：${req.reason}` : ''

  if (caps.supportsChoices) {
    return {
      kind: 'choices',
      text: `${title}${reason}`,
      choices: [
        { id: `appr:${req.num}:1`, label: '批准' },
        { id: `appr:${req.num}:0`, label: '拒绝' },
      ],
    }
  }

  return {
    kind: 'text',
    text: `${title}${reason}\n回复 1 批准 / 2 拒绝`,
  }
}

export type ApprovalReply =
  | { kind: 'answer'; num: number; outcome: 'allowed-once' | 'rejected' }
  | { kind: 'not-an-answer' }

const ALLOW_WORDS = new Set(['批准', '同意', '允许', 'yes', 'y', 'allow', 'approve'])
const DENY_WORDS = new Set(['拒绝', 'no', 'n', 'deny', 'reject'])

export function parseApprovalReply(
  input: { text?: string; choiceId?: string; now?: number },
  pending: readonly PendingApproval[],
): ApprovalReply {
  const now = input.now ?? Date.now()
  const active = pending.filter((item) => item.expiresAt > now)

  if (input.choiceId !== undefined) {
    const match = /^appr:(\d+):([01])$/.exec(input.choiceId)
    if (!match) return { kind: 'not-an-answer' }
    return answerFor(Number(match[1]), match[2] === '1', active)
  }

  const text = input.text?.trim() ?? ''
  if (text === '') return { kind: 'not-an-answer' }

  // `#n` 编号形式：`#2 1` / `#2 批准` / `#2 拒绝`
  const numbered = /^#\s*(\d+)(?:\s+(.*))?$/.exec(text)
  if (numbered) {
    const num = Number(numbered[1])
    const rest = numbered[2]?.trim().toLowerCase()
    if (!rest) return { kind: 'not-an-answer' }
    const outcome = restOutcome(rest)
    if (!outcome) return { kind: 'not-an-answer' }
    return active.some((item) => item.num === num) ? { kind: 'answer', num, outcome } : { kind: 'not-an-answer' }
  }

  // 裸应答词只在恰有一条 pending 时有效。
  const lower = text.toLowerCase()
  const word = wordOutcome(lower)
  if (word) {
    if (active.length === 1) {
      return { kind: 'answer', num: active[0]!.num, outcome: word }
    }
    return { kind: 'not-an-answer' }
  }

  // `1`/`2` 或 `#1` 也走上面的编号分支；这里处理裸数字。
  if (/^[01]$/.test(text) || text === '1' || text === '2') {
    if (active.length === 1) {
      return { kind: 'answer', num: active[0]!.num, outcome: text === '1' ? 'allowed-once' : 'rejected' }
    }
    return { kind: 'not-an-answer' }
  }

  return { kind: 'not-an-answer' }
}

function restOutcome(lower: string): 'allowed-once' | 'rejected' | undefined {
  if (lower === '1') return 'allowed-once'
  if (lower === '2' || lower === '0') return 'rejected'
  return wordOutcome(lower)
}

function wordOutcome(lower: string): 'allowed-once' | 'rejected' | undefined {
  if (ALLOW_WORDS.has(lower)) return 'allowed-once'
  if (DENY_WORDS.has(lower)) return 'rejected'
  return undefined
}

function answerFor(num: number, allow: boolean, active: readonly PendingApproval[]): ApprovalReply {
  if (!active.some((item) => item.num === num)) return { kind: 'not-an-answer' }
  return { kind: 'answer', num, outcome: allow ? 'allowed-once' : 'rejected' }
}
