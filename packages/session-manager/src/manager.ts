/**
 * SessionManager: the channel-agnostic session layer (`ctx.sessionManager`).
 *
 * Replaces the "one IM chat ↔ one agent session" glue with "any subscriber ↔
 * every session of this process". Three jobs, per the design proposal:
 *
 *   N1 query    — `list()`/`describe()` fold `ctx.agents` live state, cold
 *                 `sessionQuery` records, the manager's own tables, and (when
 *                 composed) projection snapshots into `SessionView`s.
 *   N2 dispatch — `create`/`adopt`/`dispatch`/`cancel`; one dispatch is a Task
 *                 whose state is FOLDED from the session log's turn/start and
 *                 turn/end events (R7: the tables store associations, not truth).
 *   N3 notify   — `watch` subscriptions plus a durable ack'd outbox. The
 *                 notification edge is `agent/status → 'idle'`, NOT `turn/end`,
 *                 so a followup chain pushes once when the session settles.
 *
 * Dependency discipline (D1/R2/R3): required peers are `agents` (+ `sessions`
 * for load order); `sessionQuery`/`workspaceRegistry`/`agentPresets`/
 * `sessionProjections`/`sessionPersistence`/`storageDomain`/`tools` are all
 * optional and duck-typed through `ctx.get` — this package imports no channel
 * package and no optional dsh package.
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionManagerConfig } from './config.js'
import { createMemoryManagerStore, type ManagerStore } from './store.js'
import { openDomainManagerStore, type DomainFacilityLike } from './store/domain.js'
import { createJsonFileManagerStore } from './store/json-file.js'
import {
  ALL_NOTIFICATION_KINDS,
  type AdoptSessionOptions,
  type CreateSessionOptions,
  type DispatchOptions,
  type ManagedSession,
  type ManagerNotification,
  type ManagerTask,
  type NotificationKind,
  type SessionDetail,
  type SessionView,
  type WorkspaceView,
} from './types.js'
import { notifyUserTool, type NotifyToolHost } from './notify-tool.js'

// ---- duck types for the optional dsh services (never imported) ----

interface SessionRecordLike {
  header?: { id?: string; cwd?: string; createdAt?: number }
  live?: boolean
  persisted?: boolean
}
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<SessionRecordLike[]>
}
interface WorkspaceLike {
  id: string
  path: string
  title: string
  sessionIds?: readonly string[]
}
interface WorkspaceRegistryLike {
  list(): WorkspaceLike[]
  resolveByPath?(path: string): Promise<WorkspaceLike | undefined>
}
interface SessionProjectionsLike {
  snapshot(session: Session, keys?: readonly string[]): { values: Record<string, unknown> }
}
interface AgentPresetsLike {
  resolve: (id?: string) => Promise<{ id: string }>
  mount: (agentCtx: Context, id?: string) => Promise<unknown>
}
interface SessionPersistenceLike {
  stat: (id: SessionId) => Promise<unknown>
}
interface ToolRuntimeLike {
  register(definition: unknown): () => void
}

/** Per-session live fold state; created only for sessions the manager has a reason to follow. */
interface SessionTracking {
  /** callId → tool name for calls with no paired result (the `currentTool` source). */
  toolCalls: Map<string, string>
  lastAssistantText?: string
  lastError?: string
  currentTurn?: number
  lastTurnEnd?: { turn: number; reason: string; at: number; notified: boolean }
  pendingInteraction?: 'approval' | 'question'
}

/** Tasks keep their dispatch watermark in memory only; a restart folds open tasks to `crashed`. */
type Watermarks = Map<string, number>

const SUMMARY_CHARS = 80
const NOTIFY_TEXT_CHARS = 300

/** Resolve the JSON fallback store path (only used when `ctx.storageDomain` is absent). */
export function resolveManagerStatePath(config: SessionManagerConfig): string {
  if (config.statePath) return config.statePath
  const base = process.env.DSH_HOME ?? resolve(homedir(), '.dsh')
  return resolve(base, 'session-manager', 'state.json')
}

export class SessionManager extends Service implements NotifyToolHost {
  private readonly config: SessionManagerConfig
  private readonly injectedStore: ManagerStore | undefined
  private store: ManagerStore

  /** Owned agent handles — `ctx.agents.get()` returns bare agents; only the creator can dispose. */
  private readonly handles = new Map<string, AgentHandle>()
  private readonly tracking = new Map<string, SessionTracking>()
  private readonly watermarks: Watermarks = new Map()
  private readonly notificationHandlers = new Map<string, Set<(notification: ManagerNotification) => void>>()
  private readonly ensureChains = new Map<string, Promise<void>>()
  private readonly disposers: Array<() => void> = []
  private started = false
  private stopped = false
  private startPromise: Promise<void> | undefined

  /**
   * @param store test seam: an explicit store skips the domain/JSON resolution
   *   in `start()` (production callers always let the manager choose).
   */
  constructor(ctx: Context, config: SessionManagerConfig = {}, store?: ManagerStore) {
    super(ctx, 'sessionManager')
    this.config = config
    this.injectedStore = store
    this.store = store ?? createMemoryManagerStore()
  }

  // ---- lifecycle ----

  /**
   * Open the durable store (storage domain when composed, else the JSON file),
   * install the root listeners and the global `notify_user` tool, and fold the
   * previous process's open tasks (R7 restart rebuild). Registered inside
   * `ctx.effect` by the plugin entry, so unload reverses all of it (R1).
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.startPromise = this.doStart()
    await this.startPromise
  }

  /**
   * Resolves once `start()` finished opening the durable store and installing
   * the listeners/tool — consumers loaded in parallel (a channel bridge) await
   * this before their first manager call instead of racing the plugin order.
   * Resolves immediately when the manager was never started.
   */
  ready(): Promise<void> {
    return this.startPromise ?? Promise.resolve()
  }

