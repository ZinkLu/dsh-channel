/**
 * Outbound echo suppression (openclaw `outbound-echo.ts`): remember the
 * platform message ids of our own sends for a short TTL, and drop inbound
 * messages that match. This is for platforms without a reliable bot flag
 * (WeChat personal accounts) where the platform replays the bot's own sends
 * through the inbound path and would otherwise self-loop.
 */

export interface OutboundEchoEntry {
  readonly channel: string
  readonly accountId: string
  readonly chatKey: string
  readonly messageId: string
  readonly expiresAt: number
}

export interface OutboundEchoState {
  readonly entries: readonly OutboundEchoEntry[]
}

export const emptyOutboundEchoState: OutboundEchoState = { entries: [] }

export type OutboundEchoInput =
  | { readonly kind: 'sent'; readonly channel: string; readonly accountId?: string; readonly chatKey: string; readonly messageId: string; readonly now: number }
  | { readonly kind: 'inbound'; readonly channel: string; readonly accountId?: string; readonly chatKey: string; readonly messageId: string; readonly now: number }
  | { readonly kind: 'tick'; readonly now: number }

export interface OutboundEchoResult {
  readonly state: OutboundEchoState
  /** True when an inbound message matches one of our own recent sends. */
  readonly matches: boolean
}

export interface OutboundEchoOptions {
  /** TTL for own-send memory; default 30_000ms. */
  ttlMs?: number
  /** Bounded map cap; default 1000. */
  maxEntries?: number
}

export function outboundEchoReduce(
  state: OutboundEchoState,
  input: OutboundEchoInput,
  opts: OutboundEchoOptions = {},
): OutboundEchoResult {
  const ttlMs = opts.ttlMs ?? 30_000
  const maxEntries = opts.maxEntries ?? 1000
  const now = input.kind === 'tick' ? input.now : input.now
  const prunedEntries = state.entries.filter((entry) => entry.expiresAt > now)

  if (input.kind === 'sent') {
    if (input.messageId === '') return { state: { entries: prunedEntries }, matches: false }
    const entry: OutboundEchoEntry = {
      channel: input.channel,
      accountId: input.accountId ?? 'default',
      chatKey: input.chatKey,
      messageId: input.messageId,
      expiresAt: now + ttlMs,
    }
    const deduped = prunedEntries.filter(
      (e) => !(e.channel === entry.channel && e.accountId === entry.accountId && e.chatKey === entry.chatKey && e.messageId === entry.messageId),
    )
    const entries = [...deduped, entry]
    return { state: { entries: entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries }, matches: false }
  }

  if (input.kind === 'inbound') {
    if (input.messageId === '') return { state: { entries: prunedEntries }, matches: false }
    const accountId = input.accountId ?? 'default'
    const matches = prunedEntries.some(
      (entry) =>
        entry.channel === input.channel &&
        entry.accountId === accountId &&
        entry.chatKey === input.chatKey &&
        entry.messageId === input.messageId,
    )
    return { state: { entries: prunedEntries }, matches }
  }

  return { state: { entries: prunedEntries }, matches: false }
}
