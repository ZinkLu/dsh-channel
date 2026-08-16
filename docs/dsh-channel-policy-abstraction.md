# dsh-channel Handler & Policy Abstraction (slim)

> Status: **implemented** · §5's five migration steps have all landed, most recently
> step 3–4's inbound half: `ChannelBridge.handleInbound` now owns the pipeline the
> three providers used to each carry a copy of. §3's hook list has been reconciled
> with the shipped surface (see the notes under it).
> Originally a design proposal · revises the earlier draft of this document, which proposed a
> three-package split plus a seven-policy strategy object. That version was judged
> over-engineered; this one keeps ~30% of the surface area for ~80% of the value.
> Goal: (1) make the "handler" (what to send, how to handle thinking / tool events /
> LLM responses) a first-class, shared abstraction; (2) open exactly the two policy
> seams that have demonstrated demand — presentation and recovery — and nothing else.

---

## 0. Problem, in one paragraph

Today `dsh-channel` (contract) is clean, but the layer above it has two real diseases:

- The "handler" does not exist as a type. Each provider re-implements ~1000 lines of identical
  orchestration inside its own `Bridge` (`onSessionEvent` → project → frame executor → deliver
  queue worker → startup recovery → approval/prompt broker), and they have **drifted**:
  Telegram handles `tool/call`/`tool/result` + streaming; Feishu/WeChat only handle
  `assistant/message` + `turn/end`.
- Two decision axes are hard-wired where users actually want to vary them:
  **presentation** (thinking is "never shown" via three independent hard-codings; tool-event
  display is fixed) and **recovery** (`recoverDeliveries`' resend/skip/abandon decisions cannot
  be replaced without forking the bridge).

The fix has two moves, detailed below:

1. **Introduce `ChannelBridge`** — a shared abstract base in `dsh-channel-kit` that *is* the
   handler; providers shrink to transport hooks.
2. **Open two policy seams** — `PresentationPolicy` and `RecoveryPolicy`, injected at bridge
   construction, defaulting to today's behavior.

Everything else in the kit stays plain pure functions called directly by the bridge.

---

## 1. Package layout: one package, internal directories

No package split. `dsh-channel-kit` stays the single shared package; the discipline the earlier
draft wanted from a `format → policy → bridge` package chain is enforced by **directory
structure** instead:

```
dsh-channel-kit/src/
  format/     leaf text & transport shaping, no decisions, no state
              (format, chunk, prompt-hint, media-limit, http-proxy)
  policy/     decision logic as pure functions + the two policy interfaces
              (merge, router, stream, tool-display, thinking, deliver-queue,
               recovery, approval-render, prompt-render)
  bridge/     the handler: ChannelBridge base + store + store/json-file
  index.ts    re-exports everything under the existing names (imports stay green)
```

Dependency direction inside the package stays one-way — `bridge → policy → format` — with
`policy/` and `format/` remaining zero-runtime-dependency pure modules (only `bridge/` may
import `@deepseek-ai/cordis` and `dsh-channel`). A lint rule (or just review) guards the
direction. If an external consumer ever needs `policy/` standalone, promoting these directories
to packages is a mechanical move; we do not pay the three-build-configs tax up front.

---

## 2. The two policy seams

Both policies are **stateless strategy objects** (a pure reducer/decision bundle + option
defaults); all mutable state (reducer state maps, timers) stays owned by the bridge —
preserving the existing "pure reducer, timers outside" pattern.

```ts
// dsh-channel-kit/src/bridge/bridge.ts
export interface BridgePolicyOverrides {
  readonly presentation?: PresentationPolicy
  readonly recovery?: RecoveryPolicy
}
```

A provider (or deployment) swaps one at construction time:

```ts
new TelegramBridge({ channel, config, store, policies: { recovery: atMostOnceRecovery } })
```

### 2.1 Presentation policy (thinking / tools / LLM responses)

This is the "what messages to send" axis, now an explicit strategy instead of
`TelegramBridge`'s private `onSessionEvent`/`feedStream`/`executeStreamFrame`.

```ts
export interface PresentationPolicy {
  /** SessionEvent → presentation input (the projection that keeps the reducer pure). */
  project(event: SessionEvent): StreamInput | null
  reduce(state: StreamState, input: StreamInput, caps: StreamCaps, now: number):
    { state: StreamState; frames: StreamFrame[] }
  renderToolCall(name: string, args: string): string
  renderToolResult(name: string, result: { ok: boolean; durationMs?: number; summary?: string }): string
  /** Thinking presentation. Returns a status-line string, or null to discard (default off). */
  renderThinking(input: ThinkingInput): string | null
}

/** Thinking is a level, not a boolean (openclaw ReasoningLevel). */
export type ThinkingLevel = 'off' | 'on' | 'stream'
```