  private async doStart(): Promise<void> {
    await this.openStore()
    this.rebuildOpenTasks()

    // Deferred notify rows from the previous process still wait for their
    // idle edge: follow those sessions so the edge can actually release them.
    for (const row of this.store.listOutbox('pending')) {
      if (row.deferred === true) this.trackingFor(row.sessionId)
    }

    // Root listeners see every agent of the process, including ones the web UI
    // opened (dsh-scope: events flow upward) — that is exactly the point (V3).
    this.disposers.push(this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.onSessionEvent(session, event)
    }))
    this.disposers.push(this.ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: string }) => {
      if (status === 'idle') this.onAgentIdle(String(agent.id))
    }))
    this.disposers.push(this.observeInteraction('approval/request', 'approval'))
    this.disposers.push(this.observeInteraction('user-questions/request', 'question'))

    const tools = this.ctx.get('tools') as ToolRuntimeLike | undefined
    if (tools !== undefined && typeof tools.register === 'function') {
      try {
        this.disposers.push(tools.register(notifyUserTool(this)))
      } catch (error) {
        this.warn(`notify_user could not be registered globally: ${errorMessage(error)}`)
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopped) return
    this.stopped = true
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // Listener/tool disposer errors must not block teardown.
      }
    }
    this.notificationHandlers.clear()
    for (const [sessionId, handle] of [...this.handles]) {
      try {
        await handle.dispose()
      } catch {
        // The agent may already have been released by another fiber.
      }
      this.handles.delete(sessionId)
    }
    try {
      await this.store.close()
    } catch (error) {
      this.warn(`store close failed: ${errorMessage(error)}`)
    }
  }

  /** Domain store when the host composes one; JSON file otherwise. Pre-start calls use the memory tables. */
  private async openStore(): Promise<void> {
    if (this.injectedStore !== undefined) return
    const facility = this.ctx.get('storageDomain') as DomainFacilityLike | undefined
    const domain = await openDomainManagerStore(facility, {
      onWriteError: (message) => this.warn(message),
    })
    const next = domain ?? createJsonFileManagerStore(resolveManagerStatePath(this.config))
    // Copy forward anything a pre-start call wrote into the provisional memory tables.
    const provisional = this.store
    if (provisional !== next) {
      for (const row of provisional.listSessions()) if (next.getSession(row.sessionId) === undefined) next.putSession(row)
      for (const row of provisional.listTasks()) if (next.getTask(row.taskId) === undefined) next.putTask(row)
      for (const row of provisional.listSubscriptions()) next.putSubscription(row)
      for (const row of provisional.listOutbox()) next.putNotification(row)
    }
    this.store = next
  }

  // ---- N1: queries ----

  /**
   * Every session this process can see: live agents ⊕ cold persistence records
   * (when `sessionQuery` is composed) ⊕ the manager's own table ⊕ projection
   * titles. Without `sessionQuery` this lists managed + live sessions only.
   */
  async list(opts: { workspaceId?: string; includeForeign?: boolean } = {}): Promise<SessionView[]> {
    const includeForeign = opts.includeForeign ?? true
    const live = this.safeAgentsList()
    const records = await this.sessionRecords()
    const managedRows = new Map(this.store.listSessions().map((row) => [row.sessionId, row]))
    const workspaces = this.workspaceRows()

    const ids = new Set<string>()
    for (const agent of live) ids.add(String(agent.id))
    for (const row of managedRows.keys()) ids.add(row)
    for (const record of records) {
      const id = record.header?.id
      if (id !== undefined && id !== '') ids.add(String(id))
    }

    const views: SessionView[] = []
    for (const id of ids) {
      const agent = live.find((candidate) => String(candidate.id) === id)
      const record = records.find((candidate) => String(candidate.header?.id ?? '') === id)
      const managed = managedRows.get(id)
      const foreign = managed === undefined && record?.persisted === true && record?.live !== true && agent === undefined
      if (foreign && !includeForeign) continue
      views.push(this.buildView(id, agent, record, managed, workspaces))
    }
    views.sort((a, b) => Number(b.running) - Number(a.running) || b.updatedAt - a.updatedAt)
    return views
  }

  /** One session in full: the view plus its task history, projections, and live fold state. */
  async describe(sessionId: SessionId | string): Promise<SessionDetail> {
    const id = String(sessionId)
    const [view] = (await this.list({ includeForeign: true })).filter((candidate) => candidate.sessionId === id)
    const agent = this.ctx.agents.get(SessionId(id))
    const tasks = this.store
      .listTasks(id)
      .sort((a, b) => b.dispatchedAt - a.dispatchedAt || Number(b.taskId) - Number(a.taskId))
      .slice(0, 20)

    const projection = agent !== undefined ? this.projectionValues(agent.session) : undefined
    const tracking = this.tracking.get(id)
    const derived = tracking !== undefined ? tracking : agent !== undefined ? deriveFromLog(agent.session) : undefined

    const currentTool = lastOpenToolCall(derived?.toolCalls)
    const base: SessionDetail = {
      ...(view ?? this.buildView(id, agent, undefined, this.store.getSession(id), this.workspaceRows())),
      tasks,
      ...(currentTool !== undefined ? { currentTool } : {}),
      ...(derived?.lastAssistantText !== undefined ? { lastAssistantText: derived.lastAssistantText } : {}),
      ...(derived?.lastError !== undefined ? { lastError: derived.lastError } : {}),
    }
    const todos = projectionTodos(projection)
    const stats = projection?.sessionStats
    return {
      ...base,
      ...(todos !== undefined ? { todos } : {}),
      ...(stats !== undefined ? { stats } : {}),
    }
  }

  /** Workspace rows: the registry's when composed, else cwd-derived groups over visible sessions. */
  workspaces(): WorkspaceView[] {
    const rows = this.workspaceRows()
    return rows.map((row) => ({ id: row.id, title: row.title, ...(row.path !== undefined ? { path: row.path } : {}), sessionCount: row.sessionCount }))
  }

  // ---- N2: session lifecycle and dispatch ----

  /**
   * Create a fresh managed session under a random id (the web-UI convention —
   * the `channel:<id>:<chatKey>` grammar stays reserved for per-chat defaults).
   * The whole resume-before-create/preset flow that used to live in the bridge
   * lives here now; the caller's `setup` composes AFTER the manager's own.
   */
  async create(opts: CreateSessionOptions): Promise<ManagedSession> {
    const cwd = this.resolveCwd(opts.cwd)
    const sessionId = SessionId(randomUUID())
    const agentPreset = await this.resolvePresetId(opts.agentPreset)
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd, ...(agentPreset !== undefined ? { agentPreset } : {}) },
      agentOptions: this.agentOptionsFor(opts.agentOptions),
      setup: this.composeSetup(opts.setup),
    })
    const id = String(sessionId)
    this.handles.set(id, handle)
    const workspaceId = opts.workspaceId ?? (await this.resolveWorkspaceId(cwd))
    const row: ManagedSession = {
      sessionId: id,
      cwd,
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(opts.label !== undefined && opts.label !== '' ? { label: opts.label } : {}),
      createdBy: opts.by,
      createdAt: Date.now(),
    }
    this.store.putSession(row)
    this.trackingFor(id)
    return row
  }

  /**
   * Register an existing (or absent, with `createIfMissing`) session as managed.
   * Resolution ladder per §5.2: live → `agents.get`; persisted → `resume`;
   * neither → create under this exact id only when the caller opted in. A
   * resume that throws is a REAL failure (owned elsewhere, broken log) and
   * propagates verbatim — never a silent re-create.
   */
  async adopt(sessionId: SessionId | string, by: string, opts: AdoptSessionOptions = {}): Promise<ManagedSession> {
    const id = String(sessionId)
    return this.withSessionLock(id, async () => {
      const agent = await this.ensureLiveAgent(id, opts)
      const existing = this.store.getSession(id)
      if (existing !== undefined) {
        if (agent !== undefined) this.trackingFor(id)
        return existing
      }
      const cwd = agent?.session.header?.cwd ?? (opts.cwd !== undefined ? this.resolveCwd(opts.cwd) : undefined) ?? this.resolveCwd(this.config.cwd)
      const workspaceId = await this.resolveWorkspaceId(cwd)
      const now = Date.now()
      const row: ManagedSession = {
        sessionId: id,
        ...(cwd !== '' ? { cwd } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(opts.label !== undefined && opts.label !== '' ? { label: opts.label } : {}),
        createdBy: by,
        createdAt: agent?.session.header?.createdAt ?? now,
        adoptedAt: now,
      }
      this.store.putSession(row)
      this.trackingFor(id)
      return row
    })
  }

  /**
   * Hand one message to a live session as a tracked Task. `mode:'auto'` is the
   * busy policy's day-one rule: idle → followup (an own turn), running → steer
   * (joins the open turn and closes with it). The task ↔ turn association is
   * made by the log: the first `turn/start` past the dispatch watermark owns it.
   * @throws when the session has no live agent (adopt/create it first).
   */
  async dispatch(opts: DispatchOptions): Promise<ManagerTask> {
    const id = String(opts.sessionId)
    const agent = this.ctx.agents.get(SessionId(id))
    if (agent === undefined) throw new Error(`session ${id} has no live agent; adopt or create it first`)

    const requested = opts.mode ?? 'auto'
    const mode: 'followup' | 'steer' = requested === 'auto' ? (agent.status === 'running' ? 'steer' : 'followup') : requested
    const tracking = this.trackingFor(id)

    let task: ManagerTask = {
      taskId: this.store.nextId(),
      sessionId: id,
      by: opts.by,
      mode,
      summary: summarizeMessage(opts.message),
      dispatchedAt: Date.now(),
      state: 'queued',
    }
    if (mode === 'steer' && tracking.currentTurn !== undefined) {
      // Joins the open turn; closes with it.
      task = { ...task, turn: tracking.currentTurn, state: 'running' }
    }
    this.watermarks.set(task.taskId, Number(agent.session.seq))
    this.store.putTask(task)
    this.emitTask(task)

    if (opts.watch) this.watch(opts.by, id)

    if (mode === 'steer') agent.steer(opts.message)
    else agent.followup(opts.message)
    return task
  }

  /** Cancel the live agent's current activity. Idempotent; a cold session is a no-op. */
  async cancel(sessionId: SessionId | string, cause?: string): Promise<void> {
    const id = String(sessionId)
    const agent = this.ctx.agents.get(SessionId(id))
    if (agent === undefined) return
    agent.cancel(cause !== undefined ? { kind: 'hook', reason: cause } : { kind: 'user' })
  }

  // ---- N3: subscriptions and the outbox ----

  /**
   * Subscribe to a session's notifications. The disposer removes exactly the
   * kinds THIS call added (kinds a concurrent watch already held stay), and
   * the row is deleted only when no kinds remain — order-insensitive, so
   * non-LIFO disposal cannot corrupt the subscription.
   */
  watch(subscriberKey: string, sessionId: SessionId | string, kinds: readonly NotificationKind[] = ALL_NOTIFICATION_KINDS): () => void {
    const id = String(sessionId)
    const previous = this.findSubscription(subscriberKey, id)
    const added = kinds.filter((kind) => previous === undefined || !previous.kinds.includes(kind))
    const merged = previous !== undefined ? unionKinds(previous.kinds, kinds) : [...kinds]
    this.store.putSubscription({ subscriberKey, sessionId: id, kinds: merged })
    this.trackingFor(id)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const current = this.findSubscription(subscriberKey, id)
      if (current === undefined) return
      const remaining = current.kinds.filter((kind) => !added.includes(kind))
      if (remaining.length === current.kinds.length) return
      if (remaining.length === 0) this.store.deleteSubscription(subscriberKey, id)
      else this.store.putSubscription({ subscriberKey, sessionId: id, kinds: remaining })
    }
  }

  /** Drop one subscription, or every subscription of a subscriber (the dead-target cleanup of §7). */
  unwatch(subscriberKey: string, sessionId?: SessionId | string): void {
    this.store.deleteSubscription(subscriberKey, sessionId === undefined ? undefined : String(sessionId))
  }

  /** Distinct subscriber keys watching a session, optionally filtered to one kind. */
  subscribersOf(sessionId: SessionId | string, kind?: NotificationKind): string[] {
    const id = String(sessionId)
    const keys: string[] = []
    for (const row of this.store.listSubscriptions()) {
      if (row.sessionId !== id) continue
      if (kind !== undefined && !row.kinds.includes(kind)) continue
      if (!keys.includes(row.subscriberKey)) keys.push(row.subscriberKey)
    }
    return keys
  }

  /**
   * Queue a notification for a session's watchers. `when:'done'` writes the
   * outbox rows immediately as deferred — durable across a crash, since the
   * notify_user tool has already reported success — and releases them to
   * handlers at the idle edge with the outcome attached; `when:'now'` fans
   * out at once. Returns the number of CURRENT targets: a snapshot, not a
   * delivery promise — subscribers added later never see this text, and a
   * deferred row delivers only if the session still settles (0 = nobody
   * watches and no default subscriber applies).
   */
  async notify(sessionId: SessionId | string, text: string, opts: { when?: 'now' | 'done'; kind?: NotificationKind } = {}): Promise<number> {
    const id = String(sessionId)
    const kind = opts.kind ?? 'notify'
    if ((opts.when ?? 'now') === 'done') {
      const targets = this.notifyTargets(id, kind)
      if (targets.length === 0) return 0
      const createdAt = Date.now()
      for (const subscriberKey of targets) {
        this.store.putNotification({
          id: this.store.nextId(),
          subscriberKey,
          sessionId: id,
          kind,
          text,
          createdAt,
          state: 'pending',
          deferred: true,
        })
      }
      // The idle edge releases the rows — make sure this process observes it.
      this.trackingFor(id)
      return targets.length
    }
    return this.fanout(id, kind, text)
  }

  /** Live delivery hook: handlers for subscriber keys starting with `prefix` (a bridge's whole account). */
  onNotification(subscriberPrefix: string, handler: (notification: ManagerNotification) => void): () => void {
    let set = this.notificationHandlers.get(subscriberPrefix)
    if (set === undefined) {
      set = new Set()
      this.notificationHandlers.set(subscriberPrefix, set)
    }
    set.add(handler)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      set?.delete(handler)
    }
  }

  /**
   * Un-acked outbox rows for a subscriber prefix, oldest first (the restart
   * re-delivery source). Deferred rows (a `notify(when:'done')` before its
   * idle edge) are not deliverable yet and stay invisible here.
   */
  pending(subscriberPrefix: string): ManagerNotification[] {
    return this.store
      .listOutbox('pending')
      .filter((row) => row.deferred !== true && row.subscriberKey.startsWith(subscriberPrefix))
      .sort((a, b) => Number(a.id) - Number(b.id) || a.createdAt - b.createdAt)
  }

  /** Mark one outbox row delivered. Unknown or already-acked ids are no-ops. */
  ack(id: string): void {
    const row = this.store.listOutbox('pending').find((candidate) => candidate.id === id)
    if (row === undefined) return
    this.store.putNotification({ ...row, state: 'acked' })
  }

  // ---- event folding (tasks, notifications, interaction state) ----

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const id = String(session.id)
    const tracking = this.tracking.get(id)
    if (tracking === undefined) return
    const data = event.data as Record<string, unknown> | undefined

    switch (event.type) {
      case 'turn/start':
        this.onTurnStart(id, tracking, Number(data?.turn ?? 0), Number(event.seq))
        break
      case 'turn/end':
        this.onTurnEnd(id, tracking, Number(data?.turn ?? 0), data?.reason as { kind?: string; error?: { message?: string } } | undefined, event.time ?? Date.now())
        break
      case 'assistant/message':
        tracking.lastAssistantText = messageText((data?.message as { content?: unknown })?.content)
        break
      case 'tool/call':
        tracking.toolCalls.set(String(data?.callId ?? ''), String(data?.name ?? ''))
        break
      case 'tool/result': {
        const message = data?.message as { toolCallId?: string; source?: { callId?: string } } | undefined
        const callId = String(message?.toolCallId ?? message?.source?.callId ?? '')
        if (callId !== '') tracking.toolCalls.delete(callId)
        break
      }
      default:
        break
    }
  }

  /** Bind the oldest queued task whose watermark this `turn/start` reached (one task per turn). */
  private onTurnStart(sessionId: string, tracking: SessionTracking, turn: number, seq: number): void {
    tracking.currentTurn = turn
    const candidate = this.store
      .listTasks(sessionId)
      .filter((task) => task.state === 'queued' && (this.watermarks.get(task.taskId) ?? Number.MAX_SAFE_INTEGER) <= seq)
      .sort((a, b) => a.dispatchedAt - b.dispatchedAt || Number(a.taskId) - Number(b.taskId))[0]
    if (candidate !== undefined) {
      this.watermarks.delete(candidate.taskId)
      this.transitionTask(candidate, { turn, state: 'running' })
    }
  }

  private onTurnEnd(
    sessionId: string,
    tracking: SessionTracking,
    turn: number,
    reason: { kind?: string; error?: { message?: string } } | undefined,
    at: number,
  ): void {
    const kind = reason?.kind ?? 'completed'
    tracking.currentTurn = undefined
    tracking.lastTurnEnd = { turn, reason: kind, at, notified: false }
    if (kind === 'error') {
      tracking.lastError = reason?.error?.message ?? 'turn failed'
    }
    for (const task of this.store.listTasks(sessionId)) {
      if (task.turn !== turn) continue
      if (task.state !== 'running' && task.state !== 'queued') continue
      const state = kind === 'interrupted' ? 'crashed' : kind === 'error' ? 'failed' : 'done'
      this.transitionTask(task, { state, reason: kind, endedAt: at })
    }
    if (kind === 'error') {
      // Errors do not wait for the idle edge: the user should hear about a
      // failed turn while the session may already be retrying.
      this.fanout(sessionId, 'error', `⚠️ ${tracking.lastError ?? 'turn failed'}`)
    }
  }

  /**
   * The idle edge is THE notification edge (§5.2): one turn-end summary for
   * everything that ran since the last idle, then any deferred notify_user
   * texts with the outcome attached. Orphaned queued tasks (their inbox work
   * was canceled away) fail here instead of lingering forever.
   */
  private onAgentIdle(sessionId: string): void {
    const tracking = this.tracking.get(sessionId)
    if (tracking === undefined) return

    for (const task of this.store.listTasks(sessionId)) {
      if (task.state === 'queued') this.transitionTask(task, { state: 'failed', reason: 'canceled', endedAt: Date.now() })
    }

    const ended = tracking.lastTurnEnd
    if (ended !== undefined && !ended.notified) {
      ended.notified = true
      this.fanout(sessionId, 'turn-end', turnEndSummary(ended.reason, tracking.lastAssistantText))
    }
    this.releaseDeferred(sessionId, ended)
    if (tracking.pendingInteraction !== undefined) tracking.pendingInteraction = undefined
    this.pruneTracking(sessionId, tracking)
  }

  /**
   * Release this session's deferred notify rows (the notify_user when:'done'
   * contract): stamp the outcome into the text, then each row is an ordinary
   * pending row — emitted, handed to live handlers, and re-delivered by the
   * subscriber's restart path if the process dies before the ack.
   */
  private releaseDeferred(sessionId: string, ended: SessionTracking['lastTurnEnd']): void {
    const rows = this.store
      .listOutbox('pending')
      .filter((row) => row.deferred === true && row.sessionId === sessionId)
      .sort((a, b) => Number(a.id) - Number(b.id))
    for (const row of rows) {
      const outcome = ended !== undefined ? ` · ${ended.reason}` : ''
      const released: ManagerNotification = {
        id: row.id,
        subscriberKey: row.subscriberKey,
        sessionId: row.sessionId,
        kind: row.kind,
        text: `${row.text}${outcome}`,
        createdAt: row.createdAt,
        state: 'pending',
      }
      this.store.putNotification(released)
      this.emitNotification(released)
      this.dispatchToHandlers(released)
    }
  }

  /** Observe one interaction waterfall purely: always `next()`, never answer (R8). */
  private observeInteraction(event: 'approval/request' | 'user-questions/request', kind: 'approval' | 'question'): () => void {
    const listener = async (request: unknown, next: () => Promise<unknown>): Promise<unknown> => {
      const agentId = (request as { agent?: { id?: string } } | undefined)?.agent?.id
      const sessionId = agentId !== undefined ? String(agentId) : undefined
      const tracking = sessionId !== undefined ? this.tracking.get(sessionId) : undefined
      if (tracking !== undefined && tracking.pendingInteraction === undefined) tracking.pendingInteraction = kind
      try {
        return await next()
      } finally {
        if (tracking !== undefined && tracking.pendingInteraction === kind) tracking.pendingInteraction = undefined
      }
    }
    // The event declarations belong to dsh-user-approval / dsh-user-questions
    // (both optional peers); registering through a local cast keeps this
    // package's program free of foreign Events augmentations.
    const on = this.ctx.on as unknown as (event: string, listener: (request: unknown, next: () => Promise<unknown>) => Promise<unknown>) => () => void
    return on(event, listener)
  }

  // ---- outbox internals ----

  /** Who a `kind` reaches: the session's own watchers, else (notify/error only) the configured defaults. */
  private notifyTargets(sessionId: string, kind: NotificationKind): string[] {
    const watchers = this.subscribersOf(sessionId, kind)
    if (watchers.length > 0) return watchers
    if (kind !== 'notify' && kind !== 'error') return []
    return [...(this.config.defaultSubscribers ?? [])]
  }

  /**
   * Write one durable outbox row per target, THEN emit and hand to live
   * handlers: a crash between the write and the delivery leaves the row
   * `pending`, and the subscriber's restart path re-delivers it (at-least-once).
   */
  private fanout(sessionId: string, kind: NotificationKind, text: string): number {
    const targets = this.notifyTargets(sessionId, kind)
    if (targets.length === 0) return 0
    const createdAt = Date.now()
    const rows: ManagerNotification[] = []
    for (const subscriberKey of targets) {
      const row: ManagerNotification = {
        id: this.store.nextId(),
        subscriberKey,
        sessionId,
        kind,
        text,
        createdAt,
        state: 'pending',
      }
      this.store.putNotification(row)
      rows.push(row)
    }
    for (const row of rows) {
      this.emitNotification(row)
      this.dispatchToHandlers(row)
    }
    return rows.length
  }

  private emitNotification(notification: ManagerNotification): void {
    try {
      this.ctx.emit('manager/notification', notification)
    } catch (error) {
      this.warn(`manager/notification listener failed: ${errorMessage(error)}`)
    }
  }

  private dispatchToHandlers(notification: ManagerNotification): void {
    for (const [prefix, handlers] of this.notificationHandlers) {
      if (!notification.subscriberKey.startsWith(prefix)) continue
      for (const handler of handlers) {
        try {
          handler(notification)
        } catch (error) {
          this.warn(`notification handler failed: ${errorMessage(error)}`)
        }
      }
    }
  }

  private transitionTask(task: ManagerTask, patch: Partial<ManagerTask>): void {
    const next: ManagerTask = { ...task, ...patch }
    this.store.putTask(next)
    this.emitTask(next)
  }

  private emitTask(task: ManagerTask): void {
    try {
      this.ctx.emit('manager/task', task)
    } catch (error) {
      this.warn(`manager/task listener failed: ${errorMessage(error)}`)
    }
  }

  // ---- agent ensure (moved out of the bridge wholesale) ----

  /**
   * The live agent for an id, resuming (or with opt-in, creating) it.
   * CALLERS MUST HOLD the per-session lock (`withSessionLock`) — the lock is
   * not reentrant, and `adopt` (the only caller) already holds it.
   */
  private async ensureLiveAgent(id: string, opts: AdoptSessionOptions): Promise<Agent | undefined> {
    const live = this.ctx.agents.get(SessionId(id))
    if (live !== undefined) return live
    const agentOptions = this.agentOptionsFor(opts.agentOptions)
    const persisted = await this.probePersisted(id)
    if (persisted !== false) {
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: SessionId(id),
          agentOptions,
          setup: this.composeSetup(opts.setup),
        })
        this.handles.set(id, handle)
        return handle.agent
      } catch (error) {
        // 0.2 resume fails for real reasons (owned elsewhere, broken log,
        // bad preset): report verbatim unless the caller allowed creation
        // and the persistence layer reported the session definitely absent.
        if (persisted === true || !opts.createIfMissing) throw error
      }
    }
    if (!opts.createIfMissing) {
      throw new Error(`session ${id} was not found (neither live nor persisted)`)
    }
    const cwd = this.resolveCwd(opts.cwd ?? this.config.cwd)
    const agentPreset = await this.resolvePresetId(opts.agentPreset)
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(id),
      meta: { cwd, ...(agentPreset !== undefined ? { agentPreset } : {}) },
      agentOptions,
      setup: this.composeSetup(opts.setup),
    })
    this.handles.set(id, handle)
    return handle.agent
  }

  /**
   * Whether the id exists in durable storage; undefined = no service to ask
   * (the legacy try-resume-then-create fallback applies). sessionQuery first —
   * its records distinguish "absent" from "persistence is broken" (§2.2).
   */
  private async probePersisted(id: string): Promise<boolean | undefined> {
    const query = this.ctx.get('sessionQuery') as SessionQueryLike | undefined
    if (query !== undefined) {
      try {
        const records = await query.listSessions()
        const record = records.find((candidate) => String(candidate.header?.id ?? '') === id)
        if (record !== undefined) return record.persisted === true || record.live === true
        return false
      } catch {
        // A broken query falls through to the persistence probe.
      }
    }
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (persistence === undefined) return undefined
    try {
      return (await persistence.stat(SessionId(id))) !== undefined
    } catch {
      return undefined
    }
  }

  /** Manager's own per-agent setup, then the caller's, then the preset mount (the manager owns mounting now). */
  private composeSetup(callerSetup?: AgentSetup): AgentSetup {
    return async (agentCtx: Context, agent: Agent) => {
      // V2 fallback: even when a preset restricts the global tool layer, a
      // manager-composed session always sees notify_user on its own layer.
      this.registerNotifyTool(agentCtx)
      const commit = callerSetup !== undefined ? await callerSetup(agentCtx, agent) : undefined
      await this.mountPreset(agentCtx, agent)
      return commit ?? undefined
    }
  }

  private registerNotifyTool(scopeCtx: Context): void {
    const tools = scopeCtx.get('tools') as ToolRuntimeLike | undefined
    if (tools === undefined || typeof tools.register !== 'function') return
    try {
      tools.register(notifyUserTool(this))
    } catch {
      // A duplicate/shadowed registration must not fail agent composition.
    }
  }

  /** Mount the session's own recorded preset (resume), falling back to config/default. */
  private async mountPreset(agentCtx: Context, agent: Agent): Promise<void> {
    const presets = agentCtx.get('agentPresets') as AgentPresetsLike | undefined
    if (presets === undefined) return
    const id = agent.session.header?.agentPreset ?? (await this.resolvePresetId(undefined))
    if (id === undefined) return
    try {
      await presets.mount(agentCtx, id)
    } catch (error) {
      // A preset that fails to mount must not block the session: the agent runs without it.
      this.warn(`agent preset ${id} could not be mounted: ${errorMessage(error)}`)
    }
  }

  private async resolvePresetId(explicit?: string): Promise<string | undefined> {
    if (explicit !== undefined) return explicit
    if (this.config.agentPreset !== undefined) return this.config.agentPreset
    const presets = this.ctx.get('agentPresets') as AgentPresetsLike | undefined
    if (presets === undefined) return undefined
    try {
      return (await presets.resolve(undefined)).id
    } catch {
      return undefined
    }
  }

  private agentOptionsFor(explicit?: AgentOptions): AgentOptions | undefined {
    const provider = explicit?.provider ?? this.config.provider
    const model = explicit?.model ?? this.config.model
    const options: AgentOptions = {
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(explicit?.reasoningEffort !== undefined ? { reasoningEffort: explicit.reasoningEffort } : {}),
      ...(explicit?.maxTokens !== undefined ? { maxTokens: explicit.maxTokens } : {}),
    }
    return Object.keys(options).length > 0 ? options : undefined
  }

  private resolveCwd(raw?: string): string {
    const cwd = resolve(raw ?? process.cwd())
    if (!isAbsolute(cwd)) throw new Error(`session cwd must be absolute: ${raw}`)
    return cwd
  }

  private async resolveWorkspaceId(cwd: string | undefined): Promise<string | undefined> {
    if (cwd === undefined || cwd === '') return undefined
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    if (registry === undefined) return undefined
    try {
      if (typeof registry.resolveByPath === 'function') {
        const workspace = await registry.resolveByPath(cwd)
        if (workspace !== undefined) return String(workspace.id)
      }
      const match = registry.list().find((workspace) => workspace.path === cwd)
      return match !== undefined ? String(match.id) : undefined
    } catch {
      // V4 fallback: no grouping rather than a wrong grouping.
      return undefined
    }
  }

  /** Serialize ensure (resume/create) per session so two subscribers cannot double-resume. */
  private async withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.ensureChains.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((releaseGate) => {
      release = releaseGate
    })
    const tail = previous.then(() => gate, () => gate)
    this.ensureChains.set(sessionId, tail)
    try {
      await previous.catch(() => {})
      return await run()
    } finally {
      release()
      if (this.ensureChains.get(sessionId) === tail) this.ensureChains.delete(sessionId)
    }
  }

  // ---- restart rebuild ----

  /**
   * R7 on restart: open tasks belong to a process that died mid-turn. Fold
   * each against the live log when the session is already live (a repaired log
   * carries the `interrupted` closer); otherwise mark it crashed outright —
   * the honest reading of "still open across a restart".
   */
  private rebuildOpenTasks(): void {
    for (const task of this.store.listTasks()) {
      if (task.state !== 'queued' && task.state !== 'running') continue
      const agent = this.ctx.agents.get(SessionId(task.sessionId))
      if (agent !== undefined && task.turn !== undefined) {
        const closed = findTurnEnd(agent.session, task.turn)
        if (closed !== undefined) {
          const state = closed === 'interrupted' ? 'crashed' : closed === 'error' ? 'failed' : 'done'
          this.transitionTask(task, { state, reason: closed, endedAt: Date.now() })
          continue
        }
        // Live with an open turn: keep running; the fold will close it.
        this.trackingFor(task.sessionId)
        continue
      }
      this.transitionTask(task, { state: 'crashed', reason: 'interrupted', endedAt: Date.now() })
    }
  }

  // ---- view building ----

  private buildView(
    id: string,
    agent: Agent | undefined,
    record: SessionRecordLike | undefined,
    managed: ManagedSession | undefined,
    workspaces: WorkspaceRow[],
  ): SessionView {
    const tracking = this.tracking.get(id)
    const cwd = agent?.session.header?.cwd ?? record?.header?.cwd ?? managed?.cwd
    const logDerived = tracking === undefined && agent !== undefined ? deriveFromLog(agent.session) : undefined
    const lastTurnEnd = tracking?.lastTurnEnd
    const running = agent?.status === 'running'
    const activeTask = this.store
      .listTasks(id)
      .filter((task) => task.state === 'queued' || task.state === 'running')
      .sort((a, b) => a.dispatchedAt - b.dispatchedAt)[0]
    const updatedAt =
      lastEventTime(agent?.session) ?? record?.header?.createdAt ?? managed?.createdAt ?? Date.now()
    const projection = agent !== undefined ? this.projectionValues(agent.session) : undefined
    const title = projectionTitle(projection) ?? managed?.label
    const workspaceId = managed?.workspaceId ?? matchWorkspace(workspaces, cwd)
    const queued = agent?.inbox !== undefined ? (agent.inbox.nextTurn?.length ?? 0) + (agent.inbox.nextStep?.length ?? 0) : undefined
    const lastReason = lastTurnEnd?.reason ?? logDerived?.lastTurnEnd?.reason

    return {
      sessionId: id,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(managed?.label !== undefined ? { label: managed.label } : {}),
      running,
      blank: agent !== undefined ? !hasUserMessage(agent.session) : false,
      updatedAt,
      managed: managed !== undefined,
      foreign: managed === undefined && record?.persisted === true && agent === undefined,
      ...(activeTask !== undefined ? { activeTask } : {}),
      ...(tracking?.pendingInteraction !== undefined ? { pendingInteraction: tracking.pendingInteraction } : {}),
      watchers: this.subscribersOf(id).length,
      ...(queued !== undefined ? { queued } : {}),
      ...(lastReason !== undefined ? { lastReason } : {}),
    }
  }

  private projectionValues(session: Session): Record<string, unknown> | undefined {
    const projections = this.ctx.get('sessionProjections') as SessionProjectionsLike | undefined
    if (projections === undefined) return undefined
    try {
      return projections.snapshot(session).values ?? {}
    } catch {
      return undefined
    }
  }

  private async sessionRecords(): Promise<SessionRecordLike[]> {
    const query = this.ctx.get('sessionQuery') as SessionQueryLike | undefined
    if (query === undefined) return []
    try {
      return await query.listSessions()
    } catch (error) {
      this.warn(`sessionQuery.listSessions failed: ${errorMessage(error)}`)
      return []
    }
  }

  private safeAgentsList(): Agent[] {
    try {
      return this.ctx.agents.list()
    } catch {
      return []
    }
  }

  private workspaceRows(): WorkspaceRow[] {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    if (registry !== undefined) {
      try {
        return registry.list().map((workspace) => ({
          id: String(workspace.id),
          title: workspace.title,
          path: workspace.path,
          sessionCount: workspace.sessionIds?.length ?? 0,
        }))
      } catch {
        // Fall through to cwd-derived groups.
      }
    }
    const groups = new Map<string, number>()
    for (const row of this.store.listSessions()) {
      if (row.cwd === undefined) continue
      groups.set(row.cwd, (groups.get(row.cwd) ?? 0) + 1)
    }
    return [...groups.entries()].map(([path, count]) => ({ id: path, title: pathLabel(path), path, sessionCount: count }))
  }

  // ---- tracking bookkeeping ----

  private trackingFor(sessionId: string): SessionTracking {
    let tracking = this.tracking.get(sessionId)
    if (tracking === undefined) {
      tracking = { toolCalls: new Map() }
      // A live agent the manager never folded (adopted mid-turn, web-opened)
      // brings its log: seed the open turn so a steer dispatch binds to it,
      // plus the display fields. The seeded turn/end is marked notified —
      // whoever ran that turn owned its summary; we must not re-fanout it.
      const agent = this.ctx.agents.get(SessionId(sessionId))
      if (agent !== undefined) {
        const derived = deriveFromLog(agent.session)
        tracking.toolCalls = derived.toolCalls
        if (derived.lastAssistantText !== undefined) tracking.lastAssistantText = derived.lastAssistantText
        if (derived.lastError !== undefined) tracking.lastError = derived.lastError
        if (derived.openTurn !== undefined) tracking.currentTurn = derived.openTurn
        if (derived.lastTurnEnd !== undefined) tracking.lastTurnEnd = { ...derived.lastTurnEnd, notified: true }
      }
      this.tracking.set(sessionId, tracking)
    }
    return tracking
  }

  /** Drop fold state for a session nobody is interested in anymore (bounded memory). */
  private pruneTracking(sessionId: string, tracking: SessionTracking): void {
    if (tracking.pendingInteraction !== undefined) return
    if (this.store.getSession(sessionId) !== undefined) return
    if (this.subscribersOf(sessionId).length > 0) return
    if (this.store.listTasks(sessionId).some((task) => task.state === 'queued' || task.state === 'running')) return
    if (this.store.listOutbox('pending').some((row) => row.deferred === true && row.sessionId === sessionId)) return
    this.tracking.delete(sessionId)
  }

  private findSubscription(subscriberKey: string, sessionId: string) {
    return this.store.listSubscriptions().find((row) => row.subscriberKey === subscriberKey && row.sessionId === sessionId)
  }

  private warn(message: string): void {
    try {
      this.ctx.logger('dsh-session-manager').warn(message)
    } catch {
      // No logger composed; diagnostics are best-effort.
    }
  }
}

