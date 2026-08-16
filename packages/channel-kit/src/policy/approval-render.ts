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
  /** Inject time for tests; defaults to Date.now(). */
  now?: number
}

export function renderApproval(
  req: { toolName: string; reason?: string; num: number },
  caps: { supportsChoices: boolean },
  _opts: ApprovalRenderOptions = {},
): { kind: 'choices'; text: string; choices: ApprovalChoice[] } | { kind: 'text'; text: string } {
  const title = `⚠️ Needs approval #${req.num}: ${req.toolName}`
  const reason = req.reason ? `\nReason: ${req.reason}` : ''

  if (caps.supportsChoices) {
    return {
      kind: 'choices',
      text: `${title}${reason}`,
      choices: [
        { id: `appr:${req.num}:1`, label: 'Approve' },
        { id: `appr:${req.num}:0`, label: 'Reject' },
      ],
    }
  }

  return {
    kind: 'text',
    text: `${title}${reason}\nReply 1 to approve / 2 to reject`,
  }
}

export type ApprovalReply =
  | { kind: 'answer'; num: number; outcome: 'allowed-once' | 'rejected' }
  | { kind: 'not-an-answer' }

const ALLOW_WORDS = new Set(['approve', 'agree', 'allow', 'yes', 'y'])
const DENY_WORDS = new Set(['reject', 'deny', 'no', 'n'])

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

  // `#n` numbered form: `#2 1` / `#2 approve` / `#2 reject`
  const numbered = /^#\s*(\d+)(?:\s+(.*))?$/.exec(text)
  if (numbered) {
    const num = Number(numbered[1])
    const rest = numbered[2]?.trim().toLowerCase()
    if (!rest) return { kind: 'not-an-answer' }
    const outcome = restOutcome(rest)
    if (!outcome) return { kind: 'not-an-answer' }
    return active.some((item) => item.num === num) ? { kind: 'answer', num, outcome } : { kind: 'not-an-answer' }
  }

  // A bare answer word is only valid when there is exactly one pending item.
  const lower = text.toLowerCase()
  const word = wordOutcome(lower)
  if (word) {
    if (active.length === 1) {
      return { kind: 'answer', num: active[0]!.num, outcome: word }
    }
    return { kind: 'not-an-answer' }
  }

  // Bare digits, per the rendered text hint ("Reply 1 to approve / 2 to reject");
  // `0` is accepted as a reject alias for the button encoding. Only valid when
  // there is exactly one pending item.
  if (/^[012]$/.test(text) && active.length === 1) {
    return { kind: 'answer', num: active[0]!.num, outcome: text === '1' ? 'allowed-once' : 'rejected' }
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
