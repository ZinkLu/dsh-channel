# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## What this repo is

The message-channel layer for DeepSeek Harness (dsh, a Cordis 4.x plugin framework): a contract package, a channel-agnostic session manager, a shared handler/pure-function kit, and one provider package per platform (Telegram, WeChat, Feishu). npm workspaces monorepo, ESM, TypeScript `NodeNext`, tests on `node:test` via `tsx`. Pinned dsh baseline: `@deepseek-ai/dsh-*@0.2.0-rc.2`. **This repo never patches dsh core** — it only consumes these dsh touchpoints: `session/event`, `agent/status`, `agent/assistant-stream`, `ctx.agents.create/resume`, the `approval/request` and `user-questions/request` waterfalls, and `ctx.credentials` (plus, all optional and duck-typed through `ctx.get`, `sessionQuery`/`workspaceRegistry`/`agentPresets`/`sessionProjections`/`sessionPersistence`/`storageDomain`/`tools`).

`dsh-channel-design.md` is the single design source (R1–R10 hard constraints in §6, the session-manager layer in §14, off-track signals in Appendix B). Read the relevant section before changing a contract or mechanism.

## Commands

```bash
npm install
npm run build                      # all six packages → packages/*/lib, in dependency order
npm run test                       # build, then test every workspace
npm run typecheck                  # build, then tsc --noEmit every workspace

npm run build -w dsh-channel-kit   # one package
npm run test  -w dsh-channel-telegram

# single test file / single test (run from the package directory)
cd packages/channel-kit && npx tsx --test test/merge.test.ts
cd packages/channel-kit && npx tsx --test --test-name-pattern='iron rules' test/merge.test.ts
```

Build/test ordering matters because cross-package imports resolve through `node_modules` symlinks to each package's **built `lib/`**, not `src/`:

- `dsh-channel-kit` and `dsh-channel` tests import `../src/*.ts` directly — no build needed. `dsh-session-manager` tests import `../src/index.ts` directly too, and the kit's `bridge-manager.test.ts` imports the built `dsh-session-manager` `lib/` (its `pretest` rebuilds that package).
- Provider tests (`telegram`/`wechat`/`feishu`) have a `pretest` that rebuilds only *that* provider. After editing `channel`, `session-manager`, or `channel-kit`, rebuild those first (or run root `npm run build`) or the provider tests run against stale `lib/`.
- Root `build` lists packages explicitly because `--workspaces` walks alphabetically and would build `channel-feishu` before `channel-kit`.

Local debugging (see README for details):

```bash
TELEGRAM_BOT_TOKEN='...' node scripts/run-echo-bot.mjs   # echo bot, no model
scripts/run-dev-bot.sh                                     # full agent via the real dsh launcher + scripts/dev-bot.yaml
```

`run-dev-bot.sh` maintains a `dev-bot` profile under `$DSH_HOME` with this repo's packages as `file:` deps (copies, refreshed from `packages/*/lib` each launch) and runs from the gitignored `agent-workspace/`. Two processes long-polling one bot token collide (Telegram 409) — check `ps` for a running `dsh` before starting another. dsh 0.2 still has no log sink (`ctx.logger` only fills an in-memory buffer); `scripts/dev-logger.mjs` is the dev-only stderr exporter the dev bot inserts (`DEV_BOT_LOG_LEVEL`, default 3=debug; cordis levels are error 0 < info 1 < warn 2 < debug 3, default threshold 1 drops `warn`).

## Architecture

Dependency direction is strict and one-way (R3: a consumer/policy plugin may only peer-depend on `dsh-channel`; a provider's name never appears in anyone's deps):

```
dsh-channel (contract, zero implementation)
   ▲
dsh-channel-kit (config/ + format/ → policy/ → bridge/ ; plus testing/)
   ▲
dsh-channel-telegram / -wechat / -feishu (transport only)

dsh-session-manager (ctx.sessionManager; depends on NO channel package)
   ▲ (optional peer, type-only)
dsh-channel-kit bridge (ctx.get('sessionManager') upstream)
```

Cross-package deps among dsh packages are `peerDependencies` (+ `devDependencies` for tests); `dependencies` is reserved for third parties.

### `packages/channel` — the contract (`src/index.ts`, one file)

`declare module` for `ctx.channels` + `channel/message` (emit) / `channel/deliver` (waterfall) / `channel/status` (emit); `ChannelRegistry` (a Service, mirrors `LlmRuntime`); `abstract class Channel` (a *plain* abstract class mirroring `LlmAdapter` — deliberately **not** a Service, since many platforms coexist under one ctx key). Platform differences are expressed only as `get` capability facts with conservative defaults (`formatTier`, `streamingMode`, `supportsChoices/Edit/Typing/Media/Reply/Threads/Silent/Reconciliation`, …) plus the small required surface. A method only one platform can implement must never land on `Channel`. Registry keys are `(id, accountId)`; `bindChatKey`/`chatKeyOf` expose sessionId → chat binding for proactive push.

### `packages/session-manager` — `ctx.sessionManager` (channel-agnostic)