interface WorkspaceRow {
  id: string
  title: string
  path?: string
  sessionCount: number
}

// ---- pure helpers ----

function unionKinds(a: readonly NotificationKind[], b: readonly NotificationKind[]): NotificationKind[] {
  const merged: NotificationKind[] = [...a]
  for (const kind of b) if (!merged.includes(kind)) merged.push(kind)
  return merged
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** First ~80 chars of a user message's text blocks (the `/ls` task summary). */
export function summarizeMessage(message: UserMessage): string {
  return truncate(messageText((message as { content?: unknown }).content), SUMMARY_CHARS)
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: string } => {
      const candidate = block as { type?: string; text?: unknown } | null
      return candidate?.type === 'text' && typeof candidate.text === 'string'
    })
    .map((block) => block.text)
    .join('\n')
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

const TURN_END_GLYPHS: Record<string, string> = {
  completed: '✅',
  aborted: '⏹',
  blocked: '⛔',
  error: '⚠️',
  'max-tokens': '✂️',
  interrupted: '✗',
  forked: '⑂',
}

/** The idle-edge summary: reason glyph + reason + the truncated last assistant text. */
export function turnEndSummary(reason: string, lastAssistantText: string | undefined): string {
  const glyph = TURN_END_GLYPHS[reason] ?? 'ℹ️'
  const text = truncate(lastAssistantText ?? '', NOTIFY_TEXT_CHARS)
  return text !== '' ? `${glyph} ${reason} · ${text}` : `${glyph} ${reason}`
}

