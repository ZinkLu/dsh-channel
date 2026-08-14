/**
 * Streaming presentation reducer: fold session events into "presentation frames".
 *
 * Pure function (timers live outside, as in merge.ts): `streamReduce(state, input, caps, now)`
 * returns new state + frames. Frames are presentation intents (final/draft/draft-finalize/
 * arm-timer), executed by the bridge layer. Gating follows openclaw: in progress mode the
 * first tool event only arms a 1500ms timer, and the draft is created only when the timer
 * fires, so quick answers produce zero noise. block (text-chunk editing) v1 degrades to
 * terminal-state delivery.
 */
import { formatToolLine, formatToolResultLine, resolveToolDisplay } from './tool-display.js'

export interface StreamCaps {
  streamingMode: 'off' | 'block' | 'progress'
  supportsEdit: boolean
  supportsStatusText: boolean
  supportsThinking: boolean
}

export type StreamInput =
  | { readonly kind: 'turn-start' }
  | { readonly kind: 'step-start'; readonly turn: number; readonly step: number }
  | { readonly kind: 'step-end'; readonly turn: number; readonly step: number }
  | { readonly kind: 'tool-call'; readonly callId: string; readonly name: string; readonly arguments: string }
  | { readonly kind: 'tool-result'; readonly callId: string; readonly name: string; readonly ok: boolean; readonly durationMs?: number; readonly summary?: string }
  | { readonly kind: 'text-delta'; readonly text: string }
  | { readonly kind: 'reasoning-delta'; readonly text: string }
  | { readonly kind: 'assistant-message'; readonly text: string }
  | { readonly kind: 'turn-end'; readonly reason: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' }
  | { readonly kind: 'tick' }

export interface StreamState {
  readonly bufferedText: string
  readonly toolLines: readonly string[]
  readonly draftStarted: boolean
  readonly gateDeadline: number | undefined
}

export const emptyStreamState: StreamState = {
  bufferedText: '',
  toolLines: [],
  draftStarted: false,
  gateDeadline: undefined,
}

export type StreamFrame =
  | { readonly kind: 'noop' }
  | { readonly kind: 'final'; readonly text: string }
  | { readonly kind: 'draft'; readonly text: string }
  | { readonly kind: 'draft-finalize' }
  | { readonly kind: 'arm-timer'; readonly at: number }

const PROGRESS_GATE_MS = 1500
const DRAFT_HEADER = 'Working…'

export function streamReduce(state: StreamState, input: StreamInput, caps: StreamCaps, now: number): { state: StreamState; frames: StreamFrame[] } {
  const mode = resolveMode(caps)
  if (mode === 'off') return reduceOff(state, input)
  return reduceProgress(state, input, now)
}

function resolveMode(caps: StreamCaps): 'off' | 'progress' {
  if (caps.streamingMode === 'off') return 'off'
  if (caps.streamingMode === 'block') return 'off' // text-chunk streaming v2; v1 degrades to terminal state.
  if (!caps.supportsEdit && !caps.supportsStatusText) return 'off'
  return 'progress'
}

function reduceOff(state: StreamState, input: StreamInput): { state: StreamState; frames: StreamFrame[] } {
  if (input.kind === 'assistant-message') {
    return { state: { ...state, bufferedText: '' }, frames: [{ kind: 'final', text: input.text }] }
  }
  return { state, frames: [{ kind: 'noop' }] }
}

function reduceProgress(state: StreamState, input: StreamInput, now: number): { state: StreamState; frames: StreamFrame[] } {
  switch (input.kind) {
    case 'turn-start':
      return { state: { bufferedText: '', toolLines: [], draftStarted: false, gateDeadline: undefined }, frames: [{ kind: 'noop' }] }

    case 'tool-call': {
      const display = resolveToolDisplay(input.name, input.arguments)
      const line = formatToolLine(display, { detailMode: 'compact', commandText: 'status', maxDetailChars: 40 })
      const toolLines = [...state.toolLines, line]
      if (state.draftStarted) {
        return { state: { ...state, toolLines }, frames: [{ kind: 'draft', text: composeDraft(toolLines) }] }
      }
      if (state.gateDeadline === undefined) {
        const at = now + PROGRESS_GATE_MS
        return { state: { ...state, toolLines, gateDeadline: at }, frames: [{ kind: 'arm-timer', at }] }
      }
      return { state: { ...state, toolLines }, frames: [{ kind: 'noop' }] }
    }

    case 'tool-result': {
      if (!state.draftStarted) return { state, frames: [{ kind: 'noop' }] }
      const line = formatToolResultLine(input.name, { ok: input.ok, durationMs: input.durationMs, summary: input.summary })
      const toolLines = [...state.toolLines, line]
      return { state: { ...state, toolLines }, frames: [{ kind: 'draft', text: composeDraft(toolLines) }] }
    }

    case 'assistant-message': {
      const frames: StreamFrame[] = []
      if (state.draftStarted) frames.push({ kind: 'draft-finalize' })
      frames.push({ kind: 'final', text: input.text })
      return { state: { bufferedText: '', toolLines: [], draftStarted: false, gateDeadline: undefined }, frames }
    }

    case 'turn-end': {
      const next = { bufferedText: '', toolLines: [], draftStarted: false, gateDeadline: undefined }
      return state.draftStarted ? { state: next, frames: [{ kind: 'draft-finalize' }] } : { state: next, frames: [{ kind: 'noop' }] }
    }

    case 'tick': {
      if (state.gateDeadline === undefined) return { state, frames: [{ kind: 'noop' }] }
      if (now >= state.gateDeadline) {
        return { state: { ...state, draftStarted: true, gateDeadline: undefined }, frames: [{ kind: 'draft', text: composeDraft(state.toolLines) }] }
      }
      return { state, frames: [{ kind: 'arm-timer', at: state.gateDeadline }] }
    }

    case 'text-delta':
      return { state: { ...state, bufferedText: state.bufferedText + input.text }, frames: [{ kind: 'noop' }] }

    case 'reasoning-delta':
    case 'step-start':
    case 'step-end':
      return { state, frames: [{ kind: 'noop' }] }
  }
}

function composeDraft(lines: readonly string[]): string {
  return [DRAFT_HEADER, ...lines].join('\n')
}
