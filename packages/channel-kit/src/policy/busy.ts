/**
 * Busy-turn policy: what to do with an inbound message while the resolved
 * session is already running a turn.
 *
 * This is deliberately one pure decision function, not a third policy seam:
 * `dispatchText` calls it and then either steers, queues behind the running
 * turn, or follows up (when the session is actually idle). The day-one rule is
 * the fallback chain — if steer is unavailable or fails, the message is
 * buffered, never dropped.
 */

export type BusyAction = 'steer' | 'queue' | 'followup'

export interface BusyActionCaps {
  /** The agent can accept a mid-turn steer. */
  readonly supportsSteer: boolean
  /** The bridge can buffer the message behind the running turn (turn-end flush). */
  readonly supportsQueue?: boolean
}

export type BusyAgentStatus = 'idle' | 'running' | 'completed' | 'failed' | 'stopped' | (string & {})

export type BusyMessageKind = 'text' | 'media' | 'command'

/**
 * @param agentStatus the resolved agent's status (`agent.status`).
 * @param messageKind the inbound message kind.
 * @param caps capability gates for the fallback chain.
 */
export function resolveBusyAction(
  agentStatus: BusyAgentStatus,
  messageKind: BusyMessageKind,
  caps: BusyActionCaps = { supportsSteer: true, supportsQueue: true },
): BusyAction {
  // Commands and media are never queued behind a running turn in the current
  // bridge: commands already flush before dispatch and media bypasses the merge
  // layer. (A future capability-gated tier can add them here.)
  if (messageKind === 'command' || messageKind === 'media') {
    return agentStatus === 'running' && caps.supportsSteer ? 'steer' : 'followup'
  }
  if (agentStatus !== 'running') return 'followup'
  if (caps.supportsSteer) return 'steer'
  if (caps.supportsQueue ?? true) return 'queue'
  return 'followup'
}
