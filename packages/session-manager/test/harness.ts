/**
 * Shared in-memory fakes for the manager suite: a fake agent registry with
 * log-emitting helpers, plus duck-typed stand-ins for every optional dsh
 * service the manager consumes through ctx.get.
 */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionManager, createMemoryManagerStore, type ManagerStore, type SessionManagerConfig } from '../src/index.ts'

export interface FakeSession {
  id: string
  header: { id: string; createdAt: number; cwd?: string; agentPreset?: string }
  events: Array<{ type: string; seq: number; time: number; data: unknown }>
  readonly seq: number
  snapshotEvents(): readonly { type: string; seq: number; time: number; data: unknown }[]
  eventAt(seq: number): { type: string; seq: number; time: number; data: unknown } | undefined
}

export interface FakeAgent {
  id: string
  status: 'idle' | 'running'
  session: FakeSession
  inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] }
  followed: UserMessage[]
  steered: UserMessage[]
  cancels: unknown[]
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  cancel(cause: unknown): void
}

export interface FakeAgentsControl {
  agents: Map<string, FakeAgent>
  created: Array<{ sessionId: string; meta?: { cwd?: string; agentPreset?: string }; agentOptions?: unknown }>
  resumed: string[]
  disposed: string[]
  /** Ids the persistence layer knows; resume throws for anything else (the real 0.2 behavior). */
  resumable: Set<string>
  /** Make the next resume call throw (a real persistence failure). */
  failResumeWith?: Error
  /** Service object to hand to `root.provide('agents', …)`. */
  service: Record<string, unknown>
}

export function createFakeSession(id: string, opts: { cwd?: string; agentPreset?: string; createdAt?: number } = {}): FakeSession {
  const events: FakeSession['events'] = []
  return {
    id,
    header: { id, createdAt: opts.createdAt ?? Date.now(), ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}), ...(opts.agentPreset !== undefined ? { agentPreset: opts.agentPreset } : {}) },
    events,
    get seq() {
      return events.length
    },
    snapshotEvents() {
      return events
    },
    eventAt(seq: number) {
      return events[seq]
    },
  }
}

export function createFakeAgent(id: string, opts: { cwd?: string; agentPreset?: string } = {}): FakeAgent {
  return {
    id,
    status: 'idle',
    session: createFakeSession(id, opts),
    inbox: { nextTurn: [], nextStep: [] },
    followed: [],
    steered: [],
    cancels: [],
    followup(message) {
      this.followed.push(message)
    },
    steer(message) {
      this.steered.push(message)
    },
    cancel(cause) {
      this.cancels.push(cause)
    },
  }
}

/** The agent-scope ctx factory mirrors dsh's hierarchy: the agent layer shadows root services. */
export type MakeAgentCtx = () => { get: (name: string) => unknown; on: (event: string, listener: unknown) => () => void }

export function createFakeAgents(makeAgentCtx: MakeAgentCtx): FakeAgentsControl {
  const control: FakeAgentsControl = {
    agents: new Map(),
    created: [],
    resumed: [],
    disposed: [],
    resumable: new Set(),
    service: {},
  }
  control.service = {
    list: () => [...control.agents.values()],
    get: (id: unknown) => control.agents.get(String(id)),
    create: async (opts: { sessionId: string; meta?: { cwd?: string; agentPreset?: string }; agentOptions?: unknown; setup?: (agentCtx: unknown, agent: unknown) => unknown }) => {
      const id = String(opts.sessionId)
      if (control.agents.has(id)) throw new Error(`session already exists: ${id}`)
      const agent = createFakeAgent(id, { cwd: opts.meta?.cwd, agentPreset: opts.meta?.agentPreset })
      control.agents.set(id, agent)
      control.created.push({ sessionId: id, meta: opts.meta, agentOptions: opts.agentOptions })
      if (opts.setup) await opts.setup(makeAgentCtx(), agent)
      return {
        agent,
        dispose: async () => {
          control.agents.delete(id)
          control.disposed.push(id)
        },
      }
    },
    resume: async (opts: { resumeSessionId: string; setup?: (agentCtx: unknown, agent: unknown) => unknown }) => {
      const id = String(opts.resumeSessionId)
      if (control.failResumeWith) throw control.failResumeWith
      if (!control.resumable.has(id)) throw new Error(`no persistence for ${id}`)
      control.resumed.push(id)
      const existing = control.agents.get(id)
      const agent = existing ?? createFakeAgent(id, { cwd: '/persisted/cwd' })
      if (!existing) control.agents.set(id, agent)
      if (opts.setup) await opts.setup(makeAgentCtx(), agent)
      return {
        agent,
        dispose: async () => {
          control.agents.delete(id)
          control.disposed.push(id)
        },
      }
    },
  }
  return control
}

