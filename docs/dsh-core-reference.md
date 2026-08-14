# DSH Core and Capability Seams Reference (Aligned to `@deepseek-ai/*@0.1.0-rc.6`)

> This document records the DeepSeek Harness (dsh) core architecture and capability seams as
> the **single alignment baseline** for this repository (`dsh-channel`). It was written by
> cross-checking, item by item, the official reference documentation
> (https://deepseek-harness.github.io/deepseek-harness/reference/ ) **and the installed rc.6
> compiled type declarations** (`node_modules/@deepseek-ai/*/lib/types/*.d.ts`). Wherever the
> two show version drift it is called out separately — do not write code directly from
> symbols that only exist in the master docs.

- The official docs are generated from the `deepseek-harness` **master branch** (including
  symbols such as `steering/message` and `TurnTriggerMap` that do not yet exist in rc.6).
- This project's `package.json` devDependencies are pinned to `^0.1.0-rc.6`; the runtime
  harness also runs on rc.6. **Code takes rc.6 as authoritative**; the docs serve only as
  semantic reference.

---

## 0. One-line conclusion (the shape after alignment)

dsh has no "privileged kernel" that needs patching. **Every ctx key is either `core` (the
single backbone service), a `seam` (a Service Definition for a replaceable capability), or a
`bundle` (a composition point)**. The way to extend dsh is to mount a plugin alongside the
other plugins: all registrations are reversible side effects, and unloading the plugin
undoes them.

- `core`: the only service of its kind within a process/scope, holding product facts
  (registry, log, status folding).
- `seam`: a capability only comes together from **a Service Definition that declares the
  interface + a Provider that implements it + a Consumer that uses it**; swapping the
  provider swaps the entire product behavior (e.g. pointing `ctx.subprocess` at a remote
  sandbox moves Bash/PTY/LSP all together, with no provider-specific fork).
- `bundle`: a composition point (e.g. `ctx.agentLoop`), the **only concrete implementation**
  of the "default product loop". Extension packages depend on `dsh-agent`'s events and
  services and **never** depend directly on `dsh-agent-loop`, so the loop stays replaceable.

The rest of this document:
1. [Cordis foundation](#1-cordis-foundation) — Context / Service / Events / dispatch modes / effect
2. [Full ctx table: seam vs core](#2-full-ctx-table-seam-vs-core) — complete role table of the backbone plus this project's touchpoints
3. [Core packages (packages/core/)](#3-core-packages-packagescore) — the six packages and the precise `ctx.agents` API
4. [Turn/step lifecycle](#4-turnstep-lifecycle) — turn/step and `agent/*` events
5. [Tool execution pipeline](#5-tool-execution-pipeline) — `tools/*` events and approval degradation
6. [Session log and SessionEventMap](#6-session-log-and-sessioneventmap) — single source of truth
7. [Repo-wide common type patterns](#7-repo-wide-common-type-patterns) — `…Map→union` and Branded ids
8. [Alignment check against this project's design](#8-alignment-check-against-this-projects-design) — summary (see `dsh-core-alignment-audit.md` for details)

---

## 1. Cordis foundation

dsh sits on top of the vendored Cordis. Five core concepts (from the official cordis-primer):

1. **Plugin** = an object implementing `Service`: a function plugin (optional `inject` +
   `apply(ctx)`) or a `Service` subclass. Cordis mounts its lifecycle onto the current context.
2. **The context is a service container**: one service occupies one stable `ctx.<key>`; other
   plugins **look services up by key**, not by importing the concrete implementation.
3. **`inject` declares service dependencies**: a plugin only starts once the services it
   depends on are ready; load order is expressed via service dependencies, not
   hand-orchestrated.
4. **Typed events for communication**: event names are registered via TypeScript declaration
   merging, then dispatched via emit / waterfall / parallel / serial / bail.
5. **Registrations are reversible side effects**: prompt fragments, tool schemas, adapters,
   providers, and listeners are installed through `ctx.effect()` or `ctx.on()` and
   automatically undone on reload/teardown.

### 1.1 Event dispatch modes (`DispatchMode`)

| Mode | await | Order | Has return value | Semantics |
|---|---|---|---|---|
| `emit` | no | registration order | no | observe; runs synchronously, ignores return values |
| `waterfall` | no* | registration order | yes | around-middleware: `(...args, next)`, call `next()` to delegate onward, don't call it to short-circuit |
| `parallel` | yes | concurrent | no | all in parallel, wait for every listener to settle |
| `serial` | yes | registration order | yes | await one after another, until one bails (returns non-null/false/undefined) |
| `bail` | no | registration order | yes | call synchronously in order, stop at the first bail value |

> *`waterfall` itself returns the outermost listener's return value (possibly a Promise);
> "whether await" refers to the dispatch itself not waiting.

**waterfall semantics**: each listener wraps "the rest of the chain" — `next()` runs the next
listener (ultimately the built-in behavior), and the downstream return value flows back
through `next()` to the current wrapper; returning directly without calling `next()` =
short-circuit. **In a single-decision event, short-circuiting is the design intent** (a policy
listener returns directly when it holds the decision); purely observing/annotating listeners
must delegate. Corresponding source: `@deepseek-ai/cordis/lib/types/events.d.ts`
(`ctx.parallel/emit/serial/bail/waterfall/on/once`).

### 1.2 Context / Service / effect essentials

- `Context` is a **proxy**: property reads go through the service resolver;
  `extend()`/`isolate()`/`intercept()` create scoped child contexts without modifying the
  parent context.
  - `ctx.isolate(name, label?)`: gives `name` an independent service scope (same label twice =
    same scope).
  - `ctx.intercept(name, config)`: merges interception config for that service for the plugins
    below.
- `ctx.provide(name, value)`: registers a service implementation **owned by the current
  fiber**; visible once the fiber activates, revoked (and dependents re-awakened) on unload.
- `Service` base class: `super(ctx, name)` registers as `ctx.<name>`; holds `protected ctx`.
  The subclass instance is the value of that ctx key.
- `ctx.effect(execute, label?)`: `execute` returns a disposer (or a generator, registering
  each item in yield order); the returned disposer is single-use and awaitable. Side-effect
  creation and teardown must live in the same effect to guarantee teardown order. Signature:
  `@deepseek-ai/cordis/lib/types/fiber.d.ts`.

---

## 2. Full ctx table: seam vs core

Role-annotation rule (from the official capability-seams page): **seam = replaceable
capability** (Service Definition + Provider + Consumer designed as one unit); **core = the
single backbone service**; **bundle = composition point**. The left column of the table below
is the subset of the official full table most relevant to this project/backbone (the full
~50 entries are in the official `/reference/capability-seams`).

| ctx key | Role | Declaring package | rc.6 concrete type | Direct consumers | Notes |
|---|---|---|---|---|---|
| `ctx.sessions` | **core** | dsh-session | `SessionStore` (`extends Service`) | agent-loop, agent, session-persistence, query, subagent, invariants | append-only `Session` instances + persistent session event stream |
| `ctx.systemPrompt` | **core** | dsh-system-prompt | `SystemPrompt` | agent-loop, tools, tool-fs/terminal/web | collects prompt fragments per step + model-facing tool schemas |
| `ctx.tools` | **core** | dsh-tools | `ToolRuntime` | agent-loop, the tool-* packages | scoped registry + gated execution pipeline |
| `ctx.agents` | **core** | dsh-agent | `AgentRegistry` | agent-loop, acp, subagent-inprocess | live `Agent` handles, create/resume factory seam, initiator propagation |
| `ctx.agentLoop` | **bundle** | dsh-agent-loop | `AgentLoop` (`implements AgentFactory`) | — (the only concrete loop) | the default product loop; extension packages must not depend on it |
| `ctx.scope` | (no ctx key) | dsh-scope | library: `createScope`/`scopeOf`/`scopeTarget` | session, system-prompt, etc. | registration primitives scoped per agent |
| `ctx.llm` | **seam** | dsh-llm | `LlmRuntime` (abstract `LlmAdapter`) | agent-loop, compaction | message/stream vocabulary + adapter registry |
| `ctx.approval` | **seam** | dsh-user-approval | `ApprovalService` | tools, tool-bash | one-shot permission decisions (`approval/request` waterfall) |
| `ctx.credentials` | **seam** | dsh-credentials | `CredentialProvider` (abstract) | llm adapters, apiproxy | resolves secret references, re-resolved on every operation |
| `ctx.sessionPersistence` | seam | dsh-session-persistence | — | agent-loop, session-query, tool-bash | persistence backend for the same SessionEvent vocabulary |
| `ctx.subprocess` | seam | dsh-subprocess | — | bash, terminal, LSP, subagent | process coordinates, process-tree/session lifecycle, stdio, kill escalation |
| `ctx.shell` | seam | dsh-shell | — | tool-bash, tool-pwsh | model-facing shell execution |
| `ctx.terminals` | seam | dsh-terminal | — | tool-terminal | persistent PTY sessions |
| `ctx.fs` | seam | dsh-fs | — | tool-fs, fs-observation-policy | read/write/edit + sandbox restrictions |
| `ctx.sandbox` | seam | dsh-sandbox | — | bash-sandbox, terminal-bash | wraps spawn's argv, reports enforcement |
| `ctx.jobs` | seam | dsh-jobs | — | tool-jobs, tool-bash/subagent | background-job registration/collection/termination |
| `ctx.subagents` | seam | dsh-subagent | — | tool-subagent, tool-ralph | transport for delegation (one-shot/continuable) |
| `ctx.invariants` | **core** | dsh-invariants | `InvariantRegistry` | session, agent, scope, agent-loop | package-owned runtime invariant registry |

> The precise signatures of this project's touchpoints (rc.6 source line numbers) are in §3,
> §5, §6 and `dsh-core-alignment-audit.md`.

---

## 3. Core packages (packages/core/)

One turn flows through six packages along the same loop: the agent-loop driver claims queued
prompts → opens a turn on `ctx.sessions` → `ctx.systemPrompt` assembles the request prefix and
derives history from the log → the `ctx.llm` seam streams the response → `ctx.tools` dispatches
tool calls → every model-visible fact is appended back to the log.

| Package | Responsibility | ctx key |
|---|---|---|
| session | append-only `SessionEvent` log + in-memory store (single source of truth) | `ctx.sessions` |
| system-prompt | assembles prompt fragments and tool schemas | `ctx.systemPrompt` |
| tools | scoped tool registry + protected execution pipeline | `ctx.tools` |
| agent | the `Agent` interface, live registry, initiator scoping, `agent/*` events | `ctx.agents` |
| agent-loop | the concrete driver implementing the public Agent contract | `ctx.agentLoop` |
| scope | registration-primitive library scoped per agent (**not a service, zero dependencies**) | none |

`scope/` is the only non-service package, sitting beneath session/system-prompt so both can
consume it without creating a cycle.

### 3.1 The precise `ctx.agents` API (rc.6)

Source: `dsh-agent/lib/types/index.d.ts`, `dsh-agent/lib/types/runtime-types.d.ts`.

```ts
// create / resume (index.d.ts)
interface CreateAgentOptions {
  readonly sessionId: SessionId                       // a live agent/session share an identity
  readonly meta?: { cwd?; parentSession?; seedLength?; origin?: 'subagent'; delegationDepth?; agentPreset? }
  readonly seed?: readonly SessionEvent[]             // optional fork replay prefix
  readonly agentOptions?: AgentOptions
  readonly signal?: AbortSignal                       // valid only during creation
  readonly setup?: AgentSetup                          // assembles the agent-scope world before publish
}
interface ResumeAgentOptions { resumeSessionId; agentOptions?; signal?; setup? }
interface AgentHandle { agent: Agent; dispose(): Promise<void> }
// AgentRegistry (Service)
class AgentRegistry {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
  register(agent: Agent): () => void
  get(id: SessionId): Agent | undefined
  list(): Agent[]; roots(): Agent[]
  withInitiator<T>(agent, op: () => T): T; currentInitiator(): Agent | undefined
  setFactory(factory: AgentFactory): () => void
}
```

```ts
// Agent (runtime-types.d.ts) — the program-facing surface
interface Agent {
  readonly id: SessionId
  readonly options: AgentOptions                       // { provider?, model?, maxTokens? }
  readonly session: Session                            // its log = the persistent single source of truth
  readonly inbox: Inbox
  readonly status: AgentStatus                         // 'idle' | 'running'
  readonly ctx: Context                                // the agent-scope context
  cancel(cause: AgentCancelCause, options?: CancelOptions): void
  whenIdle(): Promise<void>
  runMaintenance<T>(task: (signal) => Promise<T>): Promise<T>
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
  followup(message: UserMessage): void                 // independent new turn + wake
  steer(message: UserMessage): void                    // interjection, consumed at the nearest step boundary
  inject(message: UserMessage): void                   // injects context, does not wake
}
// InboxTarget = 'next-turn' | 'next-step'
// PreStepDecision = {kind:'reject'} | {kind:'enter', messages: UserMessage[]}
// RequestErrorAction = {kind:'retry'} | undefined
// SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'
```

**Essentials**:
- `create()`/`resume()` are **async transactions**: first `setup(agentCtx)` (unpublished),
  then insert → announce session → announce agent → `agent/session-start` → only then start
  the loop; a setup rejection, a commit throw, or owner dispose all roll back and publish
  neither id.
- Three delivery presets: `followup` (independent turn), `steer` (nearest step boundary),
  `inject` (does not wake).
- **Output has no callback API**: read `assistant/message` / `turn/end` from the
  `session/event` stream (see §6). `agent/status` (emit) + `agent.status` can drive typing
  indicators.

### 3.2 `ctx.agentLoop` (bundle)

`AgentLoop extends Service implements AgentFactory` (`dsh-agent-loop/lib/types/index.d.ts:102`):
`create(id, options?, meta?)` / `createAgent(ownerCtx, options)` / `resume(ownerCtx, options)`.
It is the factory registered via `ctx.agents.setFactory()`; **consumers program through
`ctx.agents` and never depend on `dsh-agent-loop`**.

### 3.3 `ctx.scope` (library)

`dsh-scope/lib/types/index.d.ts`:
- `type ScopeKey = object` (opaque, compared by identity)
- `type Scoped<T>`: the brand marker on the routing receiver returned by
  `scopeTarget(base, key)`
- `createScope(ctx, key, options?): Scope`, `scopeOf(ctx): ScopeKey | undefined`,
  `scopeTarget<T>(base, key): Scoped<T>`
- scope-filtered events use `Scoped<T>` as the `this` type; the real subject still travels as
  an explicit parameter.

---

## 4. Turn/step lifecycle

A **step** = one model request + the tools it calls. A **turn** = zero or more steps: it
opens before the first input is claimed and closes once no more work is owed.

```
turn/start
  claim next-step input + one queued message
  assemble prompt fragments + tool schemas
  -> agent/pre-step        (waterfall: reject | enter(messages))
  reject / first enter rewritten to empty -> close the turn with zero steps
  step/start
    entered messages appended as user/message
    deriveMessages() derives model history from the log
    agent/request -> llm/stream -> assistant/chunk* -> assistant/message
    tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
  step/end
  tool owes another request or next-step input arrives -> claim -> next step
  -> agent/turn-stopping  (serial, no next())
turn/end
```

- **Persistent session events**: `turn/*`, `step/*`, `user/message`, `assistant/*`, `tool/*`.
- **Realtime extension points** (three domains): `agent/*` (inbox/step/status/request/
  validation/continuation), `tools/*` (capability seam policy/adapters), `llm/stream`.
- `agent/pre-step`, `agent/request`, `llm/stream` and the three `tools/*` are **waterfall**
  (a listener must call `next()` to delegate); `agent/turn-stopping` is **serial** (no
  `next()`).
- Input reaches the driver through the same inbox; `agent/pre-step` decides what the model
  sees.

**`agent/*` events** (`dsh-agent/lib/types/runtime-types.d.ts`):
`agent/created`, `agent/disposed`, `agent/status`, `agent/inbox/inserted|claimed|discarded`,
`agent/session-start` (the above are emit), `agent/pre-step`, `agent/request`,
`agent/request-error` (waterfall), `agent/turn-stopping` (serial), `agent/error` (emit).

---

## 5. Tool execution pipeline

Source: `dsh-tools/lib/types/index.d.ts` (`ToolRuntime`, `ToolDefinition`, `defineTool`,
`tools/*` events).

```ts
class ToolRuntime extends Service {   // ctx.tools
  register(definition: ToolDefinition): () => void
  restrict(filter: ToolRestriction): () => void     // allow/deny global tools within a scope
  guard(guard: ToolGuard): () => void                // monotonic guard (can only deny, never force-allow)
  get(name, scope?): ToolDefinition | undefined
  schemas(scope?): ToolSchema[]
  execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>
}
```

Order: `tools/pre-execute` (waterfall, can `allow | deny | ask`) → **monotonic guard** →
`tools/execute` (waterfall, around-dispatch, timeout/retry/metrics) → tool body →
`tools/post-execute` (waterfall, `accept | block` + optional `additionalContexts`) →
`finalizeContent` (definition-owned, synchronous pure content transform) → lossless snapshot →
`tools/result` (emit, frozen snapshot).

**Approval degradation (the direct basis for this project's R2/A3)**: `ToolRuntime.serviceAsk`
(source `dsh-tools/lib/types/index.d.ts:784-794`) **opportunistically `ctx.get('approval')`** —
when no `ApprovalService` is installed it preserves the historical "degrade to deny", turning
every `ask` into deny; only `allowed-once` passes, and the three non-approving outcomes each
carry a distinct reason. Agentless execution degrades the same way.

**`approval/request` (seam, `dsh-user-approval`)**:
```ts
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
type ApprovalPolicy  = 'ask' | 'never'
interface ApprovalRequest {
  readonly agent: Agent; readonly toolName: string
  readonly callId?: CallId; readonly reason?: string; readonly signal?: AbortSignal
}
// event: 'approval/request'(req, next) => Promise<ApprovalOutcome>   (waterfall)
// audit pair: SessionEventMap extensions 'approval/asked' / 'approval/decided' (log-only)
```
`signal` abort → `'cancelled'` (late answers discarded); no/throwing answerer →
`'unavailable'` (fail-closed); the `'never'` policy rejects in place before dispatch; rogue
non-vocabulary return values are normalized to `'unavailable'`. Source:
`dsh-user-approval/lib/types/index.d.ts` and `types.d.ts`.

### 5.1 Tools belong to the agent preset (agent plane)

In a Web deployment **tools are not global**; instead they are mounted per session by the
preset on the agent plane. Two layers:

- `dsh-base` globally loads `tool-*` (the TUI single session uses them directly);
  `dsh-web-app` sets all of those global tools to **`disabled: true`** and instead mounts
  `dsh-agent-presets` (`default: standard`).
- The `standard` preset (`config/agent-presets/standard/agent.cordis.yml`) is an
  **agent-plane composition**: it re-mounts the full set — `tool-bash`/`tool-fs`/`tool-web`/
  `tool-subagent`/`tool-ralph`/`tool-workflow`/`plan-mode`/`tool-todo`/`tool-ask-user` and
  more — plus persona and skills into every session.

**The join mechanism**: `dsh-agent-presets` provides `mount(agentCtx, id?)` and
`composeFrom(agentCtx, parentCtx)`, which **must be called inside the agent factory's
`setup(agentCtx)`** (a failure rolls back the whole creation). The canonical call site is
`dsh-host-apiproxy`'s `composeAgent`: first `resolve(id)` to get the resolved id → write it
into `meta.agentPreset` (session header, for rebuild on resume) → then, in setup,
`await presets.mount(agentCtx, resolvedId)`.

**Consequences of a missed join**: when an agent is published, `dsh-agent-presets` logs a
warning —

> `agent … was published without joining an agent preset; its tools, prompt sections, and skill catalog resolve against the empty global layer`

An empty global layer ⇒ `request/header.tools` is empty ⇒ the DeepSeek model emits the tools
it wanted to call as `<tool_calls>` XML plain text. **Direct requirement for this project
(channel)**: any channel provider that creates an agent with `ctx.agents.create()` must
resolve + record + mount the preset in order to inherit the host's default capabilities; with
no roster (`ctx.get('agentPresets')` empty) it degrades to the host's global layer.

---

## 6. Session log and SessionEventMap

Source: `dsh-session/lib/types/types.d.ts`, `dsh-session/lib/types/index.d.ts`.

- `Session`: an **append-only log** of typed `SessionEvent`s (single source of truth).
  `deriveMessages()` projects the LLM message history from it — history is not stored
  separately.
- The envelope (rc.6): **a union discriminated by `type`**, not a separate `type`/`data`
  union:
  ```ts
  type SessionEvent<T = SessionEventType> = {
    [K in SessionEventType]: {
      type: K; seq: number; time: number; data: SessionEventMap[K]; ignorable?: true
    } & (K extends SurfaceEventType ? { sourceEventSeqs?: number[]; surfaceOp?: SurfaceOp } : object)
  }[T]
  ```
- `SessionEventType = keyof SessionEventMap`; plugins extend it via merging through
  **`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { … } }`**
  (`dsh-user-approval`'s `approval/asked|decided|policy` is the ready-made example).
- `SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result'` — **only these
  three can carry `surfaceOp`/`sourceEventSeqs`, and only they derive model history**.
- rc.6's `SessionEventMap` variants (dsh-session): `turn/start`, `turn/end`, `step/start`,
  `step/end`, `user/message`, `assistant/chunk`, `assistant/message`, `tool/call`,
  `tool/result`, `todo/write`, `request/header`, `request/context`, `session/end-seed`.
  Extensions: `agent/inbox/spliced` (dsh-agent), `approval/asked|decided|policy`
  (dsh-user-approval).
  > The master docs also list `steering/message`, which rc.6 **does not have**; in rc.6,
  > steering/injection lands in the inbox and, once claimed, is logged as `user/message`
  > (distinguished by `source`).

- `ctx.sessions` (`SessionStore extends Service`, `index.d.ts:290`):
  `create(id?, options?)` / `prepare` + `enter` + `announce` (for ordered composite effects) /
  `get(id)` / `list()` / `fork(source, boundary?, childSessionId?)` / `flush(session)`.
  - `fork` rejection codes (`SessionForkErrorCode`): `SESSION_NOT_FOUND` / `SESSION_NOT_LIVE` /
    `SESSION_ALREADY_EXISTS` / `INVALID_BOUNDARY` / `OPEN_TURN`.
- `session/event` (`index.d.ts:66`): **emit, post-commit, fire-and-forget**;
  `(this: Scoped<Session>, session, event)`; observer failures are contained and do not
  affect the already-committed append.
- `session/flush` (`index.d.ts:75`): **parallel** persistence checkpoint (no veto).
- `TurnEndReasonMap` (`types.d.ts:135`): `completed | aborted(reason) | blocked |
  error(error) | max-tokens | interrupted`.

---

## 7. Repo-wide common type patterns

### 7.1 `…Map → derived-union` (declaration-merging extension)

```ts
interface ThingMap { 'a': { kind: 'a' }; 'b': { kind: 'b' } }
type Thing = ThingMap[keyof ThingMap]           // discriminated union
declare module '@deepseek-ai/dsh-llm' { interface ThingMap { 'c': { kind: 'c' } } }
```

The canonical maps in rc.6 (this project will extend `MessageSourceMap`):
- dsh-llm: `ContentBlockMap`, `MessageSourceMap`, `FinishReasonMap` (plus `ModelModalityMap`)
- dsh-session: `TurnEndReasonMap`, `SessionEventMap`

Consumers switch over two big discriminated unions: `StreamChunk` (the stream protocol) and
`SessionEvent` (the log entry). **By convention, switch on the tag and never use chained
ifs** — a mistyped tag fails to compile.

`MessageSourceMap` (`dsh-llm/lib/types/message.d.ts:94`) as it stands:
`user | plugin | model | tool`; `MessageSource = MessageSourceMap[keyof MessageSourceMap]`.
Adding a `channel` variant in this project aligns with this extension point (see design
§3.1).

### 7.2 Branded id

The `Branded<B>` primitive lives in the pure-type package `dsh-brand` (zero runtime, zero
dependencies). Structurally a string, but not interchangeable at the type level. Core ids:
`SessionId` (dsh-session), `CallId` (dsh-llm), plus `CredentialRef` (dsh-credentials),
`ApprovalRequestId` (dsh-user-approval), `MessageId`/`ProviderRequestId` (dsh-llm).

---

## 8. Alignment check against this project's design

The **item-by-item check** of `dsh-channel-design.md` §1.1/§1.2 and R1–R10 (now design §6) —
each entry with its rc.6 source line numbers — is in `dsh-core-alignment-audit.md`.

Summary conclusion:
- **The `ChannelRegistry`(core) + `Channel` (plain abstract-class seam) split, the mapping to
  `ctx.llm`/`LlmAdapter`, the degradation semantics of `approval/request`,
  `ctx.credentials.resolve`, `ctx.sessions.fork`, the `session/event` and `SessionEventMap`
  extension points — all align word-for-word with the rc.6 source.**
- Two spots need correction/refinement: `SessionEvent` is **a union discriminated by type**
  (only surface events carry `surfaceOp`/`sourceEventSeqs`); `registerAdapter` returns a
  handle that is a **callable disposer + `.replace()`** (not a `{ dispose }` object). See the
  audit document for details.
