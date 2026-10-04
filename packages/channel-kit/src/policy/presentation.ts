/**
 * Presentation policy: the "what messages to send" axis.
 *
 * Bundles the pure presentation reducers/renders — session-event projection,
 * stream reduction, tool-call/result text, and thinking — into one replaceable
 * strategy. The default is exactly today's behavior (streamReduce + tool-display +
 * thinking off), so swapping it is the only way presentation changes.
 *
 * `reduce` takes the renderers as its last argument (the bridge passes the policy
 * itself), so overriding `renderToolCall`/`renderToolResult`/`renderThinking` on a
 * custom policy actually flows into the reducer — the reducer never re-imports the
 * module-level renderers behind the policy's back.
 *
 * Dependency-free by design: `SessionEventLike` is the structural view of
 * `dsh-session`'s `SessionEvent`, so this module never imports dsh internals.
 */
import { stripReasoningTags, stripToolCallMarkup } from '../format/format.js'
import { defaultStreamRenderers, streamReduce, type StreamCaps, type StreamFrame, type StreamInput, type StreamRenderers, type StreamState } from './stream.js'
import type { ThinkingInput, ThinkingLevel } from './thinking.js'

/** Structural view of a session event (the real SessionEvent satisfies this). */
export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
}

/** Resolves a tool callId back to its name (the bridge owns the callId → name map). */
export type ToolNameResolver = (callId: string) => string | undefined

export interface PresentationPolicy extends StreamRenderers {
  /** Project a session event into presentation inputs ([] = ignore). */
  project(event: SessionEventLike, toolNameOf: ToolNameResolver): readonly StreamInput[]
  /** Fold presentation inputs into presentation frames (pure; timers live outside). */
  reduce(state: StreamState, input: StreamInput, caps: StreamCaps, now: number, renderers: StreamRenderers): { state: StreamState; frames: StreamFrame[] }
}

/** The default presentation policy — today's behavior, unchanged. */
export const defaultPresentationPolicy: PresentationPolicy = {
  project: projectSessionEvent,
  reduce: streamReduce,
  ...defaultStreamRenderers,
}

/** Project a session event into presentation inputs. This replaces the per-bridge `if (event.type === …)` chains. */
export function projectSessionEvent(event: SessionEventLike, toolNameOf: ToolNameResolver): readonly StreamInput[] {
  const data = event.data as Record<string, any> | undefined
  switch (event.type) {
    case 'turn/start':
      return [{ kind: 'turn-start' }]
    case 'step/start':
      return [{ kind: 'step-start', turn: Number(data?.turn ?? 0), step: Number(data?.step ?? 0) }]
    case 'step/end':
      return [{ kind: 'step-end', turn: Number(data?.turn ?? 0), step: Number(data?.step ?? 0) }]
    case 'tool/call':
      return [{
        kind: 'tool-call',
        callId: String(data?.callId ?? ''),
        name: String(data?.name ?? ''),
        arguments: String(data?.arguments ?? ''),
      }]
    case 'tool/result': {
      // 0.2 ToolResultMessage: role 'tool', the call id at the top level (mirrored in source.callId).
      const message = data?.message
      const callId = String(message?.toolCallId ?? message?.source?.callId ?? '')
      return [{
        kind: 'tool-result',
        callId,
        name: toolNameOf(callId) ?? 'tool',
        ok: data?.error === undefined,
        summary: typeof data?.error?.name === 'string' ? data.error.name : undefined,
      }]
    }
    case 'assistant/message': {
      const message = data?.message
      const reasoning = assistantReasoningText(message)
      const text = assistantMessageText(message)
      const inputs: StreamInput[] = []
      if (reasoning !== '') inputs.push({ kind: 'reasoning-block', text: reasoning })
      if (text !== '') inputs.push({ kind: 'assistant-message', text })
      return inputs
    }
    case 'turn/end':
      return [{ kind: 'turn-end', reason: (data?.reason?.kind ?? 'completed') as 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' | 'forked' }]
    default:
      return []
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

/** Extract the reasoning blocks from an assistant message (the "final thinking", for the 'on' tier). */
export function assistantReasoningText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: Array<{ type?: string; text?: string }> }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => (block?.type === 'reasoning' || block?.type === 'thinking') && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
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
    case 'forked':
      return 'Forked'
    default:
      return kind
  }
}