export interface HarnessOptions {
  config?: SessionManagerConfig
  store?: ManagerStore
  /** Records persisted but not live: sessionQuery.listSessions rows. */
  sessionQueryRecords?: Array<{ header: { id: string; cwd?: string; createdAt?: number }; live?: boolean; persisted?: boolean }>
  /** sessionQuery.listSessions throws. */
  sessionQueryFails?: boolean
  /** sessionPersistence.stat answers for these ids. */
  persistedStats?: string[]
  /** agentPresets fake; resolve returns `presetId` (default 'standard'). */
  presets?: { presetId?: string; failMount?: boolean }
  /** Collect tool definitions registered on the ROOT (global) layer. */
  tools?: { definitions: Array<{ name: string }> }
  /** workspaceRegistry rows. */
  workspaces?: Array<{ id: string; path: string; title: string; sessionIds?: string[] }>
  /** sessionProjections.snapshot values keyed by session id. */
  projections?: Record<string, Record<string, unknown>>
  /** A storageDomain facility fake (open succeeds unless `fails`). */
  storageDomain?: { fails?: boolean; tables: Record<string, Map<string, unknown>>; globals: Array<unknown> }
  /** Live agents pre-registered before start(). */
  liveAgents?: FakeAgent[]
}

export interface Harness {
  root: Context
  manager: SessionManager
  agents: FakeAgentsControl
  /** Tool definitions registered on the root layer (start-time global notify_user). */
  toolDefinitions: Array<{ name: string }>
  /** Tool definitions registered per agent inside setup (the V2 fallback layer). */
  agentToolDefinitions: Array<{ name: string }>
  presetCalls: { resolves: Array<string | undefined>; mounts: Array<string | undefined> }
  /** Ordered markers of what ran inside one setup: 'agent-tool', 'caller', 'mount'. */
  setupOrder: string[]
}

