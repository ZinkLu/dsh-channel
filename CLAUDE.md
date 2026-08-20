# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The message-channel layer for DeepSeek Harness (dsh, a Cordis 4.x plugin framework): a contract package, a shared handler/pure-function kit, and one provider package per platform (Telegram, WeChat, Feishu). npm workspaces monorepo, ESM, TypeScript `NodeNext`, tests on `node:test` via `tsx`. Pinned dsh baseline: `@deepseek-ai/dsh-*@0.1.0-rc.6`. **This repo never patches dsh core** — it only consumes four dsh touchpoints: `session/event`, `ctx.agents.create/resume`, the `approval/request` waterfall, and `ctx.credentials`.

`dsh-channel-design.md` is the single design source (R1–R10 hard constraints in §6, off-track signals in Appendix B). Read the relevant section before changing a contract or mechanism.

## Commands

```bash
npm install
npm run build                      # all five packages → packages/*/lib, in dependency order
npm run test                       # build, then test every workspace
npm run typecheck                  # build, then tsc --noEmit every workspace

npm run build -w dsh-channel-kit   # one package
npm run test  -w dsh-channel-telegram

# single test file / single test (run from the package directory)
cd packages/channel-kit && npx tsx --test test/merge.test.ts
cd packages/channel-kit && npx tsx --test --test-name-pattern='iron rules' test/merge.test.ts
```

Build/test ordering matters because cross-package imports resolve through `node_modules` symlinks to each package's **built `lib/`**, not `src/`:

- `dsh-channel-kit` and `dsh-channel` tests import `../src/*.ts` directly — no build needed.
- Provider tests (`telegram`/`wechat`/`feishu`) have a `pretest` that rebuilds only *that* provider. After editing `channel` or `channel-kit`, rebuild those first (or run root `npm run build`) or the provider tests run against stale `lib/`.
- Root `build` lists packages explicitly because `--workspaces` walks alphabetically and would build `channel-feishu` before `channel-kit`.

Local debugging (see README for details):

```bash
TELEGRAM_BOT_TOKEN='...' node scripts/run-echo-bot.mjs   # echo bot, no model
scripts/run-dev-bot.sh                                     # full agent via the real dsh launcher + scripts/dev-bot.yaml
```

`run-dev-bot.sh` maintains a `dev-bot` profile under `$DSH_HOME` with this repo's packages as `file:` deps (copies, refreshed from `packages/*/lib` each launch) and runs from the gitignored `agent-workspace/`. Two processes long-polling one bot token collide (Telegram 409).

## Architecture

Dependency direction is strict and one-way (R3: a consumer/policy plugin may only peer-depend on `dsh-channel`; a provider's name never appears in anyone's deps):

```
dsh-channel (contract, zero implementation)
   ▲
dsh-channel-kit (config/ + format/ → policy/ → bridge/ ; plus testing/)
   ▲
dsh-channel-telegram / -wechat / -feishu (transport only)
```

Cross-package deps among dsh packages are `peerDependencies` (+ `devDependencies` for tests); `dependencies` is reserved for third parties.

### `packages/channel` — the contract (`src/index.ts`, one file)

`declare module` for `ctx.channels` + `channel/message` (emit) / `channel/deliver` (waterfall) / `channel/status` (emit); `ChannelRegistry` (a Service, mirrors `LlmRuntime`); `abstract class Channel` (a *plain* abstract class mirroring `LlmAdapter` — deliberately **not** a Service, since many platforms coexist under one ctx key). Platform differences are expressed only as `get` capability facts with conservative defaults (`formatTier`, `streamingMode`, `supportsChoices/Edit/Typing/Media/Reply/Threads/Silent/Reconciliation`, …) plus the small required surface. A method only one platform can implement must never land on `Channel`. Registry keys are `(id, accountId)`; `bindChatKey`/`chatKeyOf` expose sessionId → chat binding for proactive push.

### `packages/channel-kit` — the shared handler

- `config/` — the schemastery fragments (`agentRoutingSchema`/`channelBehaviorSchema`/`allowedUserIdsSchema` + `AgentRoutingConfig`/`ChannelBehaviorConfig`) every provider composes its `Config` from; `BridgeConfig` is derived from these types so handler and schema can't drift.
- `format/` — leaf text/transport shaping, no decisions, no state (`chunkText`, `renderForTier`, `promptHint`, `assertMediaWithinLimit`, `proxiedFetch`).
- `policy/` — decision logic as **pure reducers** `(state, input) → { state, effects }` (`mergeReduce`, `route`, `deliverQueueReduce`, `streamReduce`, `draftThrottleReduce`, `outboundEchoReduce`, recovery/finalization/busy/approval-render/prompt-render/tool-display) and the two policy *seams* with defaults: `PresentationPolicy` and `RecoveryPolicy`. Policies hold no state; state lives in the bridge.
- `bridge/` — `ChannelBridge<TCfg>` (`bridge.ts`) owns all orchestration; `InteractionBroker` handles approvals + user-question prompts (shared `#n` numbering, timeouts, fail-closed); `KeyedTimers`/`sleepWithAbort` in `timing.ts` host every per-key timer; `ChannelStore` interface + `createMemoryStore` (tests) + `createJsonFileStore` (the only file that touches the filesystem).
- `testing/` — `installChannelContractSuite` conformance battery every provider installs in `test/conformance.test.ts`; every `true` capability fact must come with a proof callback or the suite fails.

