/**
 * Thinking presentation: the "positive" handling of model reasoning content.
 *
 * Today reasoning is only ever *stripped* (never shown): `stream.ts` maps
 * `reasoning-delta` to `noop`, and `assistantMessageText` drops non-`text` blocks.
 * This module is the seam for the opposite direction — presenting thinking as a
 * status line — following openclaw's `ReasoningLevel = off | on | stream`:
 *
 *   off    → never hand thinking down (the default; no behavior change)
 *   on     → fold the *final* reasoning block into one status line
 *   stream → status line per reasoning delta
 *
 * The raw chain-of-thought bytes are never surfaced verbatim; `renderThinking`
 * returns only a conservative placeholder line, so the "never leak the model's
 * internals" guarantee (format.stripReasoningTags) is preserved regardless of level.
 */

export type ThinkingLevel = 'off' | 'on' | 'stream'

/** One unit of reasoning handed to the presentation layer. */
export interface ThinkingInput {
  readonly kind: 'delta' | 'block'
  readonly text: string
}

/**
 * Render a thinking unit into a status line, or `null` to discard it.
 * `off` always returns null. `on` returns a line only for the final block;
 * `stream` returns a line per delta. The returned text is a placeholder, never
 * the reasoning content itself.
 */
export function renderThinking(input: ThinkingInput, level: ThinkingLevel): string | null {
  if (level === 'off') return null
  if (level === 'on' && input.kind !== 'block') return null
  return '🤔 Thinking…'
}
