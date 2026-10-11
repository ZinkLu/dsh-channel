/**
 * The concierge toolset (design §15.2): eight thin shells over the public
 * `SessionManager` surface, defined agent-relative (`by = exec.agent.id` — the
 * notify_user pattern) so the toolset is mountable on any agent, and mounted
 * ONLY on the concierge's own scope (C1: never global, so work sessions never
 * see it and recursive spawning is impossible by construction).
 *
 * dsh-tools is an optional peer and is NOT imported: definitions are plain
 * objects matching `ToolDefinition`'s structural contract, handed to a
 * duck-typed `register`. Outputs are compact JSON rows for the model;
 * `output.render` produces the one-line status text the focus chat sees.
 */
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ManagedSession, ManagerTask, SessionDetail, SessionView, WorkspaceView } from './types.js'

/** What the toolset needs from the manager; kept narrow so it stays testable. */
export interface ConciergeToolHost {
  list(opts?: { workspaceId?: string; includeForeign?: boolean }): Promise<SessionView[]>
  describe(sessionId: string): Promise<SessionDetail>
  workspaces(): WorkspaceView[]
  create(opts: { cwd?: string; workspaceId?: string; label?: string; by: string }): Promise<ManagedSession>
  dispatch(opts: { sessionId: string; message: UserMessage; mode?: 'auto' | 'followup' | 'steer'; by: string; watch?: boolean }): Promise<ManagerTask>
  cancel(sessionId: string, cause?: string): Promise<void>
  watch(subscriberKey: string, sessionId: string): unknown
  unwatch(subscriberKey: string, sessionId: string): void
  subscribersOf(sessionId: string): string[]
}

/** Structural view of one tool execution context (dsh-tools' ToolRunContext). */
export interface ConciergeToolExec {
  agent?: { id?: string }
}

export interface ConciergeToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: Record<string, unknown>, exec: ConciergeToolExec): Promise<Record<string, unknown>>
}

const NO_SELF = 'no agent context: this toolset must run inside an agent session'

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function selfOf(exec: ConciergeToolExec): string {
  const id = exec?.agent?.id
  return typeof id === 'string' && id !== '' ? id : ''
}

function pluginMessage(text: string): UserMessage {
  // The concierge model authored this text on the user's behalf; the manager
  // source kind is the honest label (and carries no platform messageIds the
  // inbound idempotency fold could trip over).
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'manager', origin: 'concierge-tool' } })
}