export function createHarness(opts: HarnessOptions = {}): Harness {
  const root = new Context()
  const toolDefinitions = opts.tools?.definitions ?? []
  const agentToolDefinitions: Array<{ name: string }> = []
  const presetCalls = { resolves: [] as Array<string | undefined>, mounts: [] as Array<string | undefined> }
  const setupOrder: string[] = []

  const makeAgentCtx: MakeAgentCtx = () => ({
    get: (name: string) => {
      // The agent-scope tools layer is its own registry (shadowing the global one).
      if (name === 'tools') {
        return {
          register: (definition: { name: string }) => {
            agentToolDefinitions.push(definition)
            setupOrder.push('agent-tool')
            return () => {}
          },
        }
      }
      return root.get(name)
    },
    on: () => () => {},
  })

  const agents = createFakeAgents(makeAgentCtx)
  for (const agent of opts.liveAgents ?? []) agents.agents.set(agent.id, agent)
  for (const id of opts.persistedStats ?? []) agents.resumable.add(id)
  for (const record of opts.sessionQueryRecords ?? []) {
    if (record.persisted || record.live) agents.resumable.add(record.header.id)
  }
  root.provide('agents', agents.service as never)
  root.provide('sessions', {} as never)

  if (opts.sessionQueryRecords !== undefined || opts.sessionQueryFails) {
    root.provide('sessionQuery', {
      listSessions: async () => {
        if (opts.sessionQueryFails) throw new Error('query backend down')
        return opts.sessionQueryRecords ?? []
      },
    } as never)
  }
  if (opts.persistedStats !== undefined) {
    root.provide('sessionPersistence', {
      stat: async (id: unknown) => (opts.persistedStats!.includes(String(id)) ? { id: String(id) } : undefined),
    } as never)
  }
  if (opts.presets !== undefined) {
    root.provide('agentPresets', {
      resolve: async (id?: string) => {
        presetCalls.resolves.push(id)
        return { id: opts.presets!.presetId ?? 'standard' }
      },
      mount: async (_agentCtx: unknown, id?: string) => {
        presetCalls.mounts.push(id)
        setupOrder.push('mount')
        if (opts.presets!.failMount) throw new Error('preset broken')
      },
    } as never)
  }
  if (opts.tools !== undefined) {
    root.provide('tools', {
      register: (definition: { name: string }) => {
        toolDefinitions.push(definition)
        return () => {
          const index = toolDefinitions.indexOf(definition)
          if (index >= 0) toolDefinitions.splice(index, 1)
        }
      },
    } as never)
  }
  if (opts.workspaces !== undefined) {
    root.provide('workspaceRegistry', {
      list: () => opts.workspaces!,
      resolveByPath: async (path: string) => opts.workspaces!.find((workspace) => workspace.path === path),
    } as never)
  }
  if (opts.projections !== undefined) {
    root.provide('sessionProjections', {
      snapshot: (session: { id: string }) => ({ asOfSeq: -1, values: opts.projections![session.id] ?? {} }),
    } as never)
  }
  if (opts.storageDomain !== undefined) {
    const spec = opts.storageDomain
    root.provide('storageDomain', {
      open: async () => {
        if (spec.fails) throw new Error('no backend route')
        const table = (name: string) => {
          const rows = (spec.tables[name] ??= new Map<string, unknown>())
          return {
            get: (key: string) => rows.get(key),
            entries: () => rows.entries(),
            keys: () => rows.keys(),
            get size() {
              return rows.size
            },
            put: async (key: string, value: unknown) => {
              rows.set(key, value)
            },
            delete: async (key: string) => rows.delete(key),
          }
        }
        return {
          name: 'session-manager',
          global: {
            get: () => spec.globals[spec.globals.length - 1] ?? { idCounter: 0 },
            set: async (value: unknown) => {
              spec.globals.push(value)
            },
          },
          table,
          close: async () => {},
        }
      },
    } as never)
  }

  const manager = new SessionManager(root, opts.config ?? {}, opts.store ?? createMemoryManagerStore())
  return { root, manager, agents, toolDefinitions, agentToolDefinitions, presetCalls, setupOrder }
}

// ---- event driving ----

export function emitEvent(root: Context, agent: FakeAgent, type: string, data: unknown): void {
  const seq = agent.session.events.length
  const event = { type, seq, time: Date.now(), data }
  agent.session.events.push(event)
  root.emit('session/event', agent.session as never, event as never)
}

export function emitStatus(root: Context, agent: FakeAgent, status: 'idle' | 'running'): void {
  agent.status = status
  root.emit('agent/status', { agent, status } as never)
}

export function emitUserMessage(root: Context, agent: FakeAgent, text: string, turn = 0): void {
  emitEvent(root, agent, 'user/message', { turn, step: 1, message: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })
}

export function emitAssistantMessage(root: Context, agent: FakeAgent, text: string, turn = 1, step = 1): void {
  emitEvent(root, agent, 'assistant/message', {
    turn,
    step,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    stream: [],
  })
}

/** Drive one complete turn: running → turn/start → (assistant text) → turn/end(reason) → idle. */
export function runTurn(root: Context, agent: FakeAgent, turn: number, opts: { reason?: string; assistantText?: string; idleAfter?: boolean } = {}): void {
  emitStatus(root, agent, 'running')
  emitEvent(root, agent, 'turn/start', { turn })
  if (opts.assistantText !== undefined) emitAssistantMessage(root, agent, opts.assistantText, turn)
  emitEvent(root, agent, 'turn/end', { turn, reason: { kind: opts.reason ?? 'completed' } })
  if (opts.idleAfter !== false) emitStatus(root, agent, 'idle')
}

export function userMsg(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}
