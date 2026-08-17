# dsh-channel Capability Gap Analysis & Roadmap

> **ARCHIVED — historical record, not a plan.** M7–M10 all shipped; this document describes work
> that is done. Do not write code from it: the tree is authoritative, and §7.1 already notes where
> the implementation deliberately diverged from the shapes proposed here. What is still open or
> deliberately rejected has moved to `../dsh-channel-backlog.md`; the architecture it fed into is
> in `../../dsh-channel-design.md` §12.

> Status: implemented through M10 (M7 hardening shipped; M8 delivery & identity, M9 presentation extras,
> M10 deployment reach shipped) · Date: 2026-08-16 · Last updated: 2026-08-16 (M8–M10 landed)
> Upstream: `dsh-channel-design.md` (architecture and contracts; R1–R10 in its §6/§7) ·
> `dsh-channel-live-interaction-design.md` (streaming/prompt presentation layer, already implemented)
> Research baseline: `openclaw@191d2313` (2026-08-15) · `NousResearch/hermes-agent@460d3456` (2026-08-15) ·
> `EverMind-AI/Raven@cd686453` (2026-08-14) — all cloned and read directly, not summarized from memory
> Companion: `dsh-channel-mechanism-roadmap.md` (mechanism-level pass over the same references; M11–M13)

---

## 0. TL;DR

v1 deliberately chose the smallest surface that still covers real platforms: a 6-method `Channel`
abstract class plus a dozen capability-fact getters, justified by hermes-agent's own claim that this
shape covers 25 platforms. That bet has held up (§6 of `dsh-channel-design.md`'s R1–R10 table is still
green). This document re-examines the bet against three *independent, currently-maintained* IM-agent
gateways — one closer to hermes in spirit (openclaw, TypeScript, 29 channels), one Python multi-platform
gateway with a delivery hub (`EverMind-AI/Raven`), and hermes-agent itself, re-read for what changed since
the original research pass.

Verdict: **the shape is still right, the coverage is not.** Nothing found here argues for adopting
openclaw's ~40-field `ChannelPlugin` object or Raven's Protocol-based typing — both would violate R6
("never add methods only one platform can implement") and the minimalism that made T7 (add-a-platform)
cheap. What *is* missing is a short list of capability facts and two structural gaps that block real
deployments no matter how many platforms are added:

1. **No inbound media size cap** — a genuine memory-safety hole, not a nice-to-have.
2. **No generic outbound retry/backpressure** — every provider re-derives its own ad-hoc fallback.
3. **No multi-account support** — `ChannelRegistry` cannot hold two bots of the same platform.
4. **`mentionsBot` and reactions never got wired up** — a field that's been "reserved" since v1 is
   still hardcoded `false`, and a much cheaper ack UX (react instead of a text message) is unused.

These four are §2's P0. Everything else is real but bounded — see §3 (P1) and §4 (P2).

---

## 1. Method

