/**
 * Streaming presentation reducer: fold session events into "presentation frames".
 *
 * Pure function (timers live outside, as in merge.ts): `streamReduce(state, input, caps, now, render)`
 * returns new state + frames. Frames are presentation intents (final/draft/draft-finalize/
 * status-line/arm-timer), executed by the bridge layer. Gating follows openclaw: in progress
 * mode the first tool event only arms a 1500ms timer, and the draft is created only when the
 * timer fires, so quick answers produce zero noise. block (text-chunk editing) v1 degrades to
 * terminal-state delivery.
 *
 * `render` is the *injected* renderer set (tool-call line / tool-result line / thinking line).
 * It is passed in from the `PresentationPolicy` at call time so a custom policy that overrides
 * `renderToolCall`/`renderToolResult`/`renderThinking` actually takes effect — the reducer never
 * reaches back to the module-level renderers when the caller supplies its own.
 */
import { renderThinking, type ThinkingInput, type ThinkingLevel } from './thinking.js'
import { formatToolLine, formatToolResultLine, resolveToolDisplay } from './tool-display.js'

export interface StreamCaps {
  streamingMode: 'off' | 'block' | 'progress'
  supportsEdit: boolean
  supportsStatusText: boolean
  thinkingLevel: ThinkingLevel
}

/** The three presentation renders the reducer needs. A PresentationPolicy satisfies this. */
export interface StreamRenderers {
  renderToolCall(name: string, args: string): string
  renderToolResult(name: string, result: { ok: boolean; durationMs?: number; summary?: string }): string
  renderThinking(input: ThinkingInput, level: ThinkingLevel): string | null
}

