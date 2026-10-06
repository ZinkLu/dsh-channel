/**
 * Public vocabulary of `ctx.sessionManager`.
 *
 * The manager is a channel-agnostic dsh service (design ruling D1): it knows
 * sessions, tasks, subscriptions, and an ack'd notification outbox — never
 * chats, platforms, or channel packages. A `subscriberKey` is an opaque
 * string to the manager; the channel convention is
 * `channel:<id>[:<accountId>]:<chatKey>`.
 *
 * Persistence discipline (R7): the durable tables store *associations*
 * (managed-session rows, taskId → sessionId/turn links, subscriptions, the
 * outbox). Task state itself is folded from the session log's
 * `turn/start`/`turn/end` events; a restart rebuilds it by replay, and the
 * stored terminal fields are a presentation cache, not the truth.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionManager } from './manager.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionManager: SessionManager
  }
  interface Events {
    /**
     * One outbox notification became deliverable to a subscriber (created,
     * re-created on recovery, or a deferred `when:'done'` row released at the
     * idle edge). Observational: audit/policy plugins listen; delivery is the
     * subscriber's own concern via `SessionManager.onNotification`.
     * @mode emit
     */
    'manager/notification'(notification: ManagerNotification): void
    /**
     * A dispatch task changed state (queued → running → done/failed/crashed,
     * or steered/closed). Observational; the state is folded from the session
     * log, this event only mirrors the transitions.
     * @mode emit
     */
    'manager/task'(task: ManagerTask): void
  }
}

/** Notification kinds a subscription can filter on. */
export type NotificationKind = 'turn-end' | 'approval' | 'question' | 'notify' | 'error'

/** Every kind (the default subscription set for `watch:true` dispatches). */
export const ALL_NOTIFICATION_KINDS: readonly NotificationKind[] = ['turn-end', 'approval', 'question', 'notify', 'error']

/** A session this process's manager created or explicitly adopted. */
export interface ManagedSession {
  readonly sessionId: string
  /** Absolute working directory the session runs in (`header.cwd` is the authority once live). */
  readonly cwd?: string
  readonly workspaceId?: string
  /** Optional human label (the `/new blog` name, a chat-derived hint, …). */
  readonly label?: string
  /** subscriberKey of whoever created/adopted it. */
  readonly createdBy: string
  readonly createdAt: number
  /** Set when the session pre-existed and was adopted rather than created here. */
  readonly adoptedAt?: number
}

/** Lifecycle of one dispatch, folded from `turn/start`/`turn/end`. */
export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'crashed'

/** One dispatch: a message handed to a session, tracked until its turn closes. */
export interface ManagerTask {
  readonly taskId: string
  readonly sessionId: string
  /** Who dispatched it (subscriberKey). */
  readonly by: string
  /** How it entered the agent: an own turn (`followup`) or the running turn (`steer`). */
  readonly mode: 'followup' | 'steer'
  /** First ~80 chars of the dispatched text, for `/ls`-style displays. */
  readonly summary: string
  readonly dispatchedAt: number
  /** The turn this task owns (assigned on the first `turn/start` past the watermark). */
  readonly turn?: number
  readonly state: TaskState
  readonly endedAt?: number
  /** `turn/end.reason.kind` for a closed task; `'steered'` tasks close with their host turn. */
  readonly reason?: string
}

/** One subscriber's interest in one session. */
export interface ManagerSubscription {
  readonly subscriberKey: string
  readonly sessionId: string
  readonly kinds: readonly NotificationKind[]
}

/** One outbox record: durable until the subscriber acks it. */
export interface ManagerNotification {
  /** Monotonic within this manager store; the bridge's ledger key is `notify:<id>`. */
  readonly id: string
  readonly subscriberKey: string
  readonly sessionId: string
  readonly kind: NotificationKind
  readonly text: string
  readonly createdAt: number
  readonly state: 'pending' | 'acked'
  /**
   * A `notify(when:'done')` row before its idle edge: durable (survives a
   * crash) but not yet deliverable — `pending()` hides it and live handlers
   * see it only once the session settles (the flag clears and the outcome is
   * stamped into `text`).
   */
  readonly deferred?: boolean
}