| Project | What was read | Why it's a useful comparison |
|---|---|---|
| [openclaw](https://github.com/openclaw/openclaw) | `src/channels/plugins/types.plugin.ts`, `types.core.ts`, `src/channels/message/types.ts`, `capabilities.ts` | 29 channels, years of iteration; the widest capability vocabulary of the three — useful as a **naming source**, not a shape to copy wholesale |
| [hermes-agent](https://github.com/NousResearch/hermes-agent) | `gateway/platforms/base.py` (7300+ lines), `ADDING_A_PLATFORM.md` | The system `dsh-channel`'s "6-method surface" argument is borrowed from; re-read for what its *helper* layer (media caps, proxying, SSRF guards) does that the adapter surface itself doesn't show |
| [`EverMind-AI/Raven`](https://github.com/EverMind-AI/Raven) | `raven/channels/{contract,base,intake,media,outlet,manager}.py`, `raven/spine/delivery.py`, `raven/proactive_engine/wake.py` | A **currently-built, capability-fact-based** gateway (not enumerable adapter slots) — the closest architectural sibling to `dsh-channel`, so its choices are the most directly transferable |

`ssrjkk/raven` was also inspected briefly at the user's initial (later corrected) pointer; it is a much
larger, differently-scoped project (RBAC, Grafana, k8s deploy) and is not used as a source here beyond
one observation about token-bucket rate limiting, noted in §3.

---

## 2. Capability inventory — dsh-channel today vs. the three references

Rows are capabilities; a name in *italics* is one dsh-channel already exposes under a different name.
`✅` = present as a first-class capability fact or adapter slot. `≈` = partially present / hardcoded /
stubbed. `—` = absent.

| Capability | dsh-channel (baseline, pre-M7) | openclaw | hermes-agent | Raven |
|---|---|---|---|---|
| Text send + chunk/split | ✅ `chunkText` | ✅ | ✅ | ✅ |
| Format degrade tier | ✅ `formatTier`/`renderForTier` | ✅ (per-adapter render) | ✅ | ≈ (adapter-owned) |
| Typing indicator | ✅ `supportsTyping` | ✅ | ✅ | — |
| Draft/edit streaming | ✅ `supportsEdit`/`streamingMode` (telegram only) | ✅ `edit`, `blockStreaming` | ✅ (`supports_edit`) | ≈ (`SupportsStreaming`, "inert until wired") |
| Choices/buttons | ✅ `supportsChoices` | ✅ (`payload`) | ✅ | — (text-only in reviewed adapters) |
| Media send/receive | ✅ `supportsMedia` (images only, in-model) | ✅ `media` | ✅ | ✅ (all media, content-hashed storage) |
| **Reactions** | — | ✅ `reactions` | — | ✅ (ack UX: `reactions_add`, `message_reaction.create`) |
| **Reply-to a specific message** | — | ✅ `reply`, delivery cap `replyTo` | ≈ (`_reply_anchor_for_event` internal) | ≈ (`reply_to` mentioned, inbound-side only) |
| **Threads (forum topics, Slack threads)** | *`ChatType.thread` reserved, unused* | ✅ `threads`, `ChannelThreadingAdapter` | ≈ (`_thread_metadata_for_source`) | — |
| **Silent / no-notification send** | — | ✅ delivery cap `silent` | — | — |
| Multi-select | ✅ `supportsMultiSelect` | — (not modeled explicitly) | ✅ (clarify buttons) | — |
| Approval (buttonless degrade) | ✅ `approval-render` | ✅ `approvalCapability` | ✅ | ≈ (`ask_confirmation`, **default auto-approve** — see §4 non-adoption) |
| Group policy (open vs. mention-only) | *hardcoded drop, `mentionsBot` always `false`* | ✅ `groupManagement`, mention adapter | ✅ | ✅ `group_policy: open\|mention` |
| **Native slash-command registration** | — | ✅ `nativeCommands` | ≈ (varies per adapter) | — |
| **Interactive/QR pairing login** | — (static credential only) | ✅ `ChannelPairingAdapter`/`auth` | ≈ (per-adapter) | ✅ `SupportsLogin` protocol |
| **Multi-account per provider** | — (`Channel.id` is a fixed string; registry throws on duplicate) | ✅ (`reload.accountScopedRestart` assumes N accounts/plugin) | ✅ (config lists multiple bot tokens) | ✅ (config-parameterized adapters) |
| Outbound rate limit | ≈ (fixed 1s inter-chunk sleep, telegram only) | ✅ | ✅ | ✅ (token bucket, `ssrjkk/raven`'s `EnterpriseChannel`) |
| **Generic outbound retry** | — (telegram: 1x html→plain fallback only) | ✅ (per-adapter) | ✅ | ✅ (`DeliveryHub._deliver_with_retry`, exponential backoff, wraps every send) |
| **Per-channel backpressure** | — | ≈ | ≈ | ✅ (bounded queue + serial worker per outlet) |
| Delivery idempotency ledger | ✅ `store` (pending/attempting/delivered/failed/abandoned) | ✅ (`reconcileUnknownSend`) | ✅ (`delivery_ledger.py`) | ≈ (retry only, no reconciliation query) |
| **Delivery reconciliation** (query platform before blind resend) | — (blind "recovered resend" marker) | ✅ delivery cap `reconcileUnknownSend` | — | — |
| **Inbound media size cap** | — (unbounded `arrayBuffer()`) | — (not in reviewed files) | ✅ `validate_inbound_media_size`, streaming read-with-limit | — |
| Outbound path traversal guard | ✅ (`readFile` resolver, cwd-anchored) | — (not reviewed) | ✅ `validate_media_delivery_path` + SSRF redirect guard | ✅ `save_media_bytes` (traversal-safe, content-hashed) |
| **Outbound HTTP proxy support** | — | — (not reviewed) | ✅ `resolve_proxy_url`, `proxy_kwargs_for_bot` | — |
| **Proactive / externally-triggered push** | *technically possible via `ctx.channels.deliver()`, but chatKey↔channel binding is private bridge state* | — (not reviewed) | — (not reviewed) | ✅ `proactive_engine`/`WakeScheduler`, decoupled from inbound |
| Doctor/health diagnostics | ≈ (`channel/status` event only) | ✅ `ChannelDoctorAdapter` | ≈ (`health_check`, boolean) | — |
| Directory/contact resolver | — | ✅ `ChannelResolverAdapter`/`ChannelDirectoryAdapter` | — | — |
| `afterSendSuccess`/`afterCommit` hooks | — | ✅ | — | — |

---

## 3. P0 — should land before the provider count grows further

These four are prioritized first not because they're the most interesting, but because each one gets
*harder to retrofit* the more providers exist, and two of them are safety issues, not features.

### 3.1 Inbound media size cap (security/memory-safety)

`packages/channel-telegram/src/bridge.ts:449-459` (`downloadInboundImages`) calls
`this.client.getFile(token, photo.file_id)` → `client.ts:212` does
`new Uint8Array(await response.arrayBuffer())` with **no size check at any point** — the whole HTTP
response body is buffered before anything inspects its length. hermes-agent treats this as a hard
requirement: `get_inbound_media_max_bytes()`/`validate_inbound_media_size()`
(`gateway/platforms/base.py:758-798`) enforce a configurable cap, and `_read_httpx_body_with_limit`
reads the stream incrementally so an oversized payload is rejected **before** it's fully buffered, not
after. dsh-channel currently has neither the cap nor the streaming read.

**Proposed shape** (kit stays pure — this is a provider-side + one new kit constant):
```ts
// dsh-channel-kit — no IO, just the check
export function assertMediaWithinLimit(bytes: number, maxBytes: number, kind: string): void
```
Each provider's `getFile`/media-fetch path wraps the read with an early abort once `Content-Length` (or
running byte count, for chunked responses) exceeds `maxInboundMediaBytes` (a new `ChannelBehaviorConfig`
field, default e.g. 20 MiB, mirroring Telegram's own photo cap). This is a provider-layer fix in all
three bridges' `downloadInboundImages`/media-fetch paths; no dsh-channel/kit contract change beyond one
config field and one pure helper.

### 3.2 Generic outbound retry + per-channel backpressure

Today, resilience is ad hoc and inconsistent: telegram's `send()` retries exactly once, HTML→plain, on
any failure (`packages/channel-telegram/src/channel.ts:116-124`); wechat and feishu have no retry at
all; none of the three throttle *concurrent* outbound bursts beyond the 1s inter-chunk sleep inside
`sendOutbound`. A transient network blip on any provider today either silently drops (ledger marks
`failed`, no automatic retry until process restart) or, worse, an approval prompt racing a final-answer
delivery can interleave in undefined order since there's no per-chat serialization beyond what each
bridge's own call sites happen to await.

Raven's `DeliveryHub` (`raven/spine/delivery.py:90-200`) is the clean version of this: **one bounded
queue and one serial worker per outlet** (channel), so a full queue backpressures only that channel's
sender (no cross-channel head-of-line blocking), same-channel delivery order is preserved by the single
worker, and every `outlet.deliver()` call is wrapped in `_deliver_with_retry` (3 attempts, exponential
backoff 1/2/4s) — generically, not per-adapter.

**Proposed shape**: a new pure module in `dsh-channel-kit`, e.g. `deliver-queue.ts`, exposing a reducer
in the same style as `merge.ts`/`stream.ts` (state in, effects out, timers owned by the caller) that a
bridge drives per chatKey or per provider instance:
```ts
export interface DeliverQueueOptions { maxRetries?: number; baseDelayMs?: number; maxQueue?: number }
export type DeliverQueueEffect =
  | { kind: 'attempt'; item: QueuedDelivery }
  | { kind: 'retry-after'; at: number; item: QueuedDelivery }
  | { kind: 'give-up'; item: QueuedDelivery; error: string }
  | { kind: 'reject-backpressure'; item: QueuedDelivery }
```
This slots naturally in front of the existing `ChannelRegistry.deliver()` waterfall — the queue decides
*when* to call `deliver()`, the waterfall still decides *what happens* on a given attempt. No change to
the `channel/deliver` event contract; R4's audit-plugin story (pure event listener) is unaffected.

### 3.3 Multi-account per provider

`ChannelRegistry.register()` (`packages/channel/src/index.ts:269-278`) throws on a duplicate `id`, and
every provider's `Channel.id` is a fixed string literal (`'telegram'`, `'wechat'`, `'feishu'`). This
means **it is structurally impossible to run two bots of the same platform** — two Telegram bots for two
teams, or a staging + production bot, cannot both be registered. openclaw's plugin-reload model
(`reload.accountScopedRestart`, `types.plugin.ts:73-80`) treats "N accounts per channel plugin" as the
*default* shape, not an edge case; hermes-agent and Raven both parameterize adapters by account/config
instance for the same reason.

**Proposed shape**: this is the one item here that does touch the contract, but narrowly — `Channel.id`
stays the provider-family key (`'telegram'`) for capability-fact purposes, and a second, optional
`accountId` disambiguates instances:
```ts
export abstract class Channel {
  abstract readonly id: string          // provider family, e.g. 'telegram' — unchanged meaning
  get accountId(): string { return 'default' }  // NEW: disambiguates multiple instances of the same id
}
```
`ChannelRegistry` keys its map by `` `${channel.id}:${channel.accountId}` `` internally but keeps
`get(id)`/`list()` working against the bare `id` for the common single-account case (default account id
`'default'` preserves today's behavior with zero config changes for existing deployments). `chatKey`
routing (`channel:<channelId>:<chatKey>` session ids, §3.3 of the base design) gains an optional
`:<accountId>` segment only when an account is non-default, so single-account sessionIds are byte-for-byte
unchanged. This is additive and backward compatible — no existing provider or session id is affected
unless the operator configures a second account.

### 3.4 `mentionsBot` and reactions

Two related, cheap fixes:

- **`mentionsBot` is faked.** `packages/channel-telegram/src/bridge.ts:437` (`ingest()`) hardcodes
  `mentionsBot: false` unconditionally — it never inspects the message's `entities` for a
  `mention`/`text_mention` matching the bot's own id, even though the field has existed in the contract
  since v1 specifically to unblock this (`dsh-channel-design.md` §3.2: "decided by the provider; v1 does
  not route groups, only records"). Wiring this up is a few lines (scan `message.entities` for
  `type: 'mention'` with `text === '@' + botUsername`, or `type: 'text_mention'`) and costs nothing —
  it's pure observation, doesn't change v1's group-drop routing, and unblocks §3.3 of P1 below plus
  Raven/openclaw's `group_policy: 'mention'` mode later.
- **No reaction-based ack.** Every reference project treats "react to the inbound message with an emoji"
  as the cheap alternative to the `ack-long` effect (`packages/channel-kit/src/merge.ts:64-67` emits it;
  each bridge renders it as a full text message, e.g. `packages/channel-telegram/src/bridge.ts:481`,
  `'Received, working on it…'`) or a typing indicator: Slack
  `reactions_add` and Feishu `message_reaction.create` (`raven/channels/adapters/{slack,feishu}/channel.py`)
  fire once, cost one API call, and don't add a visible message to the chat log. Telegram supports the
  same via `setMessageReaction`. This is a genuine UX improvement, not just parity: it replaces a
  sometimes-noisy text message with a near-invisible ack.

**Proposed shape**:
```ts
// Channel — new capability fact + optional method, same "conservative default" pattern as sendTyping
get supportsReactions(): boolean { return false }
async react(_chatKey: string, _messageId: string, _emoji: string): Promise<void> {}
```
`merge.ts`'s `ack-long` effect becomes a provider-side choice: react if `supportsReactions`, else fall
back to today's text ack. No change to `MergeEffect`'s shape — the bridge already owns "what to do for
`ack-long`" (`handleMergeEffects` in each bridge); it just gains a capability check.

---

## 4. P1 — extends the existing contract, no dsh core changes, real but not urgent

| # | Gap | Evidence | Proposed shape |
|---|---|---|---|
| 1 | **Reply-to / quote a specific inbound message** | openclaw `reply` capability + delivery cap `replyTo` (`types.core.ts:289`, `message/types.ts:23`); Raven's outlet.py docstring calls out `reply_to` as inbound-owned and explicitly not yet wired outbound | `InboundMessage.replyToMessageId?: string`; `OutboundMessage.replyTo?: string`; `Channel.get supportsReply(): boolean`. Purely additive, optional fields |
| 2 | **Threads** (forum topics / Slack threads, distinct from reply) | openclaw `threads`, `ChannelThreadingAdapter`; `ChatType.thread` already reserved in dsh-channel's own `ChatType` union but never populated by any provider | `Channel.get supportsThreads(): boolean`; `OutboundMessage.threadId?: string`; router.ts gains a `thread` chatKey variant once a provider actually emits `chatType: 'thread'` |
| 3 | **Silent / no-notification delivery** | openclaw delivery cap `silent` (`message/types.ts:22`) | `OutboundMessage.silent?: boolean`; `Channel.get supportsSilent(): boolean`. Natural fit for `sendLocal`'s status-line pushes (`⏹ Turn ended: …`) and the progress heartbeat (§5.4 of the base design) — those shouldn't buzz the user's phone the way a real answer should |
| 4 | **Delivery reconciliation** (query before blind resend) | openclaw `reconcileUnknownSend` capability, explicitly modeled as distinct from plain retry; hermes' `delivery_ledger.py` still resends-with-marker like dsh-channel does today, so this is openclaw going further than either | `ChannelStore` gains an optional `reconcile?(key): Promise<'confirmed-sent' \| 'confirmed-absent' \| 'unknown'>` a provider *may* implement (e.g. Telegram: search recent chat history for a client-tagged marker string); `recoverDeliveries()` calls it before resending when present, falls back to today's "recovered resend" marker when absent. Strictly additive/optional — R2-style graceful absence |
| 5 | **Interactive/pairing login** (QR, OAuth device flow) | Raven `SupportsLogin` protocol, run once via CLI before `start` (`raven/channels/contract.py:37-41`); openclaw `ChannelPairingAdapter`/`auth` | Not on `Channel` itself (would violate R6 — only some platforms need this). A **sibling optional interface** a provider package may additionally export, e.g. `export interface ChannelLogin { login(opts): Promise<LoginResult> }`, consumed only by a CLI/setup command, never by the bridge runtime. Needed for any future WhatsApp-Web-style or personal-account provider; not needed by any of the three current providers (all use static bot tokens) |
| 6 | **Expose chatKey↔channel binding for proactive push** | Raven's `proactive_engine`/`WakeScheduler` (`raven/proactive_engine/wake.py`) treats "push a message with no preceding inbound message" (cron, monitor, subagent completion) as a first-class case, decoupled from any inbound trigger | Today this is *technically* possible — any plugin can call `ctx.channels.deliver()` directly — but discovering "which channel+chatKey is this session bound to" requires reaching into a bridge's private `sessionChatKeys` map, which no other plugin can do. Add a read-only `ChannelRegistry.chatKeyOf(sessionId): { channel: string; chatKey: string } \| undefined` that each bridge registers into on bind (mirrors `store.bindings()` but registry-wide and cross-provider). This is the one-line seam a future monitor/reminder plugin needs; it does not itself build proactive messaging |
| 7 | **Outbound HTTP proxy support** | hermes-agent `resolve_proxy_url`/`proxy_kwargs_for_bot`/`proxy_kwargs_for_aiohttp` (`gateway/platforms/base.py:434-535`) — treated as a first-class deployment concern (SOCKS/HTTP proxy per bot, no-proxy host matching, macOS system-proxy detection) | None of `TelegramClient`/`WeixinClient`/Feishu client accept a proxy today; all call `fetch` directly. Add an optional `proxyUrl` to each provider's `ChannelBehaviorConfig`-adjacent schema and thread it into the client's `fetch` (via `undici`'s `ProxyAgent` or equivalent). Matters for any deployment where the Telegram/Feishu API isn't directly reachable |

---

## 5. P2 — real, but defer; revisit once a concrete need appears

| Gap | Evidence | Why it waits |
|---|---|---|
| Group `@mention`/`group_policy: open\|mention` routing | openclaw group adapter; Raven `group_policy` config | Blocked on v2 group support landing at all (`router.ts` currently drops all non-direct chats by design — chatnode's stance on prompt-injection surface, unchanged). §3.4's `mentionsBot` fix is the prerequisite, not this |
| Native slash-command registration (`setMyCommands`, Discord app commands) | openclaw `nativeCommands` | Cosmetic discoverability win (commands show in the platform's own UI) over the current text-parsed `/command`; zero functional gap, any provider can add it independently without a contract change |
| Rich/structured payload beyond choices (cards, carousels) | openclaw `payload` capability | High implementation cost per platform, and `OutboundChoice` already covers the actual current need (approval, clarification). Revisit only if a concrete use case needs more than buttons |
| Doctor/heartbeat diagnostics adapter | openclaw `ChannelDoctorAdapter`/`ChannelHeartbeatAdapter`; hermes/Raven's boolean `health_check` | `channel/status` emit already gives policy plugins connect/disconnect/fatal; a structured diagnostics surface is an observability nice-to-have, not a functional gap |
| Directory/contact resolver (username → id lookup) | openclaw `ChannelResolverAdapter`/`ChannelDirectoryAdapter` | Only useful once something needs to resolve a human-typed `@username` (e.g. `/bind` by username instead of raw chat id); no current caller |
| `afterSendSuccess`/`afterCommit` hooks | openclaw | Speculative extension point with no current consumer; §3.2's delivery queue can grow these later if a real cross-cutting need shows up |
| unsend/edit-own-message, polls, message effects | openclaw `unsend`, `polls`, `effects` | Platform trivia with no agent-relevant use case identified in any of the three references beyond their own completeness |

---

## 6. Explicitly not adopting

Documenting what was deliberately left out matters as much as the gap list — these are guardrails
against scope creep on the next few milestones, not oversights.

- **openclaw's ~40-field `ChannelPlugin` object** (`types.plugin.ts`) — a mature, feature-complete
  system that has earned its surface over years and 29 channels. Adopting the *shape* (enumerable
  adapter slots for auth/pairing/groups/mentions/directory/doctor/heartbeat/…) would directly contradict
  R6 and the T7 acceptance ("adding a platform changes no contract"). Every openclaw name used above was
  mined for *vocabulary* (capability fact names), not copied as an adapter-slot interface.
- **Raven's Protocol/structural-typing contract** (`@runtime_checkable class Channel(Protocol)`) — a
  reasonable Python idiom, but `dsh-channel`'s prior alignment work (see the alignment-audit doc)
  confirmed the dsh ecosystem's own convention is abstract classes with capability-fact getters
  (`LlmAdapter`, `FileSystem`). Switching styles now would diverge from every other dsh definition
  package for no benefit.
- **`ask_confirmation`-style default-auto-approve** (`ssrjkk/raven`'s `BaseChannel.ask_confirmation`
  returns `True` by default) — the exact opposite of R8/A6's "never default to allowing." Noted here only
  as a negative example: dsh-channel's `next()`-on-timeout-and-no-answerer design is correct and should
  not be softened toward this.
- **hermes' Docker volume-mount path translation, audio/TTS caching** — no current voice/container
  deployment story in dsh-channel; revisit only if either becomes an actual requirement.

---

## 7. Suggested milestone sequencing

Building on `dsh-channel-design.md` §8 (M0–M6, M0–M3 shipped, M6 media planned):

| Milestone | Scope | Depends on | Status |
|---|---|---|---|
| **M7 — Hardening** | §3.1 media size cap, §3.2 retry/backpressure kit module, §3.4 `mentionsBot` fix + reactions capability | None | ✅ shipped |
| **M8 — Delivery & identity** | §3.3 multi-account (`accountId`), §4.4 reconciliation, §4.6 chatKey↔channel binding exposure | M7's retry/backpressure module | ✅ shipped |
| **M9 — Presentation extras** | §4.1 reply-to, §4.2 threads, §4.3 silent delivery | None additional | ✅ shipped |
| **M10 — Deployment reach** | §4.5 pairing/login sibling interface, §4.7 proxy support | None additional | ✅ shipped |
| **Deferred** | All of §5 (P2) | Revisit when a concrete consumer appears — no scheduled milestone | deferred |

Each milestone should re-run T2 (dependency-direction grep) and T7's "next platform, zero contract
changes" check before landing, per the base design's own acceptance discipline.

### 7.1 Implementation notes (what actually landed)

M8–M10 shipped with two deliberate refinements relative to the proposed shapes above (the rest landed
as proposed):

- **§4.4 reconciliation lives on `Channel`, not `ChannelStore`.** `ChannelStore` stays a pure data layer
  (ledger + flush); a platform-side query is IO and belongs with the other optional `Channel` methods
  (`react`, `sendMedia`). The seam is `Channel.supportsReconciliation` + `reconcile(chatKey, deliveryKey,
  textHash)` defaulting to `'unknown'`. `recoverDeliveries()` consults it for `attempting`/`failed` items
  and skips the resend only on `'confirmed-sent'`. No provider overrides it yet — Telegram's Bot API has no
  "list my sent messages" endpoint, so reconciliation stays a `'unknown'`-returning seam until a provider
  with such an API appears; recovery still falls back to today's "resumed resend" marker (unchanged).
- **§4.7 proxy is implemented on Node builtins, not `undici`'s `ProxyAgent`.** `undici` is not a dependency
  of the kit, so `proxiedFetch(proxyUrl)` (kit `http-proxy.ts`) implements HTTPS-CONNECT tunnelling and
  HTTP absolute-form requests on `node:net`/`node:tls`/`node:http`/`node:https`. It handles JSON, text,
  `Uint8Array`, and multipart `FormData` bodies. Each provider's `ChannelBehaviorConfig` gains `proxyUrl`,
  and each client wraps its injectable `fetch` with it (Feishu's inbound WebSocket is not proxied — only its
  HTTP API calls are).
- **§4.5 `ChannelLogin` is exported from the contract package** (`dsh-channel`), not from a provider — a
  type-only sibling interface + `ChannelLoginResult`, with no runtime. None of the three providers implement
  it (static bot tokens).

M8's `accountId` is a shared `ChannelBehaviorConfig` field; WeChat's pre-existing `accountId` (the iLink
*platform* account) was renamed to `platformAccountId` so the two concepts don't collide. Each provider's
default `resolveStatePath` is account-scoped (`channel-<id>/<accountId>/state.json`) only for non-default
accounts, so the single-account path is unchanged and two bots of the same platform don't share a ledger.

---

## Appendix: Reference index

- openclaw: `src/channels/plugins/types.plugin.ts`, `types.core.ts:283-299` (`ChannelCapabilities`),
  `src/channels/message/types.ts:17-31` (`durableFinalDeliveryCapabilities`), `capabilities.ts`
  (requirement derivation) — commit `191d2313a8a153e68ee803aa8088a3498c3d674a`
- hermes-agent: `gateway/platforms/base.py:758-830` (inbound media limit), `:434-536` (proxy support),
  `:1684-1780` (`validate_media_delivery_path`, SSRF guard) — commit `460d345642ee3d143a3e461abe39fd42b86a7e54`
- `EverMind-AI/Raven`: `raven/channels/contract.py` (`Channel` protocol, `capability_violations`),
  `raven/channels/media.py` (content-hashed storage), `raven/spine/delivery.py`
  (`DeliveryHub`, retry/backpressure), `raven/channels/intake.py`, `raven/proactive_engine/wake.py`,
  `raven/channels/adapters/{slack,feishu}/channel.py` (reaction ack) — commit
  `cd68645388bafce80ae3a69089418e96b95414a3`