The layer that turns "one chat ↔ one session" into "any subscriber ↔ every session of this process" (design §14). `SessionManager extends Service` (R5, core-style singleton like `ChannelRegistry`), provided under `sessionManager`; it imports **no** channel package (D1/R3). `inject = ['agents','sessions']`; everything else (`sessionQuery`/`workspaceRegistry`/`agentPresets`/`sessionProjections`/`sessionPersistence`/`storageDomain`/`tools`) is optional and duck-typed through `ctx.get`, so it degrades instead of failing.

- **Registry/dispatch:** `list`/`describe`/`workspaces` fold `ctx.agents` live state ⊕ cold `sessionQuery` records ⊕ the four store tables ⊕ projection titles. `create`/`adopt`/`dispatch`/`cancel` own the resume-before-create + preset-mount flow the bridge used to. `dispatch(mode:'auto')` = idle→`followup`, running→`steer`.
- **Tasks fold from the log (R7):** a dispatch records `{taskId, sessionId, watermark = session.seq}`; the first `turn/start` with `seq ≥ watermark` owns the task, `turn/end(turn)` closes it (`crashed` = reason `interrupted`). The `tasks` table stores associations, not truth; a restart re-folds open tasks (crashed unless the live log shows the turn ended).
- **Notifications:** the edge is `agent/status → 'idle'`, NOT `turn/end` (a followup chain pushes once). `watch`/`unwatch`/`subscribersOf`, a durable ack'd `outbox`, `notify(when:'now'|'done')`, `onNotification(prefix)`/`pending(prefix)`/`ack(id)`. The global `notify_user` tool (`execute → notify(agent.id, …)`) registers on the plugin ctx and re-registers per agent in `setup()` (preset-restriction fallback).
- **Store:** `ManagerStore` interface + `createMemoryManagerStore` (tests) + `createJsonFileManagerStore` (tmp+rename atomic, the default) + `openDomainManagerStore` (`ctx.storageDomain`, the shared `$DSH_HOME/storages` composition). The store is a handoff cache; only outbox `pending` rows carry real at-least-once semantics.
- **Two emit-only events** (`manager/notification`, `manager/task`) for observers/policy plugins (R4). Approval/question observation is a pure pass-through that always `next()`s (R8).

### `packages/channel-kit` — the shared handler

- `config/` — the schemastery fragments (`agentRoutingSchema`/`channelBehaviorSchema`/`allowedUserIdsSchema` + `AgentRoutingConfig`/`ChannelBehaviorConfig`) every provider composes its `Config` from; `BridgeConfig` is derived from these types so handler and schema can't drift.
- `format/` — leaf text/transport shaping, no decisions, no state (`chunkText`, `renderForTier`, `promptHint`, `assertMediaWithinLimit`, `proxiedFetch`).
- `policy/` — decision logic as **pure reducers** `(state, input) → { state, effects }` (`mergeReduce`, `route`, `deliverQueueReduce`, `streamReduce`, `draftThrottleReduce`, `outboundEchoReduce`, recovery/finalization/busy/approval-render/prompt-render/tool-display) and the two policy *seams* with defaults: `PresentationPolicy` and `RecoveryPolicy`. The manager surface joins these as pure functions: `router.ts` grew the tri-state resolver chain (`focusResolver`/`conventionResolver`, `null`=reject/`undefined`=pass, `provenance` on hits), `manager-commands.ts` parses/renders the `/ls /use /new /to /status /tail /stop /watch /unwatch /ws /bind` table, `focus-presentation.ts` decides stream-vs-badge-vs-silent per `{isFocused, kind}`. Policies hold no state; state lives in the bridge.
- `bridge/` — `ChannelBridge<TCfg>` (`bridge.ts`) owns all orchestration; `InteractionBroker` handles approvals + user-question prompts (shared `#n` numbering, timeouts, fail-closed); `KeyedTimers`/`sleepWithAbort` in `timing.ts` host every per-key timer; `ChannelStore` interface + `createMemoryStore` (tests) + `createJsonFileStore` (the only file that touches the filesystem).
- `testing/` — `installChannelContractSuite` conformance battery every provider installs in `test/conformance.test.ts`; every `true` capability fact must come with a proof callback or the suite fails.

Kit design rulings that are settled (backlog §3.2): the kit is **not** split into packages; there are no `MergePolicy`/`RoutePolicy`/`DeliveryPolicy`/… seams beyond presentation + recovery — abstract on the second real implementation, not before. New reducer-style mechanisms should reuse `KeyedTimers`.