Kit design rulings that are settled (backlog §3.2): the kit is **not** split into packages; there are no `MergePolicy`/`RoutePolicy`/`DeliveryPolicy`/… seams beyond presentation + recovery — abstract on the second real implementation, not before. New reducer-style mechanisms should reuse `KeyedTimers`.

**The protected surface providers depend on must not change shape:** `handleInbound`, `mergeMessage`, `sendOutbound`, `sendLocal`, `resolveApproval`, `resolvePrompt`, `handleInboundChoice`, `draftMessageIds`, `chunkCountBy`, `showDraft`, `deleteDraft`, plus the abstract hooks `connect`/`disconnect`/`isAllowed`/`config`.

### Providers — what one actually implements

Each provider is four files plus a plugin entry: `config.ts` (its `Config` schema spread from the kit fragments + platform fields, plus its own `CHANNEL_<PLATFORM>_NS` and `CREDENTIAL_*` constants — these have exactly one consumer and deliberately live in the provider, not a shared package), `client.ts` (HTTP/WebSocket transport with a `fetch` seam, redacts tokens from logs), `channel.ts` (`extends Channel`: capability facts + `send`/`sendMedia`/`ackInbound`), `bridge.ts` (`extends ChannelBridge`: `connect`/`disconnect`/`isAllowed`, a private `normalize()` from transport payload → `InboundMessage`, and optionally `downloadInboundImages`/`showDraft`/`deleteDraft`). `index.ts` is the Cordis plugin: `name`, `inject = ['channels','agents','credentials']`, `Config` from `./config.js`, `installSettingsSection` for the `channel-<platform>` settings namespace, `ctx.channels.register(channel)`, and `ctx.effect` that starts/stops the bridge (R1: everything reversible on unload). `cordis.patch.yml` is the wiring example referenced from `package.json#dsh.bundle.patch`. Adding a platform must touch no line of `dsh-channel`/`dsh-channel-kit` (A5).

Bridge config is read through a dynamic `source()` so settings-document changes apply live; only `statePath` is restart-only. Credentials are re-resolved via `ctx.credentials.resolve(...)` on **every** call — never cached, never in the settings document.

### Data flows and load-bearing invariants

- **Inbound:** platform payload → `normalize()` → `handleInbound` → allowlist (required, no permissive default; `chatType !== 'direct'` is dropped in v1) → approval/prompt replies resolve **before** merge/router → commands and media flush the merge buffer first → merge reducer (three iron rules: never merge media into text, never delay control commands, never merge empty text) → `route()` → `agent.followup()/steer()` with `source.kind: 'channel'` + platform message ids in the session log.
- **Idempotency derives from the session log** (fold `user/message.source.messageIds`); the store's inbound dedupe is a TTL safety net with outcome `handling | done | failed`. Never decide "already handled" from an in-memory variable alone (R7).
- **Outbound:** `session/event` (`assistant/message`, `turn/end`, …) → presentation policy → `renderChunks` → per-chatKey serial deliver queue (3 retries, 1/2/4s backoff, backpressure) → `ctx.channels.deliver()` waterfall → `Channel.send`. Both agent output (`sendOutbound`, ledger-tracked) and bridge-authored text (`sendLocal`) go through the same queue so status lines never interleave with answer chunks.
- **Delivery ledger** (`state.json`): `pending → attempting → delivered/failed/abandoned`. Delivery key grammar is `${sessionId}:${seq}` + `#${chunkIndex}` (the `#` is deliberate — session ids contain colons). A resend after an `attempting` crash carries a visible "recovered resend" marker; abandonment requires both an attempt cap and a minimum age. Ledger failures must never block real sends.
- **Startup recovery** (`restore()`) resumes every session a swept delivery key parses to (resume-only, never create), each under `resumeTimeoutMs`, and re-runs on every reconnect, skipping keys a live queue still owns.
- **Session id grammar:** `channel:<id>:<chatKey>`, with `:<accountId>` inserted only for non-default accounts — single-account ids must stay byte-for-byte unchanged.
- **Approval answerer** on `approval/request`: only answers for its own agents, always calls `next()` for non-owned agents and on timeout, never defaults to allow.

## Documentation conventions

Exactly four living documents: `README.md` (bilingual EN/中文 — keep both halves in sync, including the test-count table), `dsh-channel-design.md`, `docs/dsh-core-reference.md` (rc.6 core alignment), `docs/dsh-channel-backlog.md` (open questions / deferred work with triggers / rejected designs). Finished process documents live in git history, not the tree. Docs and code comments speak only about this repo's own design, implementation, and roadmap — do not name or cite external reference projects. When shipping a capability, update design §12/§13 and the README; when deferring or rejecting one, write it to the backlog with its trigger.

Commit messages follow `type(scope): imperative summary` with scopes like `kit`, `channel`, `telegram`, `wechat`, `feishu`, `config`, `scripts`, `docs` (multi-scope as `fix(telegram,wechat): …`).