function lastOpenToolCall(toolCalls: Map<string, string> | undefined): string | undefined {
  if (toolCalls === undefined || toolCalls.size === 0) return undefined
  return [...toolCalls.values()].pop()
}

interface DerivedLogState {
  toolCalls: Map<string, string>
  lastAssistantText?: string
  lastError?: string
  /** The turn still open at the log tail (a turn/start with no matching turn/end). */
  openTurn?: number
  lastTurnEnd?: { turn: number; reason: string; at: number }
}

/** Lazy tail fold for a live session the manager never tracked (a web-UI session in `describe()`). */
function deriveFromLog(session: Session): DerivedLogState {
  const state: DerivedLogState = { toolCalls: new Map() }
  let events: readonly SessionEvent[] = []
  try {
    // Deprecated-but-present synchronous read; the manager only tail-scans on demand.
    events = session.snapshotEvents()
  } catch {
    return state
  }
  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined
    switch (event.type) {
      case 'assistant/message': {
        const text = messageText((data?.message as { content?: unknown })?.content)
        if (text !== '') state.lastAssistantText = text
        break
      }
      case 'tool/call':
        state.toolCalls.set(String(data?.callId ?? ''), String(data?.name ?? ''))
        break
      case 'tool/result': {
        const message = data?.message as { toolCallId?: string; source?: { callId?: string } } | undefined
        state.toolCalls.delete(String(message?.toolCallId ?? message?.source?.callId ?? ''))
        break
      }
      case 'turn/start':
        state.openTurn = Number(data?.turn ?? 0)
        break
      case 'turn/end': {
        const reason = data?.reason as { kind?: string; error?: { message?: string } } | undefined
        const kind = reason?.kind ?? 'completed'
        const turn = Number(data?.turn ?? 0)
        state.lastTurnEnd = { turn, reason: kind, at: event.time ?? 0 }
        if (state.openTurn === turn) state.openTurn = undefined
        if (kind === 'error') state.lastError = reason?.error?.message ?? 'turn failed'
        break
      }
      default:
        break
    }
  }
  return state
}

