export interface MergeState {
  /**
   * One entry per buffered message. The debounce window coalesces the *wait*,
   * not the identity: N separate user messages stay N separate turns.
   * Each entry is the text pieces of that message (currently one piece).
   */
  readonly buffer: readonly string[][]
  readonly deadline: number | undefined
  /** First arrival epoch-ms of the current buffered run (fixed; caps continuous-typing starvation). */
  readonly firstAt: number | undefined
}

export const emptyMergeState: MergeState = { buffer: [], deadline: undefined, firstAt: undefined }

export type MergeInput =
  | { kind: 'message'; text: string; hasMedia: boolean; isCommand: boolean; now: number }
  | { kind: 'tick'; now: number }

export type MergeEffect =
  | { kind: 'flush'; texts: readonly string[] }
  | { kind: 'ack-long' }
  | { kind: 'armTimer'; at: number }

export interface MergeOptions {
  /** Debounce window, default 5000ms */
  windowMs?: number
  /** Plain text longer than this (code points) first gets an ack-long, default 4000 */
  ackLongChars?: number
  /** Continue-waiting suffix, default '..' */
  continueSuffix?: string
  /** Immediate flush suffix, default '!!' */
  flushSuffix?: string
  /**
   * Hard cap on how long a buffered run may live: `firstAt + windowMs * maxWindowMultiplier`.
   * Continuous typing keeps resetting `deadline`; `firstAt` stays fixed so the lane
   * cannot be held open forever. openclaw caps the total wait the same way. Default 5.
   */
  maxWindowMultiplier?: number
}

export function mergeReduce(state: MergeState, input: MergeInput, opts: MergeOptions = {}): { state: MergeState; effects: MergeEffect[] } {
  const windowMs = opts.windowMs ?? 5000
  const ackLongChars = opts.ackLongChars ?? 4000
  const continueSuffix = opts.continueSuffix ?? '..'
  const flushSuffix = opts.flushSuffix ?? '!!'
  const maxWindowMultiplier = opts.maxWindowMultiplier ?? 5

  if (input.kind === 'tick') {
    return onTick(state, input.now)
  }

  const { text, hasMedia, isCommand, now } = input
  const effects: MergeEffect[] = []

  const deadlineFor = (firstAt: number, now: number) => Math.min(now + windowMs, firstAt + windowMs * maxWindowMultiplier)

  // Commands never enter the buffer; they bypass immediately (stop/approval must not be delayed by debouncing).
  if (isCommand) {
    const texts = state.buffer.map((entry) => entry.join(''))
    if (texts.length > 0) effects.push({ kind: 'flush', texts })
    if (text.trim() !== '') effects.push({ kind: 'flush', texts: [text] })
    return { state: emptyMergeState, effects }
  }

  // Messages with media immediately flush the current buffer and are delivered separately (attachments are not merged into the text batch).
  if (hasMedia) {
    const texts = state.buffer.map((entry) => entry.join(''))
    if (texts.length > 0) effects.push({ kind: 'flush', texts })
    if (text.trim() !== '') effects.push({ kind: 'flush', texts: [text] })
    return { state: emptyMergeState, effects }
  }

  if (text.trim() === '') {
    // Empty text is not merged and does not affect the window.
    return { state, effects }
  }

  // A long input first gets an ack ("received, processing") if the consumer enables it.
  if ([...text].length >= ackLongChars) {
    effects.push({ kind: 'ack-long' })
  }

  const endsWith = (suffix: string) => suffix.length > 0 && text.endsWith(suffix)

  if (endsWith(continueSuffix)) {
    // A `..` suffix = keep waiting (reset the window); the suffix is stripped from the delivered text.
    const stripped = text.slice(0, -continueSuffix.length).trimEnd()
    if (stripped === '') {
      // Pure continue-waiting marker: re-arm the timer, identity unchanged.
      const firstAt = state.firstAt ?? now
      const deadline = deadlineFor(firstAt, now)
      effects.push({ kind: 'armTimer', at: deadline })
      return { state: { ...state, deadline }, effects }
    }
    const buffer = [...state.buffer, [stripped]]
    const firstAt = state.firstAt ?? now
    const deadline = deadlineFor(firstAt, now)
    effects.push({ kind: 'armTimer', at: deadline })
    return { state: { buffer, deadline, firstAt }, effects }
  }

  if (endsWith(flushSuffix)) {
    // A `!!` suffix = flush immediately; the suffix is stripped from the delivered text.
    const stripped = text.slice(0, -flushSuffix.length).trimEnd()
    const entries = stripped === '' ? state.buffer : [...state.buffer, [stripped]]
    const texts = entries.map((entry) => entry.join(''))
    if (texts.some((t) => t.trim() !== '')) effects.push({ kind: 'flush', texts })
    return { state: emptyMergeState, effects }
  }

  const buffer = [...state.buffer, [text]]
  const firstAt = state.firstAt ?? now
  const deadline = deadlineFor(firstAt, now)
  effects.push({ kind: 'armTimer', at: deadline })
  return { state: { buffer, deadline, firstAt }, effects }
}

function onTick(state: MergeState, now: number): { state: MergeState; effects: MergeEffect[] } {
  if (state.buffer.length === 0) return { state: emptyMergeState, effects: [] }
  if (state.deadline !== undefined && now >= state.deadline) {
    const texts = state.buffer.map((entry) => entry.join(''))
    return { state: emptyMergeState, effects: texts.every((t) => t.trim() === '') ? [] : [{ kind: 'flush', texts }] }
  }
  // Early tick: re-request a wakeup at the deadline.
  if (state.deadline !== undefined) {
    return { state, effects: [{ kind: 'armTimer', at: state.deadline }] }
  }
  return { state: emptyMergeState, effects: [] }
}