function oneLine(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

/** One compact `list_sessions` row. */
function viewRow(view: SessionView): Record<string, unknown> {
  return {
    sessionId: view.sessionId,
    ...(view.label !== undefined ? { label: view.label } : {}),
    ...(view.title !== undefined ? { title: view.title } : {}),
    ...(view.workspaceId !== undefined ? { workspaceId: view.workspaceId } : {}),
    running: view.running,
    blank: view.blank,
    ...(view.activeTask !== undefined ? { task: view.activeTask.state } : {}),
    ...(view.pendingInteraction !== undefined ? { pendingInteraction: view.pendingInteraction } : {}),
    watchers: view.watchers,
    updatedAt: new Date(view.updatedAt).toISOString(),
    managed: view.managed,
    foreign: view.foreign,
  }
}

function detailRow(detail: SessionDetail): Record<string, unknown> {
  return {
    ...viewRow(detail),
    ...(detail.currentTool !== undefined ? { currentTool: detail.currentTool } : {}),
    ...(detail.lastAssistantText !== undefined ? { lastAssistantText: detail.lastAssistantText } : {}),
    ...(detail.lastError !== undefined ? { lastError: detail.lastError } : {}),
    tasks: detail.tasks.map((task) => ({
      taskId: task.taskId,
      state: task.state,
      ...(task.turn !== undefined ? { turn: task.turn } : {}),
      summary: task.summary,
      dispatchedAt: new Date(task.dispatchedAt).toISOString(),
    })),
  }
}

/** Resolve an id-or-label reference against `list()` (deterministic, no guessing). */
export async function resolveSessionRef(
  host: ConciergeToolHost,
  ref: string,
): Promise<{ sessionId: string } | { error: string }> {
  const views = await host.list()
  const byId = views.find((view) => view.sessionId === ref)
  if (byId !== undefined) return { sessionId: byId.sessionId }
  const byLabel = views.filter((view) => view.label === ref)
  if (byLabel.length === 1) return { sessionId: byLabel[0]!.sessionId }
  if (byLabel.length > 1) return { error: `label "${ref}" matches ${byLabel.length} sessions; use the exact session id` }
  return { error: `no session with id or label "${ref}"; call list_sessions first` }
}

/** The C4 subscriber copy: this agent's own subscribers (opaque keys) onto the target, all kinds. */
function copySubscribers(host: ConciergeToolHost, self: string, sessionId: string): number {
  let copied = 0
  for (const key of host.subscribersOf(self)) {
    if (key === sessionId) continue
    host.watch(key, sessionId)
    copied += 1
  }
  return copied
}

const refParam = {
  type: 'string',
  description: 'Target session: exact session id, or its unique label (see list_sessions).',
}

export function conciergeTools(host: ConciergeToolHost): ConciergeToolDefinition[] {
  return [
    {
      name: 'list_sessions',
      description: 'List every session this process can see (live, cold, managed, foreign), newest activity first, with running/task/pending-interaction state.',
      parameters: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Only sessions in this workspace (see list_workspaces).' },
          includeForeign: { type: 'boolean', description: 'Include sessions only ever seen in persistence, possibly another process\'s. Default true.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { sessions: { type: 'array' } }, required: ['sessions'], additionalProperties: false },
        render: (_args, value) => oneLine(`${Array.isArray((value as { sessions?: unknown[] })?.sessions) ? (value as { sessions: unknown[] }).sessions.length : 0} session(s) listed`),
      },
      async execute(args) {
        const sessions = await host.list({
          ...(args?.workspaceId !== undefined ? { workspaceId: String(args.workspaceId) } : {}),
          ...(args?.includeForeign !== undefined ? { includeForeign: args.includeForeign === true } : {}),
        })
        return { sessions: sessions.map(viewRow) }
      },
    },
    {
      name: 'describe_session',
      description: 'One session in detail: recent dispatch tasks, current tool, last assistant text, last error. Accepts the session id or its unique label.',
      parameters: { type: 'object', properties: { session: refParam }, required: ['session'], additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { session: { type: 'object' }, error: { type: 'string' } }, additionalProperties: false },
        render: (args, value) => {
          const detail = value as { error?: string; session?: { sessionId?: string } } | undefined
          return oneLine(detail?.error !== undefined ? `describe failed: ${detail.error}` : `details for ${detail?.session?.sessionId ?? String((args as { session?: string })?.session ?? '')}`)
        },
      },
      async execute(args) {
        const ref = textOf(args?.session)
        if (ref === '') return { error: 'session is required' }
        const resolved = await resolveSessionRef(host, ref)
        if ('error' in resolved) return { error: resolved.error }
        try {
          return { session: detailRow(await host.describe(resolved.sessionId)) }
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
    },
    {
      name: 'list_workspaces',
      description: 'List workspaces (registry rows or cwd-derived groups) with their session counts; the ids feed create_session.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { workspaces: { type: 'array' } }, required: ['workspaces'], additionalProperties: false },
        render: (_args, value) => oneLine(`${Array.isArray((value as { workspaces?: unknown[] })?.workspaces) ? (value as { workspaces: unknown[] }).workspaces.length : 0} workspace(s)`),
      },
      async execute() {
        return { workspaces: host.workspaces().map((workspace: WorkspaceView) => ({ id: workspace.id, title: workspace.title, ...(workspace.path !== undefined ? { path: workspace.path } : {}), sessions: workspace.sessionCount })) }
      },
    },
    {
      name: 'create_session',
      description: 'Create a new managed session (a fresh agent with the standard preset) and optionally hand it a first instruction. Returns its session id.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short human label, e.g. "docs sync"; addressable later by this label.' },
          cwd: { type: 'string', description: 'Absolute working directory; omit for the default workspace.' },
          workspaceId: { type: 'string', description: 'Workspace to create in (see list_workspaces); alternative to cwd.' },
          text: { type: 'string', description: 'Optional first instruction dispatched immediately.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { sessionId: { type: 'string' }, dispatched: { type: 'boolean' }, error: { type: 'string' } }, required: ['sessionId'], additionalProperties: false },
        render: (_args, value) => {
          const result = value as { sessionId?: string; dispatched?: boolean; error?: string } | undefined
          return oneLine(result?.error !== undefined ? `created ${result?.sessionId ?? '?'} but the first dispatch failed: ${result.error}` : `created ${result?.sessionId ?? '?'}${result?.dispatched === true ? ' and dispatched' : ''}`)
        },
      },
      async execute(args, exec) {
        const self = selfOf(exec)
        if (self === '') return { sessionId: '', error: NO_SELF }
        const label = textOf(args?.label)
        const text = textOf(args?.text)
        const row = await host.create({
          ...(args?.cwd !== undefined ? { cwd: String(args.cwd) } : {}),
          ...(args?.workspaceId !== undefined ? { workspaceId: String(args.workspaceId) } : {}),
          ...(label !== '' ? { label } : {}),
          by: self,
        })
        if (text === '') return { sessionId: row.sessionId, dispatched: false }
        try {
          await host.dispatch({ sessionId: row.sessionId, message: pluginMessage(text), by: self, watch: false })
        } catch (error) {
          return { sessionId: row.sessionId, dispatched: false, error: error instanceof Error ? error.message : String(error) }
        }
        copySubscribers(host, self, row.sessionId)
        return { sessionId: row.sessionId, dispatched: true }
      },
    },
    {
      name: 'dispatch_message',
      description: 'Hand one instruction to a session as a tracked task. Idle sessions start a new turn; running ones are steered. You are woken automatically when the task ends. Use create_session for a session that does not exist yet.',
      parameters: {
        type: 'object',
        properties: {
          session: refParam,
          text: { type: 'string', description: 'The full, self-contained instruction for that session.' },
          mode: { type: 'string', enum: ['auto', 'followup', 'steer'], description: '"auto" (default): idle → new turn, running → steer.' },
        },
        required: ['session', 'text'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { dispatched: { type: 'boolean' }, taskId: { type: 'string' }, error: { type: 'string' } }, required: ['dispatched'], additionalProperties: false },
        render: (args, value) => {
          const result = value as { dispatched?: boolean; taskId?: string; error?: string } | undefined
          return oneLine(result?.dispatched === true ? `dispatched task #${result?.taskId ?? '?'}` : `dispatch failed: ${result?.error ?? 'unknown'}`)
        },
      },
      async execute(args, exec) {
        const self = selfOf(exec)
        if (self === '') return { dispatched: false, error: NO_SELF }
        const ref = textOf(args?.session)
        if (ref === '') return { dispatched: false, error: 'session is required' }
        if (ref === self) return { dispatched: false, error: 'that is your own session; answer the user directly' }
        const text = textOf(args?.text)
        if (text === '') return { dispatched: false, error: 'text is required' }
        const resolved = await resolveSessionRef(host, ref)
        if ('error' in resolved) return { dispatched: false, error: resolved.error }
        const mode = args?.mode === 'followup' || args?.mode === 'steer' ? args.mode : undefined
        let task: ManagerTask
        try {
          task = await host.dispatch({ sessionId: resolved.sessionId, message: pluginMessage(text), ...(mode !== undefined ? { mode } : {}), by: self, watch: false })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { dispatched: false, error: `${message}. If the session has no live agent here, create_session first; a persisted-but-foreign one belongs to another process.` }
        }
        // C4: this agent's subscribers (the chats watching it) are copied onto
        // the target so approvals/questions and result badges reach humans.
        copySubscribers(host, self, resolved.sessionId)
        return { dispatched: true, taskId: task.taskId, sessionId: resolved.sessionId }
      },
    },
    {
      name: 'cancel_session',
      description: 'Cancel a session\'s current activity (its open turn). Idempotent; a cold session is a no-op.',
      parameters: {
        type: 'object',
        properties: { session: refParam, cause: { type: 'string', description: 'Short reason recorded on the cancellation.' } },
        required: ['session'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { canceled: { type: 'boolean' }, error: { type: 'string' } }, required: ['canceled'], additionalProperties: false },
        render: (_args, value) => oneLine((value as { canceled?: boolean } | undefined)?.canceled === true ? 'cancel requested' : `cancel failed: ${(value as { error?: string } | undefined)?.error ?? 'unknown'}`),
      },
      async execute(args, exec) {
        if (selfOf(exec) === '') return { canceled: false, error: NO_SELF }
        const ref = textOf(args?.session)
        if (ref === '') return { canceled: false, error: 'session is required' }
        const resolved = await resolveSessionRef(host, ref)
        if ('error' in resolved) return { canceled: false, error: resolved.error }
        try {
          await host.cancel(resolved.sessionId, args?.cause !== undefined ? String(args.cause) : undefined)
          return { canceled: true }
        } catch (error) {
          return { canceled: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    },
    {
      name: 'watch_session',
      description: 'Subscribe the chats watching you to a session\'s result notifications (turn-end summaries, errors) without dispatching anything.',
      parameters: { type: 'object', properties: { session: refParam }, required: ['session'], additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { watching: { type: 'number' }, error: { type: 'string' } }, required: ['watching'], additionalProperties: false },
        render: (_args, value) => oneLine(`${(value as { watching?: number } | undefined)?.watching ?? 0} chat(s) now watching`),
      },
      async execute(args, exec) {
        const self = selfOf(exec)
        if (self === '') return { watching: 0, error: NO_SELF }
        const ref = textOf(args?.session)
        if (ref === '') return { watching: 0, error: 'session is required' }
        const resolved = await resolveSessionRef(host, ref)
        if ('error' in resolved) return { watching: 0, error: resolved.error }
        return { watching: copySubscribers(host, self, resolved.sessionId) }
      },
    },
    {
      name: 'unwatch_session',
      description: 'Unsubscribe the chats watching you from a session\'s notifications (e.g. the user asked to stop hearing about it).',
      parameters: { type: 'object', properties: { session: refParam }, required: ['session'], additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { removed: { type: 'number' }, error: { type: 'string' } }, required: ['removed'], additionalProperties: false },
        render: (_args, value) => oneLine(`removed ${(value as { removed?: number } | undefined)?.removed ?? 0} subscription(s)`),
      },
      async execute(args, exec) {
        const self = selfOf(exec)
        if (self === '') return { removed: 0, error: NO_SELF }
        const ref = textOf(args?.session)
        if (ref === '') return { removed: 0, error: 'session is required' }
        const resolved = await resolveSessionRef(host, ref)
        if ('error' in resolved) return { removed: 0, error: resolved.error }
        let removed = 0
        for (const key of host.subscribersOf(self)) {
          host.unwatch(key, resolved.sessionId)
          removed += 1
        }
        return { removed }
      },
    },
  ]
}

export const CONCIERGE_TOOL_NAMES = [
  'list_sessions',
  'describe_session',
  'list_workspaces',
  'create_session',
  'dispatch_message',
  'cancel_session',
  'watch_session',
  'unwatch_session',
] as const