/** A session as `list()` shows it: live state ⊕ cold records ⊕ manager tables ⊕ projections. */
export interface SessionView {
  readonly sessionId: string
  readonly cwd?: string
  readonly workspaceId?: string
  readonly title?: string
  readonly label?: string
  /** The agent is live and inside a turn. */
  readonly running: boolean
  /** No user message has ever entered the log. */
  readonly blank: boolean
  /** Epoch ms of the best-known last activity (live log tail, else header.createdAt). */
  readonly updatedAt: number
  /** Registered in this manager's table (created or adopted here). */
  readonly managed: boolean
  /** Only ever seen in persistence; possibly another process's session. */
  readonly foreign: boolean
  readonly activeTask?: ManagerTask
  readonly pendingInteraction?: 'approval' | 'question'
  /** Number of distinct subscriberKeys watching this session. */
  readonly watchers: number
  /** Queued inbox items (`nextTurn + nextStep`), when the agent is live. */
  readonly queued?: number
  /** The last `turn/end` reason kind, when known. */
  readonly lastReason?: string
}

export interface SessionDetail extends SessionView {
  /** Most recent tasks first. */
  readonly tasks: readonly ManagerTask[]
  readonly todos?: readonly unknown[]
  readonly stats?: unknown
  /** Name of the tool call with no paired result yet (live sessions only). */
  readonly currentTool?: string
  readonly lastAssistantText?: string
  readonly lastError?: string
}

/** A workspace as `workspaces()` shows it (registry rows, or cwd-derived groups). */
export interface WorkspaceView {
  readonly id: string
  readonly title: string
  readonly path?: string
  readonly sessionCount: number
}

/** Options for `SessionManager.create()`. */
export interface CreateSessionOptions {
  /** Absolute working directory; falls back to the manager config, then `process.cwd()`. */
  readonly cwd?: string
  readonly workspaceId?: string
  readonly agentPreset?: string
  readonly agentOptions?: AgentOptions
  readonly label?: string
  /** subscriberKey of the creator. */
  readonly by: string
  /** Caller setup hook, composed AFTER the manager's own per-agent setup. */
  readonly setup?: AgentSetup
}

/** Options for `SessionManager.adopt()`. */
export interface AdoptSessionOptions {
  readonly agentPreset?: string
  readonly agentOptions?: AgentOptions
  readonly cwd?: string
  readonly label?: string
  readonly setup?: AgentSetup
  /**
   * Whether a session absent from both the live registry and persistence may
   * be created under this exact id (the bridge's conventional first message).
   * Default false: adopting an unknown id then fails instead of creating.
   */
  readonly createIfMissing?: boolean
}

/** Options for `SessionManager.dispatch()`. */
export interface DispatchOptions {
  readonly sessionId: SessionId | string
  readonly message: UserMessage
  /** `'auto'` (default): idle → followup, running → steer. */
  readonly mode?: 'auto' | 'followup' | 'steer'
  readonly by: string
  /** Subscribe `by` to all notification kinds for this session (default false). */
  readonly watch?: boolean
}

/** Minimal structural view of the agent surface the manager drives. */
export interface AgentLike {
  readonly id: SessionId
  readonly status: string
  readonly session: {
    readonly header?: { readonly cwd?: string; readonly agentPreset?: string; readonly createdAt?: number }
    snapshotEvents(): readonly { type: string; seq: number; time?: number; data?: unknown }[]
  }
  readonly inbox?: { readonly nextTurn?: readonly unknown[]; readonly nextStep?: readonly unknown[] }
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  cancel?(cause: unknown, options?: unknown): void
}

export type { SessionManager }
