/**
 * Focus-presentation policy (§6.4): one chat can watch several sessions, and
 * streaming all of them would interleave unreadably. The rule set:
 *
 *   - the FOCUS session behaves exactly like the single-session past: full
 *     streaming, drafts, tool status lines, typing;
 *   - a WATCHED-but-not-focused session never streams; only manager
 *     notifications reach the chat, badged with the session's list number;
 *   - anything neither focused nor watched is silent.
 *
 * Approvals and questions are not outbox traffic: the broker delivers those
 * prompts to every `subscribersOf(sessionId, kind)` chat directly (first
 * answerer wins), so this policy stays silent for them.
 *
 * Pure and dependency-free, like every policy module.
 */
import type { NotificationKind } from 'dsh-session-manager'

export type FocusPresentation = 'stream' | 'deliver' | 'deliver-badged' | 'silent'

export interface FocusPresentationInput {
  /** Whether the notification's session is the chat's current focus. */
  readonly isFocused: boolean
  /** 'stream' asks about the session-event pipeline; the rest are outbox kinds. */
  readonly kind: 'stream' | NotificationKind
}

/** How one kind of traffic for one session reaches (or never reaches) a chat. */
export function resolveFocusPresentation(input: FocusPresentationInput): FocusPresentation {
  if (input.kind === 'stream') return input.isFocused ? 'stream' : 'silent'
  switch (input.kind) {
    case 'notify':
    case 'error':
      // Explicit user-facing text: delivered even to the focus chat (no badge —
      // the focus session's number is noise in its own conversation).
      return input.isFocused ? 'deliver' : 'deliver-badged'
    case 'turn-end':
      // The focus chat already lives the turn: streamed answer + the bridge's
      // own `⏹ Turn ended` line for non-completed reasons. A second summary
      // would be a duplicate.
      return input.isFocused ? 'silent' : 'deliver-badged'
    case 'approval':
    case 'question':
      // Broker-delivered prompts, never outbox traffic.
      return 'silent'
    default:
      return 'silent'
  }
}

/** The `[#2 docs sync]` badge prefix for a watched-but-not-focused session. */
export function sessionBadge(input: { number?: number; title?: string; sessionId: string }): string {
  const label = input.title !== undefined && input.title !== '' ? input.title : shortenSessionId(input.sessionId)
  return input.number !== undefined ? `[#${input.number} ${label}]` : `[${label}]`
}

/** Last-resort label when a session has no title: the trailing id segment. */
export function shortenSessionId(sessionId: string): string {
  const parts = sessionId.split(':')
  const tail = parts[parts.length - 1] ?? sessionId
  // Random uuids read better shortened; conventional ids keep their chat key.
  return tail.length > 12 ? `${tail.slice(0, 8)}…` : tail
}