export type StreamInput =
  | { readonly kind: 'turn-start' }
  | { readonly kind: 'step-start'; readonly turn: number; readonly step: number }
  | { readonly kind: 'step-end'; readonly turn: number; readonly step: number }
  | { readonly kind: 'tool-call'; readonly callId: string; readonly name: string; readonly arguments: string }
  | { readonly kind: 'tool-result'; readonly callId: string; readonly name: string; readonly ok: boolean; readonly durationMs?: number; readonly summary?: string }
  | { readonly kind: 'text-delta'; readonly text: string }
  | { readonly kind: 'reasoning-delta'; readonly text: string }
  | { readonly kind: 'reasoning-block'; readonly text: string }
  | { readonly kind: 'assistant-message'; readonly text: string }
  | { readonly kind: 'turn-end'; readonly reason: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' }
  | { readonly kind: 'tick' }
  /** The bridge feeds this when `showDraft` (edit-in-place) rejects mid-stream. */
  | { readonly kind: 'edit-failed'; readonly visiblePrefix?: string }

export interface StreamState {
  readonly bufferedText: string
  readonly toolLines: readonly string[]
  readonly draftStarted: boolean
  readonly gateDeadline: number | undefined
  /** Whether a thinking status line was already emitted this turn (coalesces the 'stream' tier). */
  readonly thinkingShown: boolean
  /** Last draft text emitted this turn (the visible prefix for edit-failure degradation). */
  readonly draftText: string
  /** What the user already saw when edit-in-place died; subsequent updates send only the tail. */
  readonly visiblePrefix: string
  /** True once edit-in-place failed this turn; append-tail mode, never edit again this turn. */
  readonly editFailed: boolean
}

export const emptyStreamState: StreamState = {
  bufferedText: '',
  toolLines: [],
  draftStarted: false,
  gateDeadline: undefined,
  thinkingShown: false,
  draftText: '',
  visiblePrefix: '',
  editFailed: false,
}

export type StreamFrame =
  | { readonly kind: 'noop' }
  | { readonly kind: 'final'; readonly text: string }
  | { readonly kind: 'draft'; readonly text: string }
  | { readonly kind: 'draft-finalize' }
  | { readonly kind: 'status-line'; readonly text: string }
  | { readonly kind: 'arm-timer'; readonly at: number }

const PROGRESS_GATE_MS = 1500
const DRAFT_HEADER = 'Working…'

/** The built-in renderers: tool-call/result → tool-display lines; thinking → placeholder. */
export const defaultStreamRenderers: StreamRenderers = {
  renderToolCall: renderToolCallLine,
  renderToolResult: renderToolResultLine,
  renderThinking,
}

export function streamReduce(
  state: StreamState,
  input: StreamInput,
  caps: StreamCaps,
  now: number,
  render: StreamRenderers = defaultStreamRenderers,
): { state: StreamState; frames: StreamFrame[] } {
  const mode = resolveMode(caps)
  if (mode === 'off') return reduceOff(state, input)
  return reduceProgress(state, input, caps, now, render)
}

function resolveMode(caps: StreamCaps): 'off' | 'progress' {
  if (caps.streamingMode === 'off') return 'off'
  if (caps.streamingMode === 'block') return 'off' // text-chunk streaming v2; v1 degrades to terminal state.
  if (!caps.supportsEdit && !caps.supportsStatusText) return 'off'
  return 'progress'
}

function reduceOff(state: StreamState, input: StreamInput): { state: StreamState; frames: StreamFrame[] } {
  if (input.kind === 'assistant-message') {
    return { state: resetStreamState(), frames: [{ kind: 'final', text: input.text }] }
  }
  return { state, frames: [{ kind: 'noop' }] }
}

function resetStreamState(): StreamState {
  return {
    bufferedText: '',
    toolLines: [],
    draftStarted: false,
    gateDeadline: undefined,
    thinkingShown: false,
    draftText: '',
    visiblePrefix: '',
    editFailed: false,
  }
}

function reduceProgress(
  state: StreamState,
  input: StreamInput,
  caps: StreamCaps,
  now: number,
  render: StreamRenderers,
): { state: StreamState; frames: StreamFrame[] } {
  switch (input.kind) {
    case 'turn-start':
      return { state: resetStreamState(), frames: [{ kind: 'noop' }] }

    case 'edit-failed': {
      // Record the visible prefix (bridge supplies it; fall back to the last draft
      // text the reducer emitted) and flip to append-tail mode permanently this turn.
      const visiblePrefix = input.visiblePrefix ?? state.draftText
      return { state: { ...state, visiblePrefix, editFailed: true }, frames: [{ kind: 'noop' }] }
    }

    case 'tool-call': {
      const line = render.renderToolCall(input.name, input.arguments)
      const toolLines = [...state.toolLines, line]
      const full = composeDraft(toolLines)
      if (state.editFailed) {
        return { state: { ...state, toolLines, draftText: full }, frames: statusLineTail(full, state.visiblePrefix) }
      }
      if (state.draftStarted) {
        return { state: { ...state, toolLines, draftText: full }, frames: [{ kind: 'draft', text: full }] }
      }
      if (state.gateDeadline === undefined) {
        const at = now + PROGRESS_GATE_MS
        return { state: { ...state, toolLines, gateDeadline: at }, frames: [{ kind: 'arm-timer', at }] }
      }
      return { state: { ...state, toolLines }, frames: [{ kind: 'noop' }] }
    }

    case 'tool-result': {
      if (!state.draftStarted && !state.editFailed) return { state, frames: [{ kind: 'noop' }] }
      const line = render.renderToolResult(input.name, { ok: input.ok, durationMs: input.durationMs, summary: input.summary })
      const toolLines = [...state.toolLines, line]
      const full = composeDraft(toolLines)
      if (state.editFailed) {
        return { state: { ...state, toolLines, draftText: full }, frames: statusLineTail(full, state.visiblePrefix) }
      }
      return { state: { ...state, toolLines, draftText: full }, frames: [{ kind: 'draft', text: full }] }
    }

    case 'assistant-message': {
      const frames: StreamFrame[] = []
      if (state.draftStarted) frames.push({ kind: 'draft-finalize' })
      frames.push({ kind: 'final', text: input.text })
      return { state: resetStreamState(), frames }
    }

    case 'turn-end': {
      const next = resetStreamState()
      return state.draftStarted ? { state: next, frames: [{ kind: 'draft-finalize' }] } : { state: next, frames: [{ kind: 'noop' }] }
    }

    case 'tick': {
      if (state.gateDeadline === undefined) return { state, frames: [{ kind: 'noop' }] }
      if (now >= state.gateDeadline) {
        const full = composeDraft(state.toolLines)
        if (state.editFailed) {
          return {
            state: { ...state, draftStarted: true, gateDeadline: undefined, draftText: full },
            frames: statusLineTail(full, state.visiblePrefix),
          }
        }
        return {
          state: { ...state, draftStarted: true, gateDeadline: undefined, draftText: full },
          frames: [{ kind: 'draft', text: full }],
        }
      }
      return { state, frames: [{ kind: 'arm-timer', at: state.gateDeadline }] }
    }

    case 'text-delta':
      return { state: { ...state, bufferedText: state.bufferedText + input.text }, frames: [{ kind: 'noop' }] }

    case 'reasoning-delta':
    case 'reasoning-block': {
      // Coalesce: only one thinking status line per turn (a 'stream' tier would otherwise spam identical bubbles).
      if (state.thinkingShown) return { state, frames: [{ kind: 'noop' }] }
      const line = render.renderThinking({ kind: input.kind === 'reasoning-block' ? 'block' : 'delta', text: input.text }, caps.thinkingLevel)
      if (line === null) return { state, frames: [{ kind: 'noop' }] }
      return { state: { ...state, thinkingShown: true }, frames: [{ kind: 'status-line', text: line }] }
    }

    case 'step-start':
    case 'step-end':
      return { state, frames: [{ kind: 'noop' }] }
  }
}

function statusLineTail(full: string, visiblePrefix: string): StreamFrame[] {
  const tail = tailAfter(full, visiblePrefix)
  return tail === '' ? [{ kind: 'noop' }] : [{ kind: 'status-line', text: tail }]
}

function tailAfter(full: string, visiblePrefix: string): string {
  if (visiblePrefix !== '' && full.startsWith(visiblePrefix)) {
    return full.slice(visiblePrefix.length).replace(/^\n+/, '')
  }
  return full
}

function composeDraft(lines: readonly string[]): string {
  return [DRAFT_HEADER, ...lines].join('\n')
}

function renderToolCallLine(name: string, args: string): string {
  const display = resolveToolDisplay(name, args)
  return formatToolLine(display, { detailMode: 'compact', commandText: 'status', maxDetailChars: 40 })
}

function renderToolResultLine(name: string, result: { ok: boolean; durationMs?: number; summary?: string }): string {
  return formatToolResultLine(name, { ok: result.ok, durationMs: result.durationMs, summary: result.summary })
}
