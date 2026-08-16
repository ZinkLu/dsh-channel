# dsh-channel Mechanism Gap Analysis & Roadmap

> Status: M11–M13 shipped, then audited against the tree — see §10 (M14) for what the audit
> found and closed · Date: 2026-08-16 · Baseline: post-refactor `81a49e2` (ChannelBridge + policy seams)
> Companion to: `dsh-channel-capability-roadmap.md` (capability *facts* — what the contract exposes; M7–M10
> shipped) · this document covers capability *mechanisms* — how the shared layer behaves under
> concurrency, failure, and recovery. · Architecture upstream: `docs/dsh-channel-policy-abstraction.md`
> Research baseline: `openclaw@bba57301` · `NousResearch/hermes-agent@56526bc0` (both cloned 2026-08-16,
> implementation layer read directly — the prior pass mined only their capability vocabulary)

---

## 0. TL;DR

The capability roadmap asked "which capability facts are missing?" and answered it through M10. This
pass asked a different question of the same two reference systems: **which mechanisms did they build
because production forced them to** — debounce edge cases, mid-turn arrivals, crash-ambiguous sends,
edit-rate floods, webhook redelivery — and which of those does dsh-channel not have yet?

Findings, verified line-by-line against the post-refactor `ChannelBridge` code:

- **§2 (P0): four defects in shipped code.** The merge reducer destroys message boundaries (a bug
  hermes has on record) and can starve under continuous typing; the ledger's abandon/attempt
  accounting loses messages in two specific scenarios; inbound dedupe cannot distinguish "in
  progress" from "done" from "gave up".
- **§3 (P0/P1): the busy-turn seam.** The refactor already wires `agent.steer()` for mid-turn
  arrivals — but as a hard-coded call, not a policy: no fallback when steering isn't possible, no
  queue mode, no serialization on the resolved sessionId even though `/bind` already makes
  chatKey→sessionId many-to-one.
- **§4–§5 (P1): streaming failure paths and an error taxonomy.** Edit-in-place has no degradation
  story mid-stream; `DeliveryReceipt.error` is an unclassified string, so neither the deliver queue
  nor the recovery policy can distinguish "user blocked the bot" (never retry) from "flood control"
  (back off) from "transient" (retry).
- **§6 (P0, cheapest first): test discipline.** Both references converge on the same three-part
  answer (shared conformance suite, wire-trace goldens, capability proofs) — and hermes' docs show
  what happens without it (a 16-point manual checklist ending in a grep).

The refactor is an ally, not a conflict: nearly every adoption below lands in exactly one place —
`ChannelBridge`, one of the two policy seams, or a single kit reducer — instead of three provider
bridges. Several findings from the research were already closed by it (noted inline in §7).

---

## 1. Method

