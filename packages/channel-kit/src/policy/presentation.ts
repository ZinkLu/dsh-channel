/**
 * Presentation policy: the "what messages to send" axis.
 *
 * Bundles the pure presentation reducers/renders — session-event projection,
 * stream reduction, tool-call/result text, and thinking — into one replaceable
 * strategy. The default is exactly today's behavior (streamReduce + tool-display +
 * thinking off), so swapping it is the only way presentation changes.
 *
 * Dependency-free by design: `SessionEventLike` is the structural view of
 * `dsh-session`'s `SessionEvent`, so this module never imports dsh internals.
 */
import { stripReasoningTags, stripToolCallMarkup } from '../format/format.js'
import { streamReduce, type StreamCaps, type StreamFrame, type StreamInput, type StreamState } from './stream.js'
import { renderThinking, type ThinkingInput, type ThinkingLevel } from './thinking.js'
import { formatToolLine, formatToolResultLine, resolveToolDisplay } from './tool-display.js'

/** Structural view of a session event (the real SessionEvent satisfies this). */
export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
}

/** Resolves a tool callId back to its name (the bridge owns the callId → name map). */
export type ToolNameResolver = (callId: string) => string | undefined

export interface PresentationPolicy {
  /** Project a session event into a presentation input (null = ignore). */
  project(event: SessionEventLike, toolNameOf: ToolNameResolver): StreamInput | null
  /** Fold presentation inputs into presentation frames (pure; timers live outside). */
  reduce(state: StreamState, input: StreamInput, caps: StreamCaps, now: number): { state: StreamState; frames: StreamFrame[] }
  /** Tool call → one human-readable line. */
  renderToolCall(name: string, args: string): string
  /** Tool result → one human-readable line. */
  renderToolResult(name: string, result: { ok: boolean; durationMs?: number; summary?: string }): string
  /** Thinking → status line, or null to discard (default off). */
  renderThinking(input: ThinkingInput, level: ThinkingLevel): string | null
}

/** The default presentation policy — today's behavior, unchanged. */
export const defaultPresentationPolicy: PresentationPolicy = {
  project: projectSessionEvent,
  reduce: streamReduce,
  renderToolCall: renderToolCallLine,
  renderToolResult: renderToolResultLine,
  renderThinking,
}

/** Project a session event into a presentation input. This replaces the per-bridge `if (event.type === …)` chains. */
export function projectSessionEvent(event: SessionEventLike, toolNameOf: ToolNameResolver): StreamInput | null {
  const data = event.data as Record<string, any> | undefined
  switch (event.type) {
    case 'turn/start':
      return { kind: 'turn-start' }
    case 'step/start':
      return { kind: 'step-start', turn: Number(data?.turn ?? 0), step: Number(data?.step ?? 0) }
    case 'step/end':
      return { kind: 'step-end', turn: Number(data?.turn ?? 0), step: Number(data?.step ?? 0) }
    case 'tool/call':
      return {
        kind: 'tool-call',
        callId: String(data?.callId ?? ''),
        name: String(data?.name ?? ''),
        arguments: String(data?.arguments ?? ''),
      }
    case 'tool/result': {
      const callId = String(data?.message?.content?.[0]?.toolCallId ?? '')
      return {
        kind: 'tool-result',
        callId,
        name: toolNameOf(callId) ?? 'tool',
        ok: data?.error === undefined,
        summary: typeof data?.error?.name === 'string' ? data.error.name : undefined,
      }
    }
    case 'assistant/message':
      return { kind: 'assistant-message', text: assistantMessageText(data?.message) }
    case 'turn/end':
      return { kind: 'turn-end', reason: (data?.reason?.kind ?? 'completed') as 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' }
    default:
      return null
  }
}

/** Extract the visible text from an assistant message, stripping reasoning/tool-call markup. */
export function assistantMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: Array<{ type?: string; text?: string }> }).content
  if (!Array.isArray(content)) return ''
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  return stripReasoningTags(stripToolCallMarkup(text))
}

/** Turn-end reason → human label (the ⏹ status line). */
export function turnEndLabel(kind: string): string {
  switch (kind) {
    case 'aborted':
      return 'Aborted'
    case 'blocked':
      return 'Blocked'
    case 'error':
      return 'Error'
    case 'max-tokens':
      return 'Max tokens'
    case 'interrupted':
      return 'Interrupted'
    default:
      return kind
  }
}

function renderToolCallLine(name: string, args: string): string {
  const display = resolveToolDisplay(name, args)
  return formatToolLine(display, { detailMode: 'compact', commandText: 'status', maxDetailChars: 40 })
}

function renderToolResultLine(name: string, result: { ok: boolean; durationMs?: number; summary?: string }): string {
  return formatToolResultLine(name, { ok: result.ok, durationMs: result.durationMs, summary: result.summary })
}
