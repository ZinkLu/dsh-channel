# dsh-channel design alignment check (against the rc.6 source)

> Checked against: every concrete assertion about the dsh core API in `dsh-channel-design.md`
> §1.1/§1.2 and R1–R10 (originally in the handoff, now merged into design §6).
> Baseline: `@deepseek-ai/*@0.1.0-rc.6` compiled types
> (`node_modules/@deepseek-ai/*/lib/types/*.d.ts`) + the official reference docs (master).
> Verdict markers: ✅ word-for-word aligned / ⚠️ aligned but needs refinement / ❌
> contradicts rc.6.

---

## 1. `dsh-channel-design.md` §1.1 "the shape answer given by the dsh source"

| Assertion | Verdict | Source |
|---|---|---|
| `LlmRuntime extends Service` (concrete class, `ctx.llm`) + `registerAdapter(providers, adapter)` returns a handle with `dispose` | ✅ (⚠️ refinement: the handle is a **callable disposer + `.replace(providers)`**, not a `{ dispose }` object) | `dsh-llm/lib/types/index.d.ts:198` (class), `:215` (registerAdapter), `:155-173` (`AdapterRegistrationHandle`) |
| the adapter is a **plain abstract class**, not a Service | ✅ | `dsh-llm/lib/types/index.d.ts:113` (`abstract class LlmAdapter`) |
| the definition-package shape = `declare module` + abstract class (capability facts use `get` conservative defaults) + type exports | ✅ | `LlmAdapter`'s `providerRetryPolicy`/`listModels` and other getter-style conservative defaults; merging Context/Events via `declare module '@deepseek-ai/cordis'` is the repo-wide pattern |
| pure-event bypass = provides no service, only `ctx.on('fs/*')`, one state per `apply()`, disposer zeroed out | ✅ | consistent with `ctx.on` semantics (fiber-owned, undone on unload) |
| dependency direction = cross-dsh packages as `peerDependencies`, `dependencies` only for third parties | ✅ | consistent with dsh ecosystem conventions |
| optional-dependency degradation = `import type {}` + `ctx.get('approval')`, missing → deny | ✅ | `dsh-tools/lib/types/index.d.ts:784-794` (`serviceAsk`: `ctx.get('approval')`, "historical degrade to deny" when no ApprovalService) |

**Design-ruling re-review**: `Channel` does not extend `Service`, `ChannelRegistry` is the
only Service core — correct. One Service owns one ctx key; `LlmAdapter` is precisely a plain
abstract class; the provider lifecycle is carried by its own plugin fiber, and registrations
are reclaimed by the disposer returned from `register()`. **Fully consistent with rc.6.**

---

## 2. `dsh-channel-design.md` §1.2 "APIs to be verified: all verified"

| Assertion | Verdict | Source |
|---|---|---|
| `ctx.agents.create({ sessionId, meta:{cwd, agentPreset…}, agentOptions:{provider,model}, setup? })` → `AgentHandle { agent, dispose }` | ✅ (⚠️ refinement: `meta` also has `parentSession`/`seedLength`/`origin`/`delegationDepth`; `setup` is an async-transaction callback) | `dsh-agent/lib/types/index.d.ts:65-118`, `:155-158`, `:288` |
| `ctx.agents.resume({ resumeSessionId, … })` restores a persisted session (depends on sessionPersistence) | ✅ | `dsh-agent/lib/types/index.d.ts:123-140`, `:296` |
| `ctx.agents.get(id)` returns the bare `Agent` | ✅ | `dsh-agent/lib/types/index.d.ts:349` |
| inbound delivery: `agent.followup(msg)` / `agent.steer(msg)` / `agent.inject(msg)` | ✅ | `dsh-agent/lib/types/runtime-types.d.ts:115/123/132` |
| output has no callback API — read `assistant/message` / `turn/end` from `session/event` | ✅ | `dsh-session/lib/types/index.d.ts:66` (emit feed); `assistant/message`/`turn/end` are `SessionEventMap` variants (`types.d.ts:241/275`) |
| `agent.status` (`idle`/`running`) and the `agent/status` event can drive typing | ✅ | `runtime-types.d.ts:45` (`AgentStatus`), `:169` (`agent/status` emit) |
| `session/event` schema = `(session, event)`, emit, post-commit, fire-and-forget | ✅ | `dsh-session/lib/types/index.d.ts:66` |
| `SessionEvent = { type, seq, time, data, ignorable? }` | ⚠️ refinement: it is a **union discriminated by `type`**; the three surface events `user/message`/`assistant/message`/`tool/result` also carry `sourceEventSeqs?`/`surfaceOp?` | `dsh-session/lib/types/types.d.ts:420-452`, `:362` (`SurfaceEventType`) |
| `SessionEventMap` is extended via merging through `declare module '@deepseek-ai/dsh-session/types'` | ✅ | `dsh-agent/lib/types/types.d.ts:9`, `dsh-user-approval/lib/types/index.d.ts:27` |
| `approval/asked`/`approval/decided` are the ready-made example | ✅ | `dsh-user-approval/lib/types/index.d.ts:28-51` |
| "bare events outside a turn are treated as a crash tail and dropped on reload" | ⚠️ not verified word-for-word in the source read so far (this is `dsh-session-persistence` backend behavior). rc.6 evidence: `TurnEndReasonMap.interrupted` ("persistence backend closed a crash-orphaned turn on reload") shows that orphaned turns are closed by the persistence backend on reload; the precise semantics of "appending a bare event outside a turn is dropped" should be re-checked against the `dsh-session-persistence` source when persistence is wired up | `dsh-session/lib/types/types.d.ts:164-166` |
| `approval/request`: waterfall `(req, next) => Promise<ApprovalOutcome>`; `req = { agent, toolName, callId?, reason?, signal? }`; outcome ∈ `'allowed-once'|'rejected'|'cancelled'|'unavailable'` | ✅ | `dsh-user-approval/lib/types/index.d.ts:24` (event), `:104-125` (`ApprovalRequest`), `types.d.ts:23` (`ApprovalOutcome`) |
| no answerer / answerer throws → `'unavailable'` (fail-closed); `signal` abort → `'cancelled'`, late answers dropped | ✅ | `dsh-user-approval/lib/types/index.d.ts:154-171` (`request` doc) |
| the session policy `'never'` rejects in place before dispatch | ✅ | `index.d.ts:81` (`ApprovalPolicy = 'ask'|'never'`), `:75-79` |
| the audit pair (asked/decided) is logged by `ApprovalService`, the answerer need not manage it | ✅ | `index.d.ts:28-51` + the `request()` doc |
| `ctx.sessions.fork(source, boundary?, childSessionId?)`; `OPEN_TURN` rejection | ✅ | `dsh-session/lib/types/index.d.ts:413` (fork), `:278` (`SessionForkErrorCode` includes `OPEN_TURN`) |
| `ctx.credentials.resolve(credentialRef('X'))` → `{ value, source } | undefined`; re-resolved on every operation | ✅ | `dsh-credentials/lib/types/index.d.ts:18` (`credentialRef`), `:20-25` (`ResolvedCredential`), `:56` (`resolve`) |