**The protected surface providers depend on must not change shape:** `handleInbound`, `mergeMessage`, `sendOutbound`, `sendLocal`, `resolveApproval`, `resolvePrompt`, `handleInboundChoice`, `applyFocusChoice`, `draftMessageIds`, `chunkCountBy`, `showDraft`, `deleteDraft`, plus the abstract hooks `connect`/`disconnect`/`isAllowed`/`config`. Growth is additive only (the manager added `applyFocusChoice` and `sendLocal`'s optional `choices` field; nothing was re-shaped).

### Providers — what one actually implements

Each provider is four files plus a plugin entry: `config.ts` (its `Config` schema spread from the kit fragments + platform fields, plus its own `CHANNEL_<PLATFORM>_NS` and `CREDENTIAL_*` constants — these have exactly one consumer and deliberately live in the provider, not a shared package), `client.ts` (HTTP/WebSocket transport with a `fetch` seam, redacts tokens from logs), `channel.ts` (`extends Channel`: capability facts + `send`/`sendMedia`/`ackInbound`), `bridge.ts` (`extends ChannelBridge`: `connect`/`disconnect`/`isAllowed`, a private `normalize()` from transport payload → `InboundMessage`, and optionally `downloadInboundImages`/`showDraft`/`deleteDraft`). `index.ts` is the Cordis plugin: `name`, `inject = ['channels','agents','credentials']`, `Config` from `./config.js`, `ctx.channels.register(channel)`, and `ctx.effect` that starts/stops the bridge (R1: everything reversible on unload). `cordis.patch.yml` is the wiring example referenced from `package.json#dsh.bundle.patch`. Adding a platform must touch no line of `dsh-channel`/`dsh-channel-kit` (A5).

Bridge config comes from the plugin entry in the profile's `cordis.patch.yml` (the 0.2 settings model: config *is* the plugin-entry config; any change restarts the plugin with the new value). Credentials are re-resolved via `ctx.credentials.resolve(...)` on **every** call — never cached, never in the profile patch.

### Data flows and load-bearing invariants

- **Inbound:** platform payload → `normalize()` → `handleInbound` → allowlist (required, no permissive default; `chatType !== 'direct'` is dropped in v1) → approval/prompt replies resolve **before** merge/router → commands and media flush the merge buffer first → merge reducer (three iron rules: never merge media into text, never delay control commands, never merge empty text) → `route()` → `agent.followup()/steer()` with `source.kind: 'channel'` + platform message ids in the session log.
- **Idempotency derives from the session log** (fold `user/message.source.messageIds`); the store's inbound dedupe is a TTL safety net with outcome `handling | done | failed`. Never decide "already handled" from an in-memory variable alone (R7).
- **Outbound:** `session/event` (`assistant/message`, `turn/end`, …) → presentation policy → `renderChunks` → per-chatKey serial deliver queue (3 retries, 1/2/4s backoff, backpressure) → `ctx.channels.deliver()` waterfall → `Channel.send`. Both agent output (`sendOutbound`, ledger-tracked) and bridge-authored text (`sendLocal`) go through the same queue so status lines never interleave with answer chunks.
- **Delivery ledger** (`state.json`): `pending → attempting → delivered/failed/abandoned`. Delivery key grammar is `${sessionId}:${seq}` + `#${chunkIndex}` (the `#` is deliberate — session ids contain colons). A resend after an `attempting` crash carries a visible "recovered resend" marker; abandonment requires both an attempt cap and a minimum age. Recovery re-validates the recorded `textHash` against the recomputed chunk before any resend (0.2's v0→v4 log migration re-numbers seq) — a mismatch abandons via `store.markAbandoned`. Ledger failures must never block real sends.
- **Startup recovery** (`restore()`) resumes every session a swept delivery key parses to (resume-only, never create), each under `resumeTimeoutMs`, and re-runs on every reconnect, skipping keys a live queue still owns.
- **Session id grammar:** `channel:<id>:<chatKey>`, with `:<accountId>` inserted only for non-default accounts — single-account ids must stay byte-for-byte unchanged.
- **Approval answerer** on `approval/request`: only answers for its own agents, always calls `next()` for non-owned agents and on timeout, never defaults to allow.
- **Manager upstream (optional, D4):** with `ctx.sessionManager` present the bridge routes free text through `manager.adopt`/`dispatch` (focus = the chat's `bindings` entry), executes the `/ls…` command table, and pumps the manager outbox through the same serial deliver queue under ledger key `notify:<id>` (acked after a `sent` receipt; a crash between deliver and ack re-delivers once with the "(resumed resend)" marker; `forbidden`/`not_found` acks + `unwatch`). Approval/question prompts fan out to every `subscribersOf(sessionId, kind)` chat plus the focus chat — first answer wins. Only the focus session streams; watched sessions get badged result notifications. **Without the manager every path is byte-for-byte the classic behavior** (same command replies, same conventional session ids).

## Documentation conventions

Exactly four living documents: `README.md` (bilingual EN/中文 — keep both halves in sync, including the test-count table), `dsh-channel-design.md`, `docs/dsh-core-reference.md` (0.2 core alignment), `docs/dsh-channel-backlog.md` (open questions / deferred work with triggers / rejected designs). Finished process documents live in git history, not the tree. Docs and code comments speak only about this repo's own design, implementation, and roadmap — do not name or cite external reference projects. When shipping a capability, update design §12/§13/§14 and the README; when deferring or rejecting one, write it to the backlog with its trigger.

Commit messages follow `type(scope): imperative summary` with scopes like `kit`, `channel`, `manager`, `telegram`, `wechat`, `feishu`, `config`, `scripts`, `docs` (multi-scope as `fix(telegram,wechat): …`).