- `project()` replaces the hard-coded `if (event.type === 'tool/call') …` chain in each bridge.
  It returns a `StreamInput` (`turn-start` / `tool-call` / `tool-result` / `reasoning-delta` /
  `text-delta` / `assistant-message` / `turn-end` / `tick`) or `null`.
- `renderThinking` centralizes what is today scattered across `stream.ts` (`reasoning-delta` →
  noop) and `assistantMessageText()` (drop non-`text` blocks). Default `ThinkingLevel = 'off'`
  → `null` (discard). `'on'` → fold the final reasoning block into a status line. `'stream'` →
  status line per delta. The *sanitization* (never leak chain-of-thought in visible text) is
  unchanged and stays in `format.stripReasoningTags`.
- `thinkingLevel: ThinkingLevel` replaces the boolean `Channel.supportsThinking` capability;
  the boolean stays on `Channel` as a deprecated alias during the transition.
- Default implementation = today's `streamReduce` + `tool-display` + "thinking off".

The three providers then share one presentation pipeline; Feishu/WeChat stop missing
`tool/call`/`tool/result` handling — they just have `streamingMode='off'` capability facts and
the reducer degrades to `final`-only automatically.

### 2.2 Recovery policy (startup crash recovery)

The decision layer over the delivery ledger: given the sweep of recoverable entries, decide
resend / skip / abandon. Reconciliation is **not** a separate policy — `Channel.reconcile` is
already the seam (a capability fact with a graceful-absence default), so the policy consumes
the channel directly.

```ts
export interface RecoveryContext {
  readonly store: ChannelStore
  readonly channel: Channel          // for supportsReconciliation + reconcile()
}

export interface RecoveryPolicy {
  sweep(entries: readonly RecoverableDelivery[], ctx: RecoveryContext): Promise<RecoveryAction[]>
}

export type RecoveryAction =
  | { readonly kind: 'resend'; readonly item: RecoverableDelivery; readonly marker?: string }
  | { readonly kind: 'skip'; readonly item: RecoverableDelivery; readonly reason: string }     // reconciled: already sent
  | { readonly kind: 'abandon'; readonly item: RecoverableDelivery; readonly reason: string }  // give up (unparseable key, cap)
```

`DefaultRecoveryPolicy` maps 1:1 onto today's `TelegramBridge.recoverDeliveries`:
unparseable/unavailable → `abandon`; reconcile `confirmed-sent` → `skip`;
`confirmed-absent`/`unknown`/pending → `resend` with a `"(resumed resend, may duplicate)"`
marker. Example replacements this unlocks:

```ts
const atMostOnceRecovery: RecoveryPolicy = {        // never redeliver blindly
  async sweep(entries) {
    return entries.map((item) => ({ kind: 'abandon', item, reason: 'at-most-once: no blind resend' }))
  },
}

const blindResendRecovery: RecoveryPolicy = {       // always resend, skip the reconcile check
  async sweep(entries) {
    return entries.map((item) => ({ kind: 'resend', item, marker: '(resumed resend, may duplicate)\n' }))
  },
}
```

---

## 3. `ChannelBridge`: the handler abstraction

`dsh-channel-kit/src/bridge/` owns the shared skeleton. Every `if` that today lives in a
concrete bridge becomes either a **policy call** (the two seams above), a **direct call into a
kit pure function** (merge, route, deliver-queue, render, chunk — no interface wrapper), or an
**abstract transport hook**.

```ts
export abstract class ChannelBridge<TCfg> {
  protected readonly channel: Channel
  protected abstract readonly config: TCfg
  protected readonly store: ChannelStore
  protected readonly presentation: PresentationPolicy   // default: today's behavior
  protected readonly recovery: RecoveryPolicy           // default: today's behavior

  constructor(opts: { channel: Channel; store: ChannelStore; policies?: BridgePolicyOverrides })

  async start(): Promise<void>   // subscribe session/event + approval/request; restore(); connect()
  async stop(): Promise<void>    // dispose listeners/timers; settle pending; flush store

  // ---- inbound: the whole pipeline, in the order the design pins down ----
  // group drop → allowlist → echo suppression → dedupe → approval/prompt reply
  // → ingest → command → media → merge. `raw` is the untouched platform payload,
  // handed back to downloadInboundImages.
  protected async handleInbound(inbound: InboundMessage, raw?: unknown): Promise<void>
  protected async handleInboundReply(text: string): Promise<boolean>

  // ---- outbound (shared: project → reduce → executeFrame, deliver queue, recovery) ----
  protected onSessionEvent(session: Session, event: SessionEvent): void
  protected executeStreamFrame(sessionId: string, chatKey: string, frame: StreamFrame, deliveryCtx?: { seq?: number }): void
  // Both enqueue onto the chatKey's single serial worker rather than sending
  // inline, so bridge-authored text cannot interleave with agent output.
  protected sendOutbound(chatKey: string, markdown: string, deliveryKey: string, opts?: SendOpts): void
  protected sendLocal(chatKey: string, markdown: string, opts?: { silent?: boolean }): void

  // ---- abstract transport hooks (the ONLY per-platform surface) ----
  protected abstract connect(): Promise<void>
  protected abstract disconnect(): Promise<void>
  protected abstract isAllowed(senderId: string): boolean
  // Optional, with degrading defaults rather than `abstract`: a provider that
  // downloads no media or cannot stream drafts simply does not override them.
  protected async downloadInboundImages(raw: unknown): Promise<ImageAttachmentRef[]>
  protected async showDraft(chatKey: string, sessionId: string, text: string): Promise<void>
  protected async deleteDraft(chatKey: string, target: string): Promise<void>
}
```