| Project | What was read (this pass) | Relation to the prior pass |
|---|---|---|
| [openclaw](https://github.com/openclaw/openclaw) | `src/channels/` implementation layer: `message/` (ingress queue/drain/lifecycle, live preview, contracts), `inbound-debounce*`, `progress-draft-compositor`, `typing*`, `outbound-echo`, `conversation-resolution`, `turn/delivery-result`, test structure (262 src / 199 test files) | Prior pass read only `types.plugin.ts`/`types.core.ts` (vocabulary); the mechanisms were unread |
| [hermes-agent](https://github.com/NousResearch/hermes-agent) | `gateway/run.py` (busy handling, approval routing, FIFO), `turn_lease.py`, `delivery_ledger.py`, `stream_consumer.py`, `session.py`, `platforms/base.py` error taxonomy, `webhook.py` dedupe, `tools/clarify_gateway.py`, `ADDING_A_PLATFORM.md` | Prior pass read the `base.py` helper layer (media caps, proxy, SSRF); the gateway orchestration above the adapters was unread |

Every dsh-channel claim below was re-verified against the post-refactor tree (`81a49e2`), not the
pre-refactor layout the research initially ran against. Findings the refactor already resolved are
listed in §7 rather than silently dropped.

---

## 2. P0 — defects in shipped code

### 2.1 Merge flush destroys message boundaries

`ChannelBridge.flushBuffered` and the merge reducer's flush both join the buffer with `'\n'`
(`packages/channel-kit/src/bridge/bridge.ts:345`, `packages/channel-kit/src/policy/merge.ts:84,98`),
so N separate user messages become one mashed-together turn. hermes has this exact bug on record —
`run.py:9628-9635` documents that newline-joining consecutive texts "destroys message boundaries" and
was replaced by a per-content-type policy: **media merges (album semantics), text does not** — each
text message becomes its own turn, in arrival order.

**Proposed shape:** `MergeState.buffer` becomes `readonly string[][]` (one entry per message);
`flush` emits one effect per entry (or one `flush` effect carrying `texts: string[]` and the bridge
dispatches sequentially). The debounce window still coalesces the *wait*, just not the *identity*.
`InboundMessage.messageIds` already models "multiple platform messages per turn" — the fix aligns the
reducer with the contract's own plural.

### 2.2 Merge window can starve under continuous typing

Every message resets `deadline = now + windowMs` (`merge.ts:76,90`) — a user who keeps typing
postpones the flush indefinitely. openclaw caps the total wait at `firstArrival + debounceMs × 5` on
a monotonic clock (`inbound-debounce.ts:140-141,341-355`), keeping the *first* item's deadline fixed
so continuous arrivals (or wall-clock steps) cannot hold the lane forever.

**Proposed shape:** add `MergeState.firstAt`; `mergeReduce` computes
`deadline = min(now + windowMs, firstAt + windowMs * maxWindowMultiplier)` (option, default 5).
One field, one `min()`, one test.

### 2.3 Ledger abandon/attempt accounting loses messages twice over

Two independent defects in `bridge/store.ts` + `policy/deliver-queue.ts`:

- **Abandon requires only an attempts cap** (`store.ts` `sweepRecoverable`: `attempts >= maxAttempts
  → abandoned`). openclaw's ingress retry policy requires **both** an attempt floor *and* a minimum
  age (`ingress-retry-policy.ts:77-89`): attempts-only discards a message during a five-minute
  platform outage; age-only never gives up on a poisoned payload. hermes' ledger uses the same dual
  condition (3 attempts *or* >24h → abandoned, but attempts are only counted per §below).
- **The attempt budget burns without a connected channel.** `markAttempting` increments on every
  attempt, including ones that fail because the provider never connected this boot. hermes gates
  claiming on `deliverable_platforms` (`delivery_ledger.py:295-301`) — a platform that fails to
  connect must not consume the budget, or three restarts abandon a message that was never once sent.

**Proposed shape:** `sweepRecoverable` takes `{ now, minAgeMs }` and abandons only on
`attempts >= max && now - createdAt >= minAgeMs`; the bridge calls `recover()` only after
`channel/status` reaches `connected` (today it runs unconditionally in `restore()`,
`bridge.ts:265-285`). Both are small; both are the kind of loss that only shows up in incident
review.

### 2.4 Inbound dedupe has no outcome, and backpressure rejection silently drops chunks

- `store.seenInbound` is a boolean ring (`store.ts`) — it cannot distinguish "seen, still being
  processed" / "seen, answered" / "seen, gave up", which are three different correct responses to a
  webhook redelivery. openclaw models dedupe as queue tombstones — the enqueue result is a
  discriminated union `accepted | pending | claimed | completed | failed`
  (`ingress-queue.ts:143-169`) with TTL + cap + protected-ids pruning. hermes adds the second half:
  a TTL map with **amortized** pruning (prune on size trigger, not per-POST;
  `webhook.py:426-461`).
- `deliver-queue.ts:84-86` answers a full queue with `reject-backpressure`, and the bridge maps that
  straight to `markFailed` (`bridge.ts:844-846`) — for a multi-chunk message this silently drops the
  overflowing chunks of an answer whose earlier chunks were delivered. That is the partial-delivery
  problem of §5.2 arriving early through the back door.

**Proposed shape:** upgrade `markInbound` to `markInbound(id, outcome: 'handling' | 'done' |
'failed')` with a TTL'd map behind the same interface; make `reject-backpressure` distinguishable in
the ledger (`failed` with a dedicated error kind per §5.1) so recovery treats it as retryable rather
than terminal.

---

## 3. P0/P1 — the busy-turn seam

The refactor's `dispatchText` already handles mid-turn arrivals:
`agent.status === 'running' ? agent.steer(message) : agent.followup(message)`
(`bridge.ts:476-480`). That is ahead of where the research expected — but it is a hard-coded call,
and both references show what grows at this exact spot:

### 3.1 Busy policy: steer → queue → interrupt, as a policy with a mandatory fallback chain (P1)

hermes' `busy_input_mode` (`run.py:9717-10161`) offers `interrupt | queue | steer`, with two
properties worth keeping even if dsh-channel only ever defaults to steer: **every tier is
capability-gated and degrades downward, and nothing is ever dropped** (`steer()` returning false →
queue; `run.py:9932-9940`). It also carries two demotion rules discovered in production: while
subagents are active or compression is in flight, interrupt demotes to queue with a distinct
user-facing ack (`run.py:9884-9905`).

**Proposed shape:** a third policy seam is *not* needed — this is one decision function
`resolveBusyAction(agentStatus, messageKind, caps) → 'steer' | 'queue' | 'followup'` in
`policy/`, called from `dispatchText`, with the queue case landing in the merge layer (a message
"queued behind the running turn" is a merge buffer whose flush condition is turn-end). What must be
adopted from day one is the fallback rule: if `steer` is unavailable or fails, the message is
buffered, never dropped. dsh's `agent.steer()` return/throw semantics should be pinned down as part
of this.

### 3.2 Turn serialization keyed by resolved sessionId (P1, design decision now)

hermes' `turn_lease.py` exists because busy-guards keyed by *routing key* miss the many-to-one case:
two chats bound to one session run interleaved turns and corrupt the transcript
(`turn_lease.py:3-15`). dsh-channel is already exposed: `/bind <sessionId>`
(`bridge.ts:945-955`) lets any chatKey attach to any sessionId, and nothing serializes
`dispatchText` per *sessionId* — two chats bound to the same session will interleave
`followup()`/`steer()` calls.

**Proposed shape:** a per-sessionId in-flight guard in `ChannelBridge` (acquire after route
resolution is final, release in `finally`), with hermes' two hard-won rules stated as contract:
release is identity-checked (a stale unwind can never free a newer turn's guard), and on
timeout the turn is rejected visibly, never run unserialized. Kit stays pure — the guard is bridge
state, like timers.

### 3.3 Two-phase inbound ownership (P2, vocabulary now)

openclaw splits "this inbound is safely owned by a turn" (admission — releases the debounce lane)
from "this turn completed" (completion — settles retry bookkeeping)
(`ingress-drain-lifecycle.ts:1-31`, `inbound-debounce.ts:49-53`). dsh-channel's
`markInbound`-after-dispatch is a single-phase version. Full adoption is premature (it matters most
with a durable inbound queue), but §2.4's outcome states should use the openclaw lifecycle
vocabulary (`adopted / deferred / abandoned`) so the upgrade path stays open.

### 3.4 What the refactor already closed here

Approval replies are intercepted **before** merge/dedup/dispatch (`channel-telegram/src/bridge.ts:175-179`,
comment citing the control-command iron rule) — so hermes' approval-while-busy deadlock
(`run.py:9764-9772`: the "yes" queues behind the turn that is blocked waiting for it) is already
structurally prevented. Keep it that way: any future busy/queue policy must run *after*
`handleInboundReply`, and that ordering belongs in this document as a named invariant.

One refinement remains: when the approval prompt itself fails to send, the bridge waits out the full
`approvalTimeoutSec` before deferring (`bridge.ts:1032-1038` catch + `:1005-1008` timer). hermes
resolves immediately as blocked (`approval.py:3504-3510`) — the user demonstrably cannot answer, so
waiting only delays the turn. Resolve `deferred` on send failure instead of arming the timer.

---

## 4. P1 — streaming failure paths

Today's draft pipeline (`showDraft`/`editDraft`/`deleteDraft` hooks + `stream.ts` reducer) models the
happy path; failures only log (`bridge.ts:736-738`). The references contribute three mechanisms, all
pure-state-machine additions:

| # | Mechanism | Evidence | Proposed shape |
|---|---|---|---|
| 1 | **Edit-failure → append-tail degradation.** When edit-in-place dies mid-stream, record the visible prefix, flip to append mode permanently, send only the tail — one continuous answer instead of a duplicate or a frozen draft | hermes `stream_consumer.py:1305-1317` (`_visible_prefix`/`_continuation_text`), `:2275-2298` ("already visible" short-circuit suppresses the duplicate final send) | `StreamState` gains `visiblePrefix` + an `edit-failed` input; on it, emit `send-tail` frames thereafter. The bridge feeds `edit-failed` from `showDraft` rejection instead of only warning |
| 2 | **Adaptive edit throttle with strike reset.** Flood → interval doubles; any success → strikes reset to zero (self-healing, not permanently degraded); server `retry_after` honored only up to a ceiling (~5s) — beyond that, fail over rather than stall the user | hermes `stream_consumer.py:2328-2367`, `:2270-2271` (reset), `:260` (ceiling) | Options + two fields on the draft-edit path (kit reducer); the ceiling also belongs in `deliver-queue.ts`'s retry handling once §5.1 gives it a `rate_limited` kind to react to |
| 3 | **Draft finalization as an explicit decision.** Today the bridge always deletes the draft and sends the final fresh (`bridge.ts:752-763`). openclaw models finalize-in-place vs discard-and-send as a four-outcome decision (`normal-delivered / normal-skipped / preview-finalized / preview-retained`) including the `retain` branch for "the edit may or may not have landed" and the invariant that a finalized text preview must not silently swallow accompanying media | openclaw `message/live.ts:117-236` | A pure `resolveFinalization(caps, draftState, editResult)` in `policy/`; providers whose edit is cheap (Telegram) finalize in place — one message instead of delete+send, which also stops the notification double-buzz. **See §10.1**: the function shipped in M13 but was never called, and `preview-finalized` turns out to be unreachable until block streaming (v2) |

Related invariant to record (openclaw `progress-draft-compositor.ts:227-247`): if/when draft updates
gain change-detection, **only accepted renders may become the dedupe baseline** — a policy-suppressed
or rate-limited update that sets the baseline wedges the draft permanently ("text unchanged, skip"
against text that never rendered).

---

## 5. P1 — outbound error model

### 5.1 SendErrorKind: a seven-value machine-readable taxonomy

hermes normalizes every platform send error to
`too_long | bad_format | forbidden | not_found | rate_limited | transient | unknown`
(`platforms/base.py:2484-2520`), with one sharp refinement: `not_found` is split by blast radius
(`:2522-2536`) — "chat not found" (target dead, stop delivering there) vs "message to edit not
found" (parent chat fine, only the edit target is gone), and when both markers appear the
chat-alive reading wins.

dsh-channel's `DeliveryReceipt` carries only `status + error: string`. Without the taxonomy, neither
`deliver-queue.ts` (retry or not?), nor `RecoveryPolicy` (resend or not?), nor waterfall policy
plugins can branch without regex-matching Telegram strings. Two rules the ledger needs on day one:
`forbidden` → never retry, never surface a notice into that chat (there is nowhere to surface it);
`rate_limited` → honor `retryAfterMs` up to the §4.2 ceiling.

**Proposed shape:** `DeliveryReceipt.errorKind?: SendErrorKind` + optional `retryAfterMs`, populated
by each provider's client from platform error codes (the classification tables live in the provider
packages; the enum lives in `dsh-channel`). `deliver-queue.ts` gains an injectable
`classify?: (error) => 'retryable' | 'fatal'` defaulting off the kind.

### 5.2 Partial delivery is representable

A three-chunk answer failing on chunk 3 currently yields `failed` with the successful
`platformMessageIds` discarded (`packages/channel/src/index.ts` deliver catch). openclaw's
`CHANNEL_PARTIAL_DELIVERY` error carries `deliveryResult` + `sentBeforeError: true`
(`turn/delivery-result.ts:27-47`) so the caller can retry only the remainder — and matches by stable
`code`, not `instanceof`, because plugins may resolve duplicate module instances (a hazard
dsh-channel's three provider packages share).

**Proposed shape:** `DeliveryReceipt` for a failed multi-part send keeps `platformMessageIds` of the
parts that made it, plus `failedAtChunk?: number`; the per-chunk delivery keys
(`${deliveryKey}:${i}`, `bridge.ts:805`) already give the ledger the granularity — recovery then
resends only unconfirmed chunks.

> Shipped in M13, but the `:${i}` key shape was not parseable back to its session event — sessionIds
> contain colons themselves. See §10.2; chunk keys use `#${i}` and recovery resends only the named chunk.

### 5.3 `unknown` is not `failed`

`store.ts` conflates "definitively rejected" with "crashed mid-send, may have landed". Both
references distinguish them: hermes' `attempting` state exists purely to encode crash ambiguity and
its recovery resends with a visible recovered-marker (already dsh-channel's behavior); openclaw goes
further for the irreducible case — a one-time, idempotent, same-route-only *notice* ("I couldn't
confirm my previous reply reached you") instead of any automatic resend
(`pending-delivery-notice.ts:14-50`). With the `RecoveryPolicy` seam now in place, this is exactly
one alternative policy (`noticeOnUnknownRecovery`) plus one honest state name. Low urgency, near-zero
cost, and it hardens the seam's contract: `failed` = retryable, `unknown` = never blind-resend.

### 5.4 Outbound echo suppression

Platforms that replay the bot's own messages through the inbound path cause self-loops. Telegram's
bridge filters `message.from?.is_bot` — which also silently drops *other* bots (fine for v1) but
does nothing for platforms without a reliable bot flag (WeChat personal accounts). openclaw's
mechanism (`outbound-echo.ts:19-70`): remember `(channel, account, chat, messageId|sourceId)` of own
sends for 30s in a bounded map; drop inbound matches. The ledger already records
`platformMessageIds` on delivery — the kit reducer is ~40 lines and WeChat needs it first.

---

## 6. P0 — test discipline (cheapest, do first)

Both references converge here, from opposite directions: openclaw built the machinery; hermes'
`ADDING_A_PLATFORM.md` documents life without it — 16 manual integration points, verified by
grepping the codebase for other platforms' names (`:392-404`). dsh-channel's small surface makes the
machinery nearly free, and every §2–§5 adoption should land with it already in place:

1. **Installable conformance suite.** `dsh-channel` (or a test-support export of the kit) ships
   `installChannelContractSuite({ createHarness, chunking })`; each provider package calls it and
   gets the shared behavioral battery — send/chunk/degrade/choices semantics — against its own
   mocked client. openclaw's refinement: variant-driven assertions (`chunking: split | passthrough`
   runs *different* assertions), never skipped ones (`contracts/outbound-payload-testkit.ts:47-53`).
2. **Capability facts require proofs.** For every `supportsX === true` the suite demands a proof
   callback and fails the provider's build without it (openclaw `message/contracts.ts:119-142`,
   iterating the canonical capability list so non-declaration is recorded, not skipped). This is the
   behavioral upgrade of Raven's `capability_violations` (which only checked protocol presence).
3. **Delivery-trace goldens.** A shared scenario library (streaming-happy, final-only,
   cancel-mid-stream, rate-limit-during-preview, media-with-caption, overflow-pagination) replayed
   per provider under fake timers with scripted wire faults; the observed client-call sequence is
   canonical JSONL, verified by default, re-recorded via an env flag (openclaw
   `contracts/trace/delivery-trace.ts`). The kit's pure-reducer/timers-outside design makes this the
   cheapest possible regression net for "did refactoring the shared layer change what Telegram
   actually puts on the wire" — precisely the risk profile of the `ChannelBridge` extraction that
   just happened. Detail worth copying verbatim: a fixed **non-zero** epoch for the fake clock
   (throttle state seeded with `lastSent=0` reads epoch-0 as "just sent").

Colocation note: openclaw names test files by *failure mode* (`ingress-drain.watchdog.test.ts`,
`progress-draft-compositor.visibility.test.ts`) rather than splitting by size — worth adopting as
the kit's tests grow past one file per module.

---

## 7. Findings already closed by `81a49e2` (recorded so they aren't re-proposed)

| Research finding | Where the refactor covers it |
|---|---|
| Mid-turn arrivals unmodelled | `agent.steer()` wired in `dispatchText` (`bridge.ts:476-480`); §3.1 upgrades it from hard-coded to policy |
| Approval-while-busy deadlock | `handleInboundReply` runs before merge/dispatch (`channel-telegram/src/bridge.ts:175-179`); §3.4 names the ordering invariant |
| Reaction-based ack | `ackLong` reacts when `supportsReactions`, falls back to text (`bridge.ts:390-401`) |
| Code-fence chunk splitting | `chunk.ts` treats fenced blocks as atomic and re-fences on hard split (`format/chunk.ts:139-179`); still missing: single-backtick balancing and mid-stream truncation closure — relevant only when `block` streaming lands (v2) |
| Callback-id wire convention | `appr:<num>:<0|1>` / `prompt:<num>:<idx>` already defined in kit renderers and parsed by `handleInboundChoice` — cross-provider by construction |
| Presentation never breaks the agent loop | Every `executeStreamFrame` branch catches and warns (`bridge.ts:725-750`) — keep as an explicit rule in the conformance suite (§6.1) |
| Prompt-injection via sender display names | Not yet relevant: v1 routes only direct chats; becomes a requirement with group routing (tracked in capability roadmap §5 P2) |

Small residue worth one line each: typing has only a 5s throttle (`bridge.ts:784-791`) — openclaw's
trio (skip-while-in-flight, failure circuit breaker with a `tripped` state, 60s TTL force-stop) is a
small kit module all providers would otherwise diverge on. `parseApprovalReply` is two-outcome
(`answer | not-an-answer`); hermes' clarify flow splits `not-an-answer` into *invalid selection
attempt* (re-prompt) vs *free prose* (release the prompt, route as normal turn) with a prose escape
hatch that prevents the re-prompt loop (`clarify_gateway.py:226-283`) — worth folding into
`prompt-render.ts` when prompts get retry UX. `route()`/resolver chains should adopt tri-state
results (`null` = explicit rejection stops the chain, `undefined` = no opinion) plus a provenance
tag (openclaw `conversation-resolution.ts:30-49`) — cheap now, unretrofittable after more resolvers
exist.

---

## 8. Explicitly not adopting

- **hermes' 1+N busy queue structure** (`_pending_messages` slot + `queued_events` overflow) — an
  artifact of retrofitting a FIFO onto a single-slot design; §3.1's merge-buffer-as-queue is the
  clean form.
- **openclaw's multi-process claim machinery** (`ingress-claim-owner.ts`: pid+starttime identity,
  `/proc` parsing) and hermes' cross-process ledger claim protocol — correct engineering, wrong
  process model; dsh-channel bridges are single-process per provider. Revisit only with a
  multi-worker deployment story.
- **hermes' dead-target registry** (`dead_targets.py`) — pays off with fan-out/cron delivery; §5.1's
  `forbidden`/chat-level-`not_found` kinds capture the per-delivery decision without the registry.
- **A third policy seam for busy handling** — §3.1 is one pure decision function; promoting it to a
  seam violates the policy-abstraction doc's own rule of three.
- **openclaw's admission evidence graph, session envelopes, route projections** — compliance/audit
  machinery and legacy-shape reconciliation; the latter is a cost to avoid, not a mechanism to copy.

---

## 9. Suggested milestone sequencing

Continues the capability roadmap's numbering (M7–M10 shipped there):

| Milestone | Scope | Rationale for the order | Status |
|---|---|---|---|
| **M11 — Safety net + P0 defects** | §6 conformance suite + capability proofs + trace goldens; then §2.1–§2.4 fixes landed against that net | The four §2 fixes all touch merge/store/deliver-queue semantics — exactly what the goldens exist to guard; building the net first makes every later milestone cheaper | shipped |
| **M12 — Busy-turn seam** | §3.1 busy decision function + steer fallback, §3.2 sessionId serialization guard, §3.4 approval-ordering invariant + fail-fast on undeliverable prompt | These three interlock (all sit on the `dispatchText` path) and should be designed together | shipped |
| **M13 — Failure-path hardening** | §5.1 error taxonomy + §5.2 partial delivery + §5.4 echo suppression; §4.1–§4.3 streaming degradation | Taxonomy first — §4's throttle and §5.3's policies both consume the kinds | shipped |
| **M14 — Post-M13 audit** | Verify M11–M13 against the tree rather than the commit messages; close what the audit turned up (§10) | Three milestones landed back to back; the claims deserved a read | shipped |
| **Deferred** | §3.3 two-phase ownership (vocabulary only now), §5.3 notice-on-unknown policy, §7 residue items | Each has a named trigger (durable inbound queue / operator demand / prompt-retry UX) | deferred |

Per the base design's discipline, each milestone re-runs T2 (dependency direction) and T7
(add-a-platform, zero contract changes); M11's suite makes T7 executable instead of aspirational.

---

## 10. M14 — post-M13 audit

M11–M13 landed in quick succession and this document marked them shipped. Reading
the tree against the claims found one adoption that was written but never wired,
and several defects in code the milestones had touched. All are closed; each is
recorded here so the roadmap describes the tree rather than the intent.

### 10.1 Claimed but not wired

**§4.3 draft finalization.** `resolveFinalization` existed in `policy/` with unit
tests for all four outcomes, but no caller: `finalizeDraft` deleted the preview
unconditionally. The bridge now runs the decision. `preview-finalized` is
unreachable in v1 and is documented as such at the call site instead of being
faked — nothing renders the answer into the preview until block streaming (v2),
so `finalVisible` is always false. The live split is discard vs **retain**, and
retain was the branch that mattered: in append-tail mode the preview holds the
prefix the user saw, so deleting it erased visible context and orphaned the tail
status lines.

Two further defects on the same path, both of which made §4.1's degradation a
no-op in practice:

- On edit failure the reducer flipped to append-tail mode but **dropped the update
  that failed**, so its content reached the user by no route at all.
- The bridge passed the *failed* draft text as `visiblePrefix` — precisely the one
  thing the user had not seen — which made every computed tail empty. The
  baseline is now the last render the platform *accepted*, which is also the
  openclaw invariant this document already recorded under §4 ("only accepted
  renders may become the dedupe baseline"). `draft-finalize` carries the
  edit-failure fact, since the reducer resets its state in the same step.

### 10.2 Defects found in milestone code

| Where | Defect |
|---|---|
| §5.2 per-chunk keys | Chunk keys were `${sessionId}:${seq}:${i}`, but sessionIds contain colons (`channel:telegram:42`), so `splitDeliveryKey`'s last-colon split resolved to no event and the recovery policy abandoned **every multi-chunk answer** as "session event unavailable". Chunk keys now use `#N`, and recovery resends only the chunk the key names |
| §2.3 attempt budget | The not-connected guard was applied to all deliveries, not just ledger-tracked ones, so local notices (including "you are not authorized") were silently dropped whenever the bridge had not reached `connected` |
| §2.3 recovery gate | Recovery ran only if `connected` arrived within 15s of `start()`; a slower first connect skipped it for the process lifetime. It is now memoized and also triggered by the status listener |
| §2.4 dedupe outcomes | `markInbound(id, 'failed')` was in the interface and never produced by any caller; a throw mid-pipeline now records it |
| R7 log folding | `markSeenFromSessionLogs` folded only `/bind`-reached sessions, so a chat on the default sessionId convention — the common case — was never folded, leaving the store as the only dedupe |
| Ordering | `sendLocal` bypassed the deliver queue, so a `⏹ Turn ended` line could land *between* two chunks of the answer it followed. Both paths now share the chatKey's serial worker |
| `chunk.ts` | `hardSplitText` scanned from index `maxChars` and split *after* it, emitting `maxChars + 1` characters — a 4096-char Telegram message became 4097 and was rejected |
| `format.ts` | HTML link hrefs were substituted unescaped into `href="…"`; `escapeHtml` leaves `"` alone by design, so a model-authored URL containing a quote escaped the attribute |
| Build | `npm run build --workspaces` walks `packages/` alphabetically, so `channel-feishu` compiled against whatever `channel-kit` was left in `lib/`. A clean tree could not build |

### 10.3 Handler consolidation

The policy-abstraction doc's shared `handleInboundText` had never been written, so
all three providers carried their own copy of the same eleven-step inbound
sequence — and had drifted (Telegram dispatched media with images and an empty
caption; the other two dropped it). `ChannelBridge.handleInbound` now owns it,
with §3.4's approval-before-merge invariant and §2.1's flush-before-command/media
rules stated where they are enforced. Providers keep `normalize()` plus their own
loopback guards: 769 → 610 lines across the three.

---

## Appendix: Reference index

- openclaw `bba57301`: `src/channels/message/ingress-queue.ts`, `ingress-drain-lifecycle.ts`,
  `ingress-retry-policy.ts`, `live.ts`, `outbound-echo.ts`, `contracts.ts`, `capabilities.ts`,
  `contracts/trace/delivery-trace.ts`, `contracts/outbound-payload-testkit.ts`,
  `src/channels/inbound-debounce-policy.ts`, `src/auto-reply/inbound-debounce.ts`,
  `progress-draft-compositor.ts`, `typing{,-lifecycle,-start-guard}.ts`,
  `conversation-resolution.ts`, `turn/delivery-result.ts`, `turn/pending-delivery-notice.ts`
- hermes-agent `56526bc0`: `gateway/run.py` (§9600-10200 busy/approval/FIFO, §11575 recovery,
  §20637 restart dedupe), `gateway/turn_lease.py`, `gateway/delivery_ledger.py`,
  `gateway/stream_consumer.py`, `gateway/session.py:1049-1211`, `gateway/platforms/base.py:2484-2627`
  (error taxonomy), `gateway/platforms/webhook.py:404-461`, `gateway/platforms/helpers.py:724-784`,
  `tools/clarify_gateway.py`, `gateway/platforms/ADDING_A_PLATFORM.md`
- dsh-channel at `81a49e2`: `packages/channel-kit/src/bridge/bridge.ts`,
  `packages/channel-kit/src/policy/{merge,deliver-queue,stream,recovery,presentation}.ts`,
  `packages/channel-kit/src/bridge/store.ts`, `packages/channel-telegram/src/bridge.ts`