**Conclusion**: all dsh-touchpoint assertions in §1.2 **align with the rc.6 source**, with
only two spots needing refinement (the `SessionEvent` union shape, the `registerAdapter`
handle shape); no ❌ items were found.

---

## 3. R1–R10 hard-constraint check (originally the handoff, now merged into design §6)

| Rule | Verdict | Notes |
|---|---|---|
| R1 reversible side effects | ✅ | `ctx.effect(execute, label?)` returns a single-use disposer; `register()` returns a disposer reclaimed with the fiber (`cordis/lib/types/fiber.d.ts:157-159`) |
| R2 `inject` declares dependencies; optional dependencies via `ctx.get` + type-only + missing → degrade | ✅ | `ToolRuntime.serviceAsk` is the **exact ready-made example** of "approval missing → deny" (`dsh-tools:784-794`) |
| R3 interface/implementation split across packages, dependencies point only at the interface | ✅ | consistent with the `LlmRuntime`(def)/`LlmAdapter`(seam)/`llm-deepseek`(provider) three-way split |
| R4 contract = method signatures + event vocabulary, same `declare module '@deepseek-ai/cordis'` | ✅ | repo-wide pattern: `Context`/`Events` merging |
| R5 the registry is core, an individual channel is a seam | ✅ | `LlmRuntime`(core Service) + `LlmAdapter`(abstract-class seam) as the word-for-word analogue |
| R6 capability differences via `get` conservative defaults | ✅ | `LlmAdapter`'s getter-style conservative defaults; same for `FileSystem`/`sandboxMode` |
| R7 model-visible = must be logged | ✅ | `deriveMessages()` projects history from the log; "model-visible is already recorded" is the runtime invariant |
| R8 waterfall must call `next()`, don't seize the decision | ✅ | `agent/pre-step`/`approval/request`/`tools/*`/`llm/stream` are all waterfall |
| R9 assembly in YAML; credentials via `ctx.credentials` | ✅ | `credentialRef` + `resolve` re-resolved on every operation |
| R10 scoping, no hard-coded global assumptions | ✅ | `ctx.scope` (`createScope`/`scopeOf`/`scopeTarget`) + `agent.ctx`; the agent preset uses the `isolate` realm |

---

## 4. Three precision points to carry into the implementation

1. **Construct inbound `UserMessage` with `createUserMessage()`**
   (`dsh-llm/lib/types/message.d.ts:171`): a complete `UserMessage` needs `id` + `role:'user'`
   + `content: ContentBlock[]` + `source`. Design §5.2's `msg.source = {…}` is pseudocode; it
   should actually be `createUserMessage({ content: [text block], source: { kind:'channel', … } })`
   then `agent.followup(msg)`.
2. **The `MessageSourceMap.channel` extension point is correctly located**:
   `declare module '@deepseek-ai/dsh-llm'`'s `interface MessageSourceMap`
   (`dsh-llm/lib/types/message.d.ts:94`), whose members carry a `kind` discriminator; the
   existing four are `user|plugin|model|tool`, so adding `channel` alongside them is
   sufficient.
3. **Read output via `session/event`**: `assistant/message`'s `data` is
   `{ turn, step, message: AssistantMessage, usage? }`; `turn/end`'s `data` is
   `{ turn, reason }` — design §5.3's `textOf(event)` / status-line push must unpack these
   two data shapes.
