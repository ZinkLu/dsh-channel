/**
 * Recovery policy: the decision layer over the delivery ledger at startup.
 *
 * Given the sweep of recoverable ledger entries, decide resend / skip / abandon.
 * Reconciliation is *not* a separate policy — `Channel.reconcile` is already the
 * seam (a capability fact with a graceful-absence default), so the policy consumes
 * the channel (structurally, to keep this module dependency-free) directly.
 *
 * The policy only *decides*; it never mutates the store. The bridge executes the
 * returned actions (looks up the text, resends, and marks the ledger accordingly).
 */

import type { SendErrorKind } from 'dsh-channel'

/** The full delivery-ledger state machine (shared with the store). */
export type DeliveryState = 'pending' | 'attempting' | 'delivered' | 'failed' | 'abandoned'

/** A ledger entry that `ChannelStore.sweepRecoverable()` returned for startup recovery. */
export interface RecoverableDelivery {
  key: string
  state: 'pending' | 'attempting' | 'failed'
  chatKey: string
  attempts?: number
  errorKind?: SendErrorKind
}

/** Minimal structural view of a Channel, just enough for reconciliation. */
export interface ReconcileLike {
  readonly supportsReconciliation: boolean
  reconcile(chatKey: string, deliveryKey: string, textHash: string): Promise<'confirmed-sent' | 'confirmed-absent' | 'unknown'>
}

export interface RecoveryContext {
  /** The provider, for `supportsReconciliation` + `reconcile()`. */
  readonly channel: ReconcileLike
  /** Look up the assistant text for a (sessionId, seq); '' when unavailable/empty. */
  readonly resolveText: (sessionId: string, seq: number) => string
}

export interface RecoveryPolicy {
  sweep(entries: readonly RecoverableDelivery[], ctx: RecoveryContext): Promise<RecoveryAction[]>
}

export type RecoveryAction =
  | { readonly kind: 'resend'; readonly item: RecoverableDelivery; readonly marker?: string; readonly text: string; readonly origin: { sessionId: string; seq: number } }
  | { readonly kind: 'skip'; readonly item: RecoverableDelivery; readonly reason: string }
  | { readonly kind: 'abandon'; readonly item: RecoverableDelivery; readonly reason: string }

/**
 * The default policy — a 1:1 extraction of the bridges' former `recoverDeliveries`:
 * unparseable key / unavailable event / empty text → abandon; reconcile
 * `confirmed-sent` → skip; otherwise → resend with a visible recovery marker.
 */
export const defaultRecoveryPolicy: RecoveryPolicy = {
  async sweep(entries, ctx) {
    const actions: RecoveryAction[] = []
    for (const item of entries) {
      // Never blind-resend a terminal platform rejection; those are abandoned on sight.
      if (isFatalSendError(item.errorKind)) {
        actions.push({ kind: 'abandon', item, reason: `recovery: terminal send error ${item.errorKind ?? ''}`.trim() })
        continue
      }
      const { sessionId, seq } = splitDeliveryKey(item.key)
      if (sessionId === undefined || seq === undefined) {
        actions.push({ kind: 'abandon', item, reason: `recovery: cannot parse delivery key ${item.key}` })
        continue
      }
      const text = ctx.resolveText(sessionId, seq)
      if (text === '') {
        actions.push({ kind: 'abandon', item, reason: `recovery: session event ${item.key} unavailable` })
        continue
      }
      // Reconciliation: consult the channel before a blind resend (graceful 'unknown' by default).
      if (item.state !== 'pending' && ctx.channel.supportsReconciliation) {
        try {
          const verdict = await ctx.channel.reconcile(item.chatKey, item.key, hashText(text))
          if (verdict === 'confirmed-sent') {
            actions.push({ kind: 'skip', item, reason: 'reconcile: confirmed-sent' })
            continue
          }
        } catch {
          // fall through to resend
        }
      }
      const marker = item.state === 'pending' ? '' : '(resumed resend, may duplicate)\n'
      actions.push({ kind: 'resend', item, marker, text, origin: { sessionId, seq } })
    }
    return actions
  },
}

/** Terminal send errors are never retried by the recovery policy. */
export function isFatalSendError(errorKind: SendErrorKind | undefined): boolean {
  return errorKind === 'too_long' || errorKind === 'bad_format' || errorKind === 'forbidden' || errorKind === 'not_found'
}

/**
 * Delivery-key grammar: `${sessionId}:${seq}`, plus `#${chunkIndex}` (1-based)
 * when one assistant message was split across several platform messages. `#` is
 * used rather than another `:` because sessionIds contain colons themselves
 * (`channel:telegram:42`), which would make the split ambiguous.
 */
export function chunkDeliveryKey(deliveryKey: string, chunkIndex: number): string {
  return `${deliveryKey}#${chunkIndex}`
}

/** The 1-based chunk index of a delivery key, or undefined when it names a whole message. */
export function chunkIndexOf(key: string): number | undefined {
  const match = /#(\d+)$/.exec(key)
  return match ? Number(match[1]) : undefined
}

/** Parse a delivery key back into the session event it came from. */
export function splitDeliveryKey(key: string): { sessionId?: string; seq?: number } {
  const base = key.replace(/#\d+$/, '')
  const sep = base.lastIndexOf(':')
  if (sep <= 0) return {}
  const seq = Number(base.slice(sep + 1))
  if (!Number.isInteger(seq)) return {}
  return { sessionId: base.slice(0, sep), seq }
}

/** djb2 text hash, used by the delivery ledger (textHash) and reconciliation. */
export function hashText(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}
