export interface MergeState {
  readonly buffer: readonly string[]
  readonly deadline: number | undefined
}

export const emptyMergeState: MergeState = { buffer: [], deadline: undefined }

export type MergeInput =
  | { kind: 'message'; text: string; hasMedia: boolean; isCommand: boolean; now: number }
  | { kind: 'tick'; now: number }

export type MergeEffect =
  | { kind: 'flush'; text: string }
  | { kind: 'ack-long' }
  | { kind: 'armTimer'; at: number }

export interface MergeOptions {
  /** 去抖窗口，默认 5000ms */
  windowMs?: number
  /** 超过该长度（码点）的普通文本先回 ack-long，默认 4000 */
  ackLongChars?: number
  /** 续等后缀，默认 '..' */
  continueSuffix?: string
  /** 立即 flush 后缀，默认 '!!' */
  flushSuffix?: string
}

export function mergeReduce(state: MergeState, input: MergeInput, opts: MergeOptions = {}): { state: MergeState; effects: MergeEffect[] } {
  const windowMs = opts.windowMs ?? 5000
  const ackLongChars = opts.ackLongChars ?? 4000
  const continueSuffix = opts.continueSuffix ?? '..'
  const flushSuffix = opts.flushSuffix ?? '!!'

  if (input.kind === 'tick') {
    return onTick(state, input.now)
  }

  const { text, hasMedia, isCommand, now } = input
  const effects: MergeEffect[] = []

  // 命令永不入缓冲，立即旁路（stop/审批不能被去抖延迟）。
  if (isCommand) {
    if (state.buffer.length > 0) {
      effects.push({ kind: 'flush', text: state.buffer.join('\n') })
    }
    if (text.trim() !== '') effects.push({ kind: 'flush', text })
    return { state: emptyMergeState, effects }
  }

  // 带媒体的消息立即 flush 当前缓冲并单独交付（附件不与文本批合并）。
  if (hasMedia) {
    if (state.buffer.length > 0) {
      effects.push({ kind: 'flush', text: state.buffer.join('\n') })
    }
    if (text.trim() !== '') effects.push({ kind: 'flush', text })
    return { state: emptyMergeState, effects }
  }

  if (text.trim() === '') {
    // 空文本不合并，也不影响窗口。
    return { state, effects }
  }

  // 长输入先回"收到，处理中"（如果消费方启用）。
  if ([...text].length >= ackLongChars) {
    effects.push({ kind: 'ack-long' })
  }

  const endsWith = (suffix: string) => suffix.length > 0 && text.endsWith(suffix)

  if (endsWith(continueSuffix)) {
    // `..` 后缀 = 继续等（重置窗口），后缀从投递文本中剥掉。
    const stripped = text.slice(0, -continueSuffix.length).trimEnd()
    const buffer = stripped === '' ? state.buffer : [...state.buffer, stripped]
    const deadline = now + windowMs
    effects.push({ kind: 'armTimer', at: deadline })
    return { state: { buffer, deadline }, effects }
  }

  if (endsWith(flushSuffix)) {
    // `!!` 后缀 = 立即 flush；后缀从投递文本中剥掉。
    const stripped = text.slice(0, -flushSuffix.length).trimEnd()
    const buffer = stripped === '' ? state.buffer : [...state.buffer, stripped]
    const flushText = buffer.join('\n')
    if (flushText.trim() !== '') effects.push({ kind: 'flush', text: flushText })
    return { state: emptyMergeState, effects }
  }

  const buffer = [...state.buffer, text]
  const deadline = now + windowMs
  effects.push({ kind: 'armTimer', at: deadline })
  return { state: { buffer, deadline }, effects }
}

function onTick(state: MergeState, now: number): { state: MergeState; effects: MergeEffect[] } {
  if (state.buffer.length === 0) return { state: emptyMergeState, effects: [] }
  if (state.deadline !== undefined && now >= state.deadline) {
    const text = state.buffer.join('\n')
    return { state: emptyMergeState, effects: text.trim() === '' ? [] : [{ kind: 'flush', text }] }
  }
  // 早到的 tick：重新请求在 deadline 时刻唤醒。
  if (state.deadline !== undefined) {
    return { state, effects: [{ kind: 'armTimer', at: state.deadline }] }
  }
  return { state: emptyMergeState, effects: [] }
}
