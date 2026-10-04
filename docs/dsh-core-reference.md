# DSH Core and Capability Seams Reference (Aligned to `@deepseek-ai/*@0.2.0-rc.2`)

> This document records the DeepSeek Harness (dsh) core architecture and capability seams as
> the **single alignment baseline** for this repository (`dsh-channel`). It was written by
> cross-checking, item by item, the official reference documentation
> (https://deepseek-harness.github.io/deepseek-harness/reference/ ) **and the 0.2.0-rc.2
> compiled type declarations and runtime sources**. Where a claim could not be verified from
> 0.2.0-rc.2 sources it is called out in place — do not write code directly from symbols that
> only exist in the master docs.

- This project's `package.json` devDependencies are pinned to `^0.2.0-rc.2`; the runtime
  harness also runs on 0.2.0-rc.2. **Code takes 0.2.0-rc.2 as authoritative**; the docs serve
  only as semantic reference.
- Verification sources, in descending order of preference: the installed
  `node_modules/@deepseek-ai/*/lib/types/*.d.ts` (plus `lib/*.js` for behavior) for the
  packages this repo dev-depends on (cordis 4.0.4, dsh-agent, dsh-llm, dsh-session,
  dsh-system-prompt, dsh-user-approval, dsh-credentials, dsh-credentials-local, and their
  transitive dependencies); the published 0.2.0-rc.2 npm tarballs for packages this repo does
  not install (dsh-tools, dsh-agent-loop, dsh-session-persistence, dsh-session-query,
  dsh-user-questions, dsh-agent-preset-registry, dsh-settings, dsh-config-editor,
  dsh-plugin-manager, dsh-webhook, dsh-http-proxy, dsh-web-app, dsh-app-boot, the `dsh` CLI).

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
8. [Alignment check against this project's design](#8-alignment-check-against-this-projects-design) — summary (the item-by-item audit lives in git history)

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

| ctx key | Role | Declaring package | 0.2.0-rc.2 concrete type | Direct consumers | Notes |
|---|---|---|---|---|---|
| `ctx.sessions` | **core** | dsh-session | `SessionStore` (`extends Service`) | agent-loop, agent, session-persistence, query, subagent, invariants | append-only `Session` instances + persistent session event stream |
| `ctx.systemPrompt` | **core** | dsh-system-prompt | `SystemPrompt` | agent-loop, tools, tool-fs/terminal/web | collects prompt fragments per step + model-facing tool schemas |
| `ctx.tools` | **core** | dsh-tools | `ToolRuntime` | agent-loop, the tool-* packages | scoped registry + gated execution pipeline |
| `ctx.agents` | **core** | dsh-agent | `AgentRegistry` | agent-loop, acp, subagent-inprocess | live `Agent` handles, create/resume factory seam, initiator propagation |
| `ctx.agentLoop` | **bundle** | dsh-agent-loop | `AgentLoop` (`implements AgentFactory`) | — (the only concrete loop) | the default product loop; extension packages must not depend on it |
| `ctx.scope` | (no ctx key) | dsh-scope | library: `createScope`/`scopeOf`/`scopeTarget` | session, system-prompt, etc. | registration primitives scoped per agent |
| `ctx.llm` | **seam** | dsh-llm | `LlmRuntime` (abstract `LlmAdapter`) | agent-loop, compaction | message/stream vocabulary + adapter registry; 0.2: `LlmRuntime extends TypertRemoteService` |
| `ctx.approval` | **seam** | dsh-user-approval | `ApprovalService` | tools, tool-bash | one-shot permission decisions (`approval/request` waterfall) |
| `ctx.userQuestions` | **seam** | dsh-user-questions | `UserQuestionService` | tool-ask-user, UI answerers | 0.2: agent-scoped `user-questions/request` waterfall (the rc.6 global single-slot `registerProvider` is gone) |
| `ctx.credentials` | **seam** | dsh-credentials | `CredentialProvider` (abstract) | llm adapters | resolves secret references, re-resolved on every operation |
| `ctx.sessionPersistence` | seam | dsh-session-persistence | `SessionPersistence` (abstract) | agent-loop, session-query, workspace | handle-based durable store: `create`/`open(read\|write)`/`stat`/`list`/`flush`; single-writer ownership (`SessionAlreadyOwnedError`) |
| `ctx.sessionQuery` | seam | dsh-session-query | `SessionQueryEngine` (abstract) | web UI, tools | 0.2: reads persisted sessions **without resuming them** (`listSessions`/`readSession`/`readEvent`/`listEvents`/`readSurface`/`observeSession`/`traceSession`) |
| `ctx.agentPresets` | seam | dsh-agent-preset-registry | `AgentPresetRegistry` | web-app, hosts composing per session | 0.2 successor of rc.6 `dsh-agent-presets`: YAML-declared preset rows, `resolve`/`mount`/`composeFrom`/`select` |
| `ctx.settings` | seam | dsh-settings | `SettingsForms` | config UIs | 0.2 settings model: schema-derived forms over plugin-entry config (see §2.1) |
| `ctx.subprocess` | seam | dsh-subprocess | — | bash, terminal, LSP, subagent | process coordinates, process-tree/session lifecycle, stdio, kill escalation |
| `ctx.shell` | seam | dsh-shell | — | tool-bash, tool-pwsh | model-facing shell execution |
| `ctx.terminals` | seam | dsh-terminal | — | tool-terminal | persistent PTY sessions |
| `ctx.fs` | seam | dsh-fs | — | tool-fs, fs-observation-policy | read/write/edit + sandbox restrictions |
| `ctx.sandbox` | seam | dsh-sandbox | — | bash-sandbox, terminal-bash | wraps spawn's argv, reports enforcement |
| `ctx.jobs` | seam | dsh-jobs | — | tool-jobs, tool-bash/subagent | background-job registration/collection/termination |
| `ctx.subagents` | seam | dsh-subagent | — | tool-subagent, tool-ralph | transport for delegation (one-shot/continuable) |
| `ctx.invariants` | **core** | dsh-invariants | `InvariantRegistry` | session, agent, scope, agent-loop | package-owned runtime invariant registry |

> The precise signatures of this project's touchpoints (0.2.0-rc.2 sources) are in §3,
> §5 and §6. Rows whose declaring package this repo does not install (tools, subprocess,
> shell, terminal, fs, sandbox, jobs, subagent) were re-checked against the published
> 0.2.0-rc.2 npm tarballs where this document quotes an API, and otherwise carry only the
> role/description from the official table.

### 2.1 What 0.2 changes operationally (facts this repo must respect)

- **Plugin configuration IS the plugin entry's `config:`** in the profile's
  `cordis.patch.yml`. The rc.6 `dsh-settings` exports `installSettingsSection` /
  `settingsNamespace()` are gone; 0.2 `dsh-settings` is `ctx.settings` (`SettingsForms`:
  schema-derived `describe`/`update`/`replace`/`mutate` forms over live plugin entries,
  plus a one-time import of a legacy `settings.yaml` — a section the running composition
  rejects stays in the renamed file). Inside a Config schema, a field wrapped in
  schemastery `.volatile()` hot-updates in place (volatile-only config changes are committed
  into the running fiber by the Loader; the plugin reads the current value via `.get()` on
  the volatile wrapper); changing any non-volatile field restarts the plugin. Source:
  `dsh-settings/lib/types/index.d.ts`, `schemastery/lib/types/index.d.ts` (`volatile()`),
  `cordis-plugin-loader/lib/index.js` (`equalExceptVolatile`/`_commitVolatile`).
- **Plugin loading enforces peer ranges.** At startup each plugin's `@deepseek-ai/dsh*`
  peerDependencies are checked with `semver.satisfies(runtimeVersion, range,
  { includePrerelease: true })`; a mismatched plugin row is set `disabled: true` and a
  mismatched bundle is skipped, with an exact-version exemption path (`dsh plugin
  allow-version` / the plugin manager). Installing a bundle enables it by default (a bundle
  the user explicitly disabled stays disabled).
  Source: `dsh-app-boot/lib/index.js` (peer audit), `dsh-plugin-manager` README
  ("Installation enables a new bundle by default").
- **Credentials file migration is one-way.** `dsh-credentials-local` rewrites
  `$DSH_HOME/.credentials.yaml` in place on first 0.2 boot from the pre-release flat layout
  to `version: 1` + `refs:`/`records:`; pre-0.2 runtimes expect the flat layout and cannot
  use the migrated file. There is **no `dsh credentials set` CLI** in 0.2 — the `dsh` CLI has
  only the profile-boot action and `dsh plugin` (forwards to pnpm); a stray first token is
  parsed as a profile name. Keys are set through the configuration UI (which calls
  `ctx.credentials.set`), plain environment variables, or `.env` files. The
  `ctx.credentials` seam itself (`credentialRef`/`resolve`/`describe`/`set`/`unset`, plus
  record operations) is unchanged. Source: `dsh-credentials-local/lib/index.js`
  (`renderFlatLayoutMigration`/`migrateFlatDocument`), `dsh/lib/bin.js`.
- **New optional 0.2 packages**: `dsh-session-query` and `dsh-session-projection`
  (`ctx.sessionProjections`) for cold reads/projections; `dsh-agent-preset-registry` (§5.1);
  `dsh-config-editor` (`ctx.configEditor.edit()` persists full config through profile
  patches) and `dsh-plugin-manager` (`ctx.pluginManager`, bundle/plugin enablement);
  `dsh-webhook` (`ctx.webhookRuntime`: trusted inbound rules that create sessions — inbound
  only, no reply path); `dsh-http-proxy` (the launcher installs one global outbound proxy
  policy from `HTTPS_PROXY` et al. when no explicit proxy is configured).
- **`dsh-web-app` opens the browser by default** in 0.2 (`--host` / `--port` /
  `--trusted-host` / `--no-open`; `--host 0.0.0.0` is deliberately refused).
- **Types-only dependency**: `dsh-llm`'s published type declarations import
  `@deepseek-ai/dsh-attachment`, so a package that typechecks against `dsh-llm` needs
  `dsh-attachment` resolvable (it is a `devDependency` of `dsh-llm`, not auto-installed).

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

### 3.1 The precise `ctx.agents` API (0.2.0-rc.2)

Source: `dsh-agent/lib/types/index.d.ts`, `dsh-agent/lib/types/runtime-types.d.ts`.

```ts
// create / resume (index.d.ts)
interface CreateAgentOptions {
  readonly sessionId: SessionId                       // a live agent/session share an identity
  readonly parentAgent?: Agent                        // live runtime owner; omit for a root agent
  readonly meta?: { cwd?; parentSession?; isSeeded?; origin?: 'subagent'; delegationDepth?; agentPreset? }
  readonly inheritedEventCount?: SessionLogOffset     // exact fork prefix length when meta.isSeeded
  readonly seed?: readonly SessionEvent[]             // optional fork replay prefix
  readonly agentOptions?: AgentOptions
  readonly signal?: AbortSignal                       // valid only during creation
  readonly setup?: AgentSetup                          // assembles the agent-scope world before publish
}
interface ResumeAgentOptions { resumeSessionId; parentAgent?; agentOptions?; signal?; setup? }
interface AgentHandle { agent: Agent; dispose(): Promise<void> }
// AgentSetup = (agentCtx: Context, agent: Agent) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void
//   (0.2: the setup callback also receives the unpublished Agent and may return a synchronous
//    commit() the factory invokes immediately before publication)
// AgentRegistry (Service)
class AgentRegistry {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
  register(agent: Agent): ReturnType<Context['effect']>   // records an already-constructed agent
  enter(agent, owner): () => void; announce(agent, source, signal?): Promise<void>  // factory primitives
  get(id: SessionId): Agent | undefined
  list(): Agent[]; roots(): Agent[]; isOwnedBy(id, owner): boolean
  withInitiator<T>(agent, op: () => T): T; currentInitiator(): Agent | undefined
  requireInitiator(): Agent; withoutInitiator<T>(op: () => T): T
  setFactory(factory: AgentFactory): () => void
}
```

```ts
// Agent (runtime-types.d.ts + types.d.ts) — the program-facing surface
interface Agent {
  readonly id: SessionId
  readonly options: AgentOptions  // { provider?, model?, reasoningEffort?, maxTokens? }
  readonly session: Session                            // its log = the persistent single source of truth
  readonly inbox: Inbox             // nextTurn/nextStep + append/prepend/replace/remove/splice/clear
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
// PreStepDecision = {kind:'reject'} | {kind:'enter', messages: UserMessage[], startsRequestSeries?: true}
// RequestErrorAction = {kind:'retry'} | undefined
// SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'
```

**Essentials**:
- `create()`/`resume()` are **async transactions**: first `setup(agentCtx, agent)`
  (unpublished), then the optional `commit()`, then insert → announce session → announce
  agent → the **serial** `agent/created` dispatch (carrying `source: SessionStartSource`) →
  only then start the loop; a setup rejection, a commit throw, or owner dispose all roll back
  and publish neither id. `resume()` requires `ctx.sessionPersistence` (the factory opens the
  stored log for write, reads and repairs it, then runs the same publication transaction).
- Three delivery presets: `followup` (independent turn), `steer` (nearest step boundary),
  `inject` (does not wake).
- **Output has no callback API**: read `assistant/message` / `turn/end` from the
  `session/event` stream (see §6); live streaming deltas are the process-local, agent-scoped
  `agent/assistant-stream` event (see §4). `agent/status` (emit) + `agent.status` can drive
  typing indicators.

### 3.2 `ctx.agentLoop` (bundle)

`AgentLoop extends Service implements AgentFactory` (`dsh-agent-loop/lib/types/index.d.ts:99`):
`create(id, options?, meta?: Pick<SessionHeader, 'cwd'>)` / `createAgent(ownerCtx, options)` /
`resume(ownerCtx, options)`.
It is the factory registered via `ctx.agents.setFactory()`; **consumers program through
`ctx.agents` and never depend on `dsh-agent-loop`**.

### 3.3 `ctx.scope` (library)

`dsh-scope/lib/types/index.d.ts`:
- `type ScopeKey = object` (opaque, compared by identity)
- `type Scoped<T>`: the brand marker on the routing receiver returned by
  `scopeTarget(base, key)`
- `createScope(ctx, key, options?): Scope`, `scopeOf(ctx): ScopeKey | undefined`,
  `scopeTarget<T>(base, key): Scoped<T>`
- 0.2 additions: `bindScopeParent(key, parent)` / `scopeParentOf(key)` / `scopeChainOf(key)`
  (scope lineage, used by preset mounting), `isScopeCarrier(value)`, `carrierKeyOf(value)`
- scope-filtered events use `Scoped<T>` as the `this` type; the real subject still travels as
  an explicit parameter. Scope-filtered dispatch (declared per event, see §4/§5/§6): an
  agent-scoped listener receives only its own agent's events; a root listener receives all.

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
    system/message committed as surface node 0; entered messages appended as user/message
    deriveMessages() derives model history from the surface over the log
    agent/request -> llm/stream -> agent/assistant-stream frames -> assistant/message | assistant/attempt
    tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
  step/end
  tool owes another request or next-step input arrives -> claim -> next step
  -> agent/turn-stopping  (serial, no next())
turn/end
```

- **Persistent session events**: `turn/*`, `step/*`, `system/message`, `developer/message`,
  `user/message`, `assistant/*`, `tool/*` (see §6 for the full 0.2 vocabulary).
- **Realtime extension points** (three domains): `agent/*` (inbox/step/status/request/
  validation/continuation, plus the 0.2 `agent/assistant-stream` live-delta feed),
  `tools/*` (capability seam policy/adapters), `llm/stream`.
- `agent/pre-step`, `agent/request`, `llm/stream` and the three `tools/*` are **waterfall**
  (a listener must call `next()` to delegate); `agent/created` and `agent/turn-stopping` are
  **serial** (no `next()`).
- Input reaches the driver through the same inbox; `agent/pre-step` decides what the model
  sees.

**`agent/*` events** (`dsh-agent/lib/types/runtime-types.d.ts`):
`agent/created` (**serial** since 0.2; payload `{agent, source: SessionStartSource, signal?}`
— it subsumes rc.6's `agent/session-start`, which no longer exists), `agent/disposed`,
`agent/status`, `agent/inbox/inserted|claimed|discarded` (emit), `agent/pre-step`,
`agent/request`, `agent/request-error` (waterfall), `agent/assistant-stream` (emit),
`agent/turn-stopping` (serial), `agent/error` (emit). All are scope-filtered via dsh-scope:
an agent-scoped listener receives only its own agent.

**`agent/assistant-stream`** (0.2, replacing the removed `assistant/chunk` log event):
process-local, fire-and-forget; payload `{agent, frame}` where `frame` is
`{type:'start', attemptId, revision, turn, step}` | `{type:'chunk', attemptId, revision,
index, time, chunk: StreamChunk}` (the dsh-llm stream vocabulary: `text-delta`,
`reasoning-delta`, …) | `{type:'end', attemptId, revision, index, outcome}` with
`outcome = {kind:'committed', eventType:'assistant/message'|'assistant/attempt',
seq: SessionSeq} | {kind:'abandoned'}`. Chunk frames are transient; the durable record is the
final `assistant/message` (which embeds the exact `stream: AssistantStreamRecord[]`) or
`assistant/attempt`, committed before the `end` frame.

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
(source `dsh-tools/lib/types/index.d.ts:818-828` in the 0.2.0-rc.2 tarball)
**opportunistically `ctx.get('approval')`** —
when no `ApprovalService` is installed it preserves the historical "degrade to deny", turning
every `ask` into deny; only `allowed-once` passes, and the three non-approving outcomes each
carry a distinct reason. Agentless execution degrades the same way.

**`approval/request` (seam, `dsh-user-approval`)**:
```ts
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
type ApprovalPolicy  = 'ask' | 'never'
interface ApprovalRequest {   // extends ApprovalRequestEvent
  readonly agent: Agent; readonly toolName: string
  readonly callId?: ToolCallId; readonly reason?: string; readonly signal?: AbortSignal
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  // ^ 0.2 addition: localized presentation only, never persisted in the audit events
}
// event: 'approval/request'(req, next) => Promise<ApprovalOutcome>   (waterfall,
//   scope-filtered: agent-scoped listeners receive only their own agent's requests)
// audit: SessionEventMap extensions 'approval/asked' / 'approval/decided' (log-only pair)
//   plus 'approval/policy' (the session's durable policy override)
```
`signal` abort → `'cancelled'` (late answers discarded); no/throwing answerer →
`'unavailable'` (fail-closed); the `'never'` policy rejects in place before dispatch; rogue
non-vocabulary return values are normalized to `'unavailable'`. Source:
`dsh-user-approval/lib/types/index.d.ts` and `types.d.ts`.

**`user-questions/request` (seam, `dsh-user-questions`, 0.2)**: the rc.6 global single-slot
`registerProvider` is gone; 0.2 is an agent-scoped waterfall:
```ts
// event: 'user-questions/request'(request, next) => Promise<AskUserQuestionAnswer>  (waterfall,
//   scope-filtered: an agent-scoped answerer only sees its own agent's questions)
// AskUserQuestionAnswer = { answers: { id; selected: string[]; custom?: string }[] }
//   — an empty `selected` with no `custom` records that the user skipped the question
```
`ctx.userQuestions.ask(request)` validates and dispatches it. Failures reject with
`UserQuestionError` (a `HarnessError`): `ASK_ABORTED` (signal aborted), `CALLER_NOT_LIVE`
(the supplied agent is not the registry's exact live instance), `DELEGATED_CALLER` (the
caller is owned by another live agent — human interaction is root-only), `NO_PROVIDER`
(no answerer accepted — the waterfall's built-in tail rejects), `EMPTY_QUESTIONS`,
`BAD_INTENT` (e.g. a `plan-review` intent whose `approve` label names no option).
`askTimed(request, callId, timeoutMs)` adds a foreground wait window whose timeout surfaces
as `ASK_TIMED_OUT`. Source: `dsh-user-questions/lib/types/index.d.ts`, `types.d.ts`,
`lib/index.js` (0.2.0-rc.2 tarball). This project's bridge registers its answerer on the
agent scope inside `setup()` (§3.1), so channel agents' questions route to the chat even when
a web UI is composed in the same process.

### 5.1 Tools belong to the agent preset (agent plane)

In a Web deployment **tools are not global**; instead they are mounted per session by the
preset on the agent plane. Two layers:

- `dsh-base` mounts the per-agent `tool-*` rows process-wide (the TUI single session uses
  them directly); `dsh-web-app`'s patch disables those process-wide rows and instead mounts
  `dsh-agent-preset-registry` (`ctx.agentPresets`, `config.default: standard`) — "the preset
  roster takes over" (dsh-web-app README, 0.2.0-rc.2).
- Presets are **declared as ordinary plugin rows** of `@deepseek-ai/dsh-agent-preset`
  (`config: { id, plugins: [...] }`); the shipped web presets (`standard`, `ptc`, `minimal`,
  `cordis`) are one `presets/<id>.patch.yml` insert each inside the web bundle. The registry
  "neither scans directories nor accepts preset paths" — rc.6's directory-form presets
  (`config/agent-presets/standard/agent.cordis.yml`) are gone. The `standard` preset remains
  an **agent-plane composition**: the full tool set (`tool-bash`/`tool-fs`/`tool-web`/
  `tool-subagent`/…) plus persona and skills, mounted into every session bound to it.

**The join mechanism** (`dsh-agent-preset-registry/lib/types/index.d.ts`):
`ctx.agentPresets.resolve(id?)` resolves an explicit id or the configured default and
**throws a `RemoteError` named `agent-preset/not-found` for unknown ids**; the resolved id is
written into `CreateAgentOptions.meta.agentPreset` (the session header, see §6); then, inside
the factory's `setup(agentCtx, agent)`, `await ctx.agentPresets.mount(agentCtx, resolvedId)`
binds the unpublished agent to the current preset revision (a mount failure is final and
rolls back the whole creation). `composeFrom(agentCtx, parentCtx)` joins a child to the exact
revision its parent retained. Also on the registry: `composedPreset(ctx)`, `serviceFor(agent,
name)`, `recompose(ctx, id)` (rebind a blank agent), `select(agent, id)` (pre-first-turn
switch, logged as `agent-preset/selected`), `acquireScope(id?)`, `list()` /
`compositionInventory()` for inventories, and the volatile `selectedDefault` config field for
the user's chosen default.

**Durability rule**: the frozen header `agentPreset` is the creation-time value; a switch
made while the session was still blank is recorded as a log-only `agent-preset/selected`
event, and reconstruction "reads the `agentPreset` Session projection, never the header
alone" (`dsh-agent-preset-registry/lib/types/session.d.ts`). Recovery after restart uses the
recorded id's **current** definition and rejects a missing definition.

**Consequences of a missed join**: an agent published without `mount()` resolves its tools,
prompt sections, and skill catalog against the global layer only (in a web composition that
layer is deliberately emptied). rc.6's `dsh-agent-presets` logged a warning on this path; no
equivalent warning text is present in the 0.2.0-rc.2 `dsh-agent-preset-registry` sources, so
the failure is silent and shows up as an empty `request/header.tools` — the DeepSeek model
then emits the tools it wanted to call as `<tool_calls>` XML plain text. **Direct requirement
for this project (channel)**: a channel provider that creates an agent with
`ctx.agents.create()` must resolve + record + mount the preset to inherit the host's default
capabilities (the bridge resolves the id from the session header with a config fallback and
mounts it inside `setup()`); with no roster (`ctx.get('agentPresets')` empty) it degrades to
the host's global layer.

---

## 6. Session log and SessionEventMap

Source: `dsh-session/lib/types/types.d.ts`, `dsh-session/lib/types/index.d.ts` (0.2.0-rc.2).

- `Session`: an **append-only log** of typed `SessionEvent`s (single source of truth).
  `deriveMessages()` projects the LLM message history from the **ordered surface** over the
  log (every message-producing event records its `surfaceOp`); history is not stored
  separately. The format version is `SESSION_FORMAT_VERSION = 4`
  (`types.d.ts:54`); historical generations are migrated by the persistence provider before a
  handle is returned — the shipped JSONL backend streams old generations through its format
  stages keeping a sequence-remap table (seq numbers are re-numbered), and a log containing
  an event type unknown to the build is refused fail-closed unless the event is marked
  `ignorable` (the `KNOWN_SESSION_EVENT_TYPES` catalog).
- The envelope: **a union discriminated by `type`**, not a separate `type`/`data` union.
  0.2: `seq` is the branded `SessionSeq`, and non-surface events carry `surfaceOp?: never` /
  `sourceEventSeqs?: never` (the compiler enforces the split):
  ```ts
  type SessionEvent<T = SessionEventType> = {
    [K in SessionEventType]: {
      type: K; seq: SessionSeq; time: number; data: SessionEventMap[K]; ignorable?: true
    } & (K extends SurfaceEventType ? SurfaceIntent<K> : { surfaceOp?: never; sourceEventSeqs?: never })
  }[T]
  // SurfaceIntent = { surfaceOp: 'append' | { op:'replace', startSeq, endSeq } } — required on
  // surface events; 'replace' (compaction) shadows a surface range, whose seqs must be cited
  // in sourceEventSeqs (assistant/message embeds its stream instead: sourceEventSeqs?: never)
  ```
- `SessionEventType = keyof SessionEventMap`; plugins extend it via merging through
  **`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { … } }`**
  (`dsh-user-approval`'s `approval/asked|decided|policy` is the ready-made example).
- `SurfaceEventType = 'system/message' | 'developer/message' | 'user/message' |
  'assistant/message' | 'tool/result'` — 0.2 added `system/message` (the rendered system
  prompt is surface node 0) and `developer/message` (incremental tool additions/removals);
  only these five produce LLM messages and carry surface metadata.
- 0.2's `SessionEventMap` variants (dsh-session): `turn/start`, `turn/end`, `step/start`,
  `step/end`, `user/message`, `system/message`, `developer/message`, `assistant/message`
  (carries `stream: AssistantStreamRecord[]`, optional `usage`, optional `interrupted: true`),
  `assistant/attempt` (a settled attempt that committed no surface message), `tool/call`,
  `tool/result` (message + optional `error` identity + tool-private `meta`), 
  `request/header` (+ `reason`, `startsSeries?`), `request/context`, `session/end-seed`.
  **`assistant/chunk` is removed** (live deltas moved to the process-local
  `agent/assistant-stream` event, §4); `todo/write` moved out of core to its owning tool
  plugin. Extensions seen in the 0.2 build catalog include `agent/inbox/spliced` (dsh-agent),
  `approval/asked|decided|policy` (dsh-user-approval), `agent-preset/selected`
  (dsh-agent-preset-registry), `compaction/*`, `hook/*`, and more — see
  `KNOWN_SESSION_EVENT_TYPES` for the full list.
- **`Session.events` is removed.** The synchronous reads `session.snapshotEvents(fromSeq?,
  toSeqExclusive?)`, `session.eventAt(seq)`, and `session.ownEvents()` still exist but are
  all **`@deprecated` — "new calls are prohibited"** (dsh-internal policy; existing logic may
  remain unmigrated). This project's bridge currently reads history through
  `snapshotEvents()`/`eventAt()` under that allowance; the 0.2 replacement for reads that do
  not resume the session is the optional `ctx.sessionQuery` seam (`dsh-session-query`:
  `listSessions` / `readSession` / `readEvent` / `listEvents` / `readSurface` /
  `observeSession` / `traceSession`, live-preferred, detached clones), and live work should
  prefer the `session/event` feed and the `Session.surface` projection. New on `Session`:
  `header`, `inheritedEventCount`, `firstLiveSeq`, `firstLifecycleSeq`, `surface`,
  `requestHeader()`, `requestContext()`, `toolHistory()`, `deriveEventMessage()`.
- `ctx.sessions` (`SessionStore extends Service`, `index.d.ts:334`):
  `create(id?, options?)` / `prepare` + `enter` + `announce` (for ordered composite effects) /
  `get(id)` / `list()` / `fork(source, boundary?, childSessionId?)` / `flush(session)` /
  `registerMessageProjection(projection)`.
  - `fork` rejection codes (`SessionForkErrorCode`): `SESSION_NOT_FOUND` / `SESSION_NOT_LIVE` /
    `SESSION_ALREADY_EXISTS` / `INVALID_BOUNDARY`. **rc.6's `OPEN_TURN` is gone**: forking
    through an open tail now appends synthetic tool results and step/turn closers with the
    `forked` cause into the child seed instead of rejecting (`buildForkSeed`).
  - `create`/`prepare` validate `meta.cwd` as an absolute path and throw otherwise.
  - New emit events `session/created` (a synchronous throw vetoes and rolls back) and
    `session/disposed`.
- `session/event` (`index.d.ts:64`): **emit, post-commit, fire-and-forget**;
  `(this: Scoped<Session>, session, event)`; observer failures are contained and do not
  affect the already-committed append; scope-filtered (agent-scoped listeners receive only
  their own agent's session).
- `session/flush` (`index.d.ts:73`): **parallel** persistence checkpoint (no veto); dispatch
  through `ctx.sessions.flush(session)`, which rejects with the first listener failure after
  all settle.
- `TurnEndReasonMap` (`types.d.ts:165`): `completed | aborted(reason) | blocked |
  error(error) | max-tokens | interrupted | forked`. 0.2 notes: `aborted.reason` is a
  `TurnEndCancelCause` (`AgentCancelCause | {kind:'legacy'}`); `interrupted` is appended by
  agent-loop resume repair for a crash-orphaned turn (and synthesized by session-query on
  cold reads) — the loop never emits it live; **`forked`** closes a turn left open at the
  fork boundary and appears **only in fork seeds, never live**. A turn cancelled mid-stream
  commits its delivered prefix as `assistant/message` with `interrupted: true`
  (`types.d.ts:325-337`).
- `SessionHeader` (`types.d.ts:58`): `version`, `id`, `createdAt`, `cwd?`, `parentSession?`,
  `isSeeded`, `origin?: 'subagent'`, `delegationDepth?`, and **`agentPreset?`** — the preset
  the session's agent was composed from, durable because the preset decides the session's
  tools and prompt (§5.1).

---

## 7. Repo-wide common type patterns

### 7.1 `…Map → derived-union` (declaration-merging extension)

```ts
interface ThingMap { 'a': { kind: 'a' }; 'b': { kind: 'b' } }
type Thing = ThingMap[keyof ThingMap]           // discriminated union
declare module '@deepseek-ai/dsh-llm' { interface ThingMap { 'c': { kind: 'c' } } }
```

The canonical maps in 0.2.0-rc.2 (this project extends `MessageSourceMap`):
- dsh-llm: `ContentBlockMap`, `MessageSourceMap`, `FinishReasonMap` (plus `ModelModalityMap`)
- dsh-session: `TurnEndReasonMap`, `SessionEventMap`

Consumers switch over two big discriminated unions: `StreamChunk` (the stream protocol) and
`SessionEvent` (the log entry). **By convention, switch on the tag and never use chained
ifs** — a mistyped tag fails to compile.

`MessageSourceMap` (`dsh-llm/lib/types/message.d.ts:101`) as it stands:
`user | model | tool | system-prompt`; `MessageSource = MessageSourceMap[keyof
MessageSourceMap]`. **0.2 removed the rc.6 catch-all `plugin` kind** — "each producer
declares its own `kind` in its own module; there is no shared catch-all `plugin` kind" —
which is exactly the extension mechanism this project's `channel` variant uses (see design
§3.1). Producers may additionally declare a `ContextForm` (`instructions | catalog |
snapshot | notice | relay | recall`) mixed into their source.

`ToolResultMessage` (0.2 shape, `message.d.ts:153`): a first-class `role: 'tool'` message
with a **top-level `toolCallId: ToolCallId`**, `source: { kind: 'tool', callId }`, and
optional `isError` — the rc.6 "toolCallId inside `content[0]`" shape is gone. Construct one
with `createToolResultMessage({ callId, content, isError })`; `createUserMessage` and image
blocks are unchanged.

### 7.2 Branded id

The `Branded<B>` primitive lives in the pure-type package `dsh-brand` (zero runtime, zero
dependencies). Structurally a string, but not interchangeable at the type level. Core ids:
`SessionId` (dsh-session), **`ToolCallId`** (dsh-llm — renamed from rc.6's `CallId`), plus
`CredentialRef` (dsh-credentials), `ApprovalRequestId` (dsh-user-approval),
`MessageId`/`ProviderRequestId`/`LlmAttemptId`/`ReasoningEffortId` (dsh-llm). 0.2 adds
**branded numbers** (`BrandedNumber`): `SessionSeq` / `SessionLogOffset` (dsh-session) —
`session.seq`, `event.seq`, and fork boundaries are no longer plain `number`.

---

## 8. Alignment check against this project's design

The **item-by-item check** of `dsh-channel-design.md` §1.1/§1.2 and R1–R10 (design §6) was
first run against the rc.6 source (audit record in git history) and re-checked against
0.2.0-rc.2 for this revision.

Summary conclusion:
- **The `ChannelRegistry`(core) + `Channel` (plain abstract-class seam) split, the mapping to
  `ctx.llm`/`LlmAdapter`, the degradation semantics of `approval/request`,
  `ctx.credentials.resolve`, `ctx.sessions.fork`, the `session/event` and `SessionEventMap`
  extension points — all still align with the 0.2.0-rc.2 source.** `registerAdapter` still
  returns a **callable disposer + `.replace()`** handle; `SessionEvent` is still **a union
  discriminated by type**, now with the surface split compiler-enforced (`surfaceOp?: never`
  on non-surface events) and a branded `SessionSeq`.
- 0.2 changes that touched this repo's consumption:
  - `assistant/chunk` (log) → `agent/assistant-stream` (process-local, agent-scoped); the
    bridge's streaming path now listens to `agent/assistant-stream` and `session/event`.
  - `Session.events` removed; the bridge still reads history through the deprecated
    `snapshotEvents()`/`eventAt()` (allowed for existing logic; new reads should go through
    `ctx.sessionQuery` or the live feed).
  - User questions: single-slot `registerProvider` → the agent-scoped
    `user-questions/request` waterfall, registered in `setup()` (`setupAgent`); an unanswered
    or timed-out question rejects with `UserQuestionError` (`ASK_TIMED_OUT`/`ASK_ABORTED`),
    and an empty `selected` means "user skipped".
  - Presets: `dsh-agent-presets` → `dsh-agent-preset-registry`; the bridge resolves the id
    (session header `agentPreset`, config fallback) and mounts it inside `setup()`.
  - Resume is guarded by `ctx.sessionPersistence.stat(id)` (undefined = not persisted) instead
    of try/catch-as-probe; the persistence seam's single-writer ownership
    (`SessionAlreadyOwnedError`) is the 0.2 answer to cross-process contention.
  - `fork` no longer rejects open turns (`OPEN_TURN` removed); a cancelled turn commits its
    partial output as `assistant/message` with `interrupted: true`; `turn/end` gains the
    fork-seed-only `forked` reason.
  - Plugin config lives in the profile `cordis.patch.yml` entry; schemastery `.volatile()`
    fields hot-update, anything else restarts the plugin (§2.1).
