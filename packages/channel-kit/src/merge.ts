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
  /** Debounce window, default 5000ms */
  windowMs?: number
  /** Plain text longer than this (code points) first gets an ack-long, default 4000 */
  ackLongChars?: number
  /** Continue-waiting suffix, default '..' */
  continueSuffix?: string
  /** Immediate flush suffix, default '!!' */
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

  // Commands never enter the buffer; they bypass immediately (stop/approval must not be delayed by debouncing).
  if (isCommand) {
    if (state.buffer.length > 0) {
      effects.push({ kind: 'flush', text: state.buffer.join('\n') })
    }
    if (text.trim() !== '') effects.push({ kind: 'flush', text })
    return { state: emptyMergeState, effects }
  }

  // Messages with media immediately flush the current buffer and are delivered separately (attachments are not merged into the text batch).
  if (hasMedia) {
    if (state.buffer.length > 0) {
      effects.push({ kind: 'flush', text: state.buffer.join('\n') })
    }
    if (text.trim() !== '') effects.push({ kind: 'flush', text })
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
    const buffer = stripped === '' ? state.buffer : [...state.buffer, stripped]
    const deadline = now + windowMs
    effects.push({ kind: 'armTimer', at: deadline })
    return { state: { buffer, deadline }, effects }
  }

  if (endsWith(flushSuffix)) {
    // A `!!` suffix = flush immediately; the suffix is stripped from the delivered text.
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
  // Early tick: re-request a wakeup at the deadline.
  if (state.deadline !== undefined) {
    return { state, effects: [{ kind: 'armTimer', at: state.deadline }] }
  }
  return { state: emptyMergeState, effects: [] }
}