function findTurnEnd(session: Session, turn: number): string | undefined {
  try {
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'turn/end') continue
      const data = event.data as { turn?: number; reason?: { kind?: string } }
      if (Number(data.turn) === turn) return data.reason?.kind ?? 'completed'
    }
  } catch {
    // Unreadable log: the caller falls back to the crashed marking.
  }
  return undefined
}

function hasUserMessage(session: Session): boolean {
  try {
    for (const event of session.snapshotEvents()) {
      if (event.type === 'user/message') return true
    }
  } catch {
    return false
  }
  return false
}

function lastEventTime(session: Session | undefined): number | undefined {
  if (session === undefined) return undefined
  try {
    const events = session.snapshotEvents()
    const last = events[events.length - 1]
    return last?.time
  } catch {
    return undefined
  }
}

function projectionTitle(values: Record<string, unknown> | undefined): string | undefined {
  const title = values?.title
  if (typeof title === 'string') return title !== '' ? title : undefined
  if (title !== null && typeof title === 'object') {
    const object = title as Record<string, unknown>
    if (typeof object.title === 'string' && object.title !== '') return object.title
    if (typeof object.text === 'string' && object.text !== '') return object.text
  }
  return undefined
}

function projectionTodos(values: Record<string, unknown> | undefined): readonly unknown[] | undefined {
  const todo = values?.todo ?? values?.todos
  if (Array.isArray(todo)) return todo
  if (todo !== null && typeof todo === 'object') {
    const object = todo as Record<string, unknown>
    if (Array.isArray(object.items)) return object.items
    if (Array.isArray(object.todos)) return object.todos
  }
  return undefined
}

function matchWorkspace(workspaces: WorkspaceRow[], cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  return workspaces.find((workspace) => workspace.path === cwd)?.id
}

function pathLabel(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '')
  return segments[segments.length - 1] ?? path
}