Two shape notes against the sketch above, decided while implementing it:

- **`normalize` is not on the base.** Its return type is the only thing the base
  needs, and its input is by definition per-platform, so each provider keeps a
  private `normalize()` and passes the result to `handleInbound`. Making it
  abstract would have forced a `unknown` parameter on every provider for no gain.
- **There is no separate `editDraft` hook.** `showDraft` creates the draft on
  first call and edits it thereafter, because the provider already owns the
  "do I have a draft message id for this session?" branch. A platform that
  streams append-only is the case that would split the hook.

What this buys:

- **The handler is one class, written once.** `onSessionEvent → project → reduce →
  executeFrame`, the deliver-queue worker, and startup recovery are identical across platforms.
- **Providers shrink to transport.** `TelegramBridge` keeps only: `connect()` (long-poll loop),
  `normalize()` (Telegram update → `InboundMessage`), `downloadInboundImages()` (getFile),
  `showDraft/editDraft/deleteDraft` (sendMessage/editMessageText/deleteMessage), and
  callback-query parsing. Feishu/WeChat implement the same hooks (Feishu uses WebSocket
  connect, plain-text render — the hook surface is identical).
- **Capability differences stay out of the handler.** `streamingMode='off'` (Feishu/WeChat)
  makes the default `PresentationPolicy` degrade to `final`-only with zero per-platform
  branching, because the capability facts — not the handler — drive the degradation.

---

## 4. Deliberate non-goals (considered and rejected)

Recorded so the next reader knows these were choices, not oversights:

- **No package split.** A three-package `format`/`policy`/`bridge` layout buys dependency
  hygiene we can get from directories + review, at the cost of three build configs, version
  coupling, and a re-export shim. Revisit only when an external consumer needs `policy/`
  standalone.
- **No `MergePolicy` / `RoutePolicy` / `DeliveryPolicy` / `InteractionPolicy` /
  `FormatPolicy`.** None of these has a second implementation with demonstrated demand. They
  stay plain pure functions called by the bridge; promoting one to an interface later is a
  mechanical, non-breaking refactor (rule of three: abstract on the second real
  implementation, not before).
- **No `ReconcilePolicy`.** `Channel.reconcile` is already the reconciliation seam;
  wrapping it in a policy whose default implementation is "delegate to `Channel.reconcile`"
  would be a second door-frame on the same door.

---

## 5. Migration path (keeps A5: adding a platform changes no contract/kit line)

1. **Reorganize the kit into `format/` / `policy/` / `bridge/` directories, no behavior
   change.** `index.ts` keeps every existing export name; providers and tests stay green.
2. **Introduce the two policy interfaces + defaults** wrapping the existing reducers
   (`DefaultPresentationPolicy` = `streamReduce` + `tool-display`; `DefaultRecoveryPolicy` =
   extracted `recoverDeliveries` decisions). No consumer changes yet — the recovery seam is
   usable even before the bridge extraction lands.
3. **Extract `ChannelBridge`** and re-home `TelegramBridge` onto it (the riskiest step;
   existing bridge tests are the safety net).
4. **Port Feishu/WeChat onto `ChannelBridge`**, which silently fixes their missing
   tool/streaming handling (they get `final`-only degradation for free).
5. **Add `thinkingLevel`** to `Channel` (deprecate the `supportsThinking` boolean) and wire it
   through `StreamCaps` → `renderThinking`.

Each step is independently shippable.

---

## 6. Honest flags / open items

- **`userQuestions` provider scope** (carried over from the live-interaction design §6 Q1) is
  still the one unverified risk for moving the approval/prompt broker into the shared bridge;
  it does not block steps 1–2.
- **Draft transport hooks** assume "one editable status message per session" (Telegram model).
  If a future platform streams differently (e.g. append-only), the hook surface — not the
  handler — grows; that is the intended place for such variance.
- **Policy objects stay stateless.** If a policy ever needs warm-up state, that state lives on
  the bridge, not in the policy.
