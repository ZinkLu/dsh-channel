# dsh-channel Backlog: Open Questions, Deferred Work, and Rejected Designs

> Status: **live** · Date: 2026-10-06 · Baseline: the tree with M0–M17 shipped (the
> session-manager layer landed as `dsh-session-manager` + the kit's manager upstream, design §14)
> Upstream: `../dsh-channel-design.md` (architecture, contracts, R1–R10) ·
> `dsh-core-reference.md` (0.2 core alignment baseline)
>
> This is the single list of what is **not** built, what is **not** verified, and what was
> **deliberately rejected** — the only forward-looking list in the repo. The completed roadmaps
> and the survey documents they came from have been removed from the tree (git history keeps
> them); shipped work is written down in the design document (§12/§13/§14) and the package READMEs.

---

## 0. TL;DR

Nothing here blocks the shipped providers or the session-manager layer. The list is three kinds
of debt:

- **§1 — unknowns**: the smaller pre-existing ones (Q2–Q5; the `userQuestions` scope risk Q1 was
  answered by the 0.2 upgrade), plus **Q6–Q10 = the session-manager composition spikes V1–V5**
  that need a live web-host + channel composition (design §14.8 carries the fallbacks).
- **§2 — deferred work, each with a named trigger.** Nothing is scheduled; each item waits for a
  concrete consumer, and the trigger is written down so "is it time yet?" is answerable. The
  session manager's v2 layer (concierge agent, scheduled dispatch, job-completion pings) lives here.
- **§3 — designs considered and rejected.** These are guardrails against re-proposal, not
  oversights. The reasoning matters more than the verdict.

---

## 1. Open questions (unverified)

| # | Question | Why it is still open | What would close it |
|---|---|---|---|
| Q1 | ~~**`userQuestions` provider scope**~~ ✅ answered by the 0.2 upgrade (2026-10) | 0.2 replaced the single-slot `registerProvider` with the agent-scoped `user-questions/request` waterfall (scope-filtered dispatch via dsh-scope), so "per-agent isolated" is now structural, not assumed. The broker answers through `InteractionBroker.handleUserQuestion` and delegates non-owned agents via `next()` | — |
| Q2 | **"Bare events outside a turn are dropped on reload"** | The design's store/log boundary (design §4.5) leans on this, but it was never verified word-for-word in `dsh-session-persistence`. rc.6 evidence is indirect: `TurnEndReasonMap.interrupted` documents that the persistence backend closes crash-orphaned turns on reload | Read the `dsh-session-persistence` source when persistence is actually wired up. The conclusion it supports (ledger belongs in the store, not the log) is independently justified by "delivery status is not a model-visible fact", so a surprise here would not invalidate the design |
| Q3 | **Stream-chunk coalescing parameters** (the `assistant/chunk` session event is gone in 0.2 — deltas arrive via `agent/assistant-stream`) | The `block` streaming tier's `minChars`/`idleMs` were chosen by analogy (1500ms-class defaults), never measured against real token volume | Real-world measurement once block streaming (v2) has a consumer. The shipped `delta`/`status-line` tiers are throttle-gated and unaffected |
| Q4 | **Draft transport hooks assume one editable status message per session** | The Telegram model. A platform that streams append-only would need the *hook surface* to grow — which is the intended place for such variance, not the handler | The next streaming-capable platform. This is a shape prediction, not a defect |
| Q5 | **A5 (add-a-platform costs no contract change) has not been re-run against an `edit` + `threads` platform** | All three shipped providers were added without contract changes, but none of them exercises threads or in-place edit as its primary streaming mode | Adding Discord — `streamingMode='off'`, `supportsStatusText=true`, real thread support — is the designated comparison case |
| Q6–Q10 | **Session-manager composition spikes V1–V5** (design §14.8): answerer claim order vs the web host, global `notify_user` visibility under a preset, root listeners seeing web-UI sessions, workspace grouping by cwd, and single-writer resume across two processes | The M15–M17 suites pass on in-memory fakes; these five only manifest in a live `dsh-web-app` + channel composition (the dev bot) | Run M18 on the dev bot; each has a named fallback in design §14.8 (a `dsh-channel-host` session-only profile for V1, per-agent tool re-registration for V2, per-agent listeners for V3, "Ungrouped" for V4, the foreign-confirm flow for V5) |

**Standing constraint:** policy objects stay stateless. If a policy ever needs warm-up state, that
state lives on the bridge, not in the policy.

---

## 2. Deferred work (each with a trigger)

### 2.1 Capability facts

None of these is a functional gap today; all seven wait on a concrete consumer.

| Gap | Why it waits | Trigger |
|---|---|---|
| Group `@mention` / `group_policy: open\|mention` routing | `router.ts` drops all non-direct chats by design (prompt-injection surface). `mentionsBot` is now wired, so the prerequisite is done — the policy is not | v2 group support landing as a decision, not a feature request |
| Native slash-command registration (`setMyCommands`, Discord app commands) | Cosmetic discoverability over the current text-parsed `/command`; zero functional gap | Any provider can add it independently, no contract change — so: whenever someone wants it |
| Rich/structured payload beyond choices (cards, carousels) | `OutboundChoice` covers the actual need (approval, clarification); high per-platform cost | A use case that genuinely needs more than buttons |
| Doctor/heartbeat diagnostics adapter | `channel/status` already gives policy plugins connect/disconnect/fatal | An observability consumer that needs structured diagnostics |
| Directory/contact resolver (username → id) | No caller | `/bind` by `@username` instead of raw chat id |
| `afterSendSuccess` / `afterCommit` hooks | Speculative extension point, no consumer | A real cross-cutting need; the deliver queue can grow them without a contract change |
| unsend / edit-own-message, polls, message effects | Platform trivia, no agent-relevant use case in any reference | — |

### 2.2 Mechanisms

| Gap | Shape | Trigger |
|---|---|---|
| **Typing lifecycle beyond the 5s throttle** | `ChannelBridge` has only `lastTypingAt` throttling (`bridge/bridge.ts`). The full trio — skip-while-in-flight, a failure circuit breaker with a `tripped` state, and a 60s TTL force-stop — is a small kit module every provider would otherwise re-derive | Second provider that hits typing failures in production |
| **Pause typing while awaiting approval / questions** | On some platforms the typing indicator disables the input box, so a user cannot reply `/approve` or pick an option. The answerer's waiting branch must stop and resume typing | Same trigger as above; the two belong in one typing module |
| **`noticeOnUnknownRecovery`** | `unknown` (crashed mid-send, may have landed) is not `failed` (definitively rejected). The alternative policy sends a one-time, idempotent, same-route notice instead of a blind resend. With the `RecoveryPolicy` seam in place this is one alternative policy plus one honest state name — near-zero cost | Operator demand. Today's "resumed resend" marker is acceptable but noisier |
| **Two-phase inbound ownership** (admission vs. completion) | Vocabulary only for now: the inbound outcome states should adopt `adopted / deferred / abandoned` lifecycle names so the upgrade path stays open. Full adoption matters most with a durable inbound queue | A durable inbound queue |
| **`parseApprovalReply` tri-state** | Two outcomes today (`answer` \| `not-an-answer`). Splitting `not-an-answer` into *invalid selection* (re-prompt) vs *free prose* (release the prompt, route as a normal turn) adds the prose escape hatch that prevents a re-prompt loop | Prompt retry UX |
| ~~**`route()` / resolver chain tri-state + provenance**~~ ✅ shipped with the session manager (design §14.4) | The second resolver arrived: `resolveUpstream` runs `[focus, convention]` with `null` = rejection, `undefined` = no opinion, and a `provenance` tag on every hit | — |
| **Chunker: single-backtick balancing, mid-stream truncation closure** | `chunk.ts` treats fenced blocks as atomic and re-fences on hard split; inline code spans and mid-stream cuts are not balanced | Block streaming (v2) — only reachable when partial text is rendered mid-turn |
| **`always` / `session` approval memory** | dsh's `approval/request` has no `always`/`session` outcome. "Remember always for this tool this session" requires the channel to record it in its own store and short-circuit in the answerer, never calling back into `approval/request` | A user asking for it. Interface space is reserved; nothing is built |
| **0.2 session-projection cache rejects channel session ids** | e2e-observed on 0.2.0-rc.2: its per-record key must match `/^[a-zA-Z0-9_-]+$/`, so our colon-bearing `channel:<id>:<chatKey>` ids never warm the projection cache ("cache stays stale" warnings; titles/projections for channel sessions stay cold). The id grammar is byte-stable by design (§4.5), so the fix belongs upstream or in an id-mapping layer. The manager's random-id `create()` sessions are cache-friendly; only the conventional default ids are not | The projection cache powering something a channel user actually sees (e.g. session titles in web lists) — then raise it upstream |
| **Concierge agent (natural-language session control)** | A v2 agent that drives `ctx.sessionManager` through tools ("what's running?", "start a blog session and fix the header") instead of slash commands. It builds on the same API — D2's deterministic plane and this are complementary layers, not alternatives | The command table passing ~10 entries, or users persistently asking session state in free text |
| **Scheduled / timed dispatch** | The manager holding its own timers to dispatch at a wall-clock time or after a delay (`dsh-schedule` is session-local, ≥300s, and does not adopt an existing agent) | A user asking for cron-style "run this every morning" |
| **`ctx.jobs.onJobDone` → notification** | Wire the one dsh "completion callback" primitive into the outbox so a background job finishing pings the subscriber | Background jobs becoming a normal part of channel-driven work |

### 2.3 Session-manager layer debts

Surfaced by the M15–M17 implementation review (2026-10): real but non-blocking, each parked with
its trigger.

| Gap | Why it waits | Trigger |
|---|---|---|
| **A manager plugin restart disposes every managed agent** | Under the 0.2 settings model any manager config change (e.g. `defaultSubscribers`) restarts the plugin, and `stop()` disposes all owned handles — killing in-flight turns (tasks fold to `crashed`), including sessions adopted from the web UI. The blast radius moved from "channel restart kills channel sessions" to "manager config tweak kills all sessions". The candidate fix is soft-releasing handles on config-driven restarts (release the references without disposing), which needs a way to tell a config restart from a real unload — 0.2 has no such seam | Anyone actually runs multiple adopted sessions they can't afford to lose on a config tweak, or dsh grows a settings-update-without-restart seam |
| **`describe()`/`list()` rescan full session logs** via the deprecated `snapshotEvents()` | 2–3 full-array copies per `/ls` across `deriveFromLog`/`lastEventTime`/`hasUserMessage`, and the bridge's `titleCache` never invalidates. Fine at current scale | Long-lived sessions make `/ls` visibly slow, or dsh removes `snapshotEvents` (it is `@deprecated`) |
| **Telegram `/ls` keyboard hardening** | All focus buttons render into a single inline-keyboard row (>8–12 sessions may be silently truncated or rejected — verify on the dev bot); callback queries carry no allowlist check (pre-existing for `appr:`/`prompt:`, but `focus:` widens the surface to a state-changing action); `choice.id.slice(0, 64)` slices characters where Telegram's budget is bytes | A deployment with >8 sessions in `/ls`, group-chat support (v1 drops groups), or a user removed from the allowlist mid-session |
| **Pre-`/ls` badge numbers can drift from the next `/ls` render order** | Ad-hoc `assignSessionNumber` counting from 1 vs `/ls` replacing the map in render order. Cosmetic | Any user complaint, or notifications start carrying `/use`-actionable references |
| **`flushBusyQueue` bypasses the manager** | Direct `followup`, no task record — reachable only via the steer-throw fallback, since `queue` mode is unreachable with `supportsSteer: true`. Very narrow surface | A platform without steer, or `/ls` needing to reflect such messages |
| **Small cleanups bundle** | `shorten` (manager-commands) vs `shortenSessionId` (focus-presentation) duplication; focus-presentation's "dependency-free" claim vs its type-only `NotificationKind` import; `manager.ts`'s dead `task.state !== 'queued'` clause in `onTurnEnd`; watermark entries for steer tasks never reclaimed; the "Root listeners" comment vs plugin-scope ctx; provisional-store copy-forward inconsistency for subscriptions/outbox; `create({workspaceId})` without a matching `cwd` storing a decorative grouping | The next time any of these files is touched for a real change |

---

## 3. Explicitly not adopting

Recorded so the next reader knows these were choices. Re-proposing one means arguing against the
stated reason, not rediscovering the option.

### 3.1 Contract and mechanism shapes

- **A wide, enumerable adapter-slot contract** — dozens of optional plugin fields
  (auth/pairing/groups/mentions/directory/doctor/heartbeat/…) enumerated on the channel interface.
  It contradicts R6 and the T7 acceptance ("adding a platform changes no contract"). Names from
  such surfaces may be mined for **vocabulary**, never copied as adapter slots.
- **A structural-typing (duck-typed protocol) contract** — the dsh ecosystem's own convention is
  abstract classes with capability-fact getters (`LlmAdapter`, `FileSystem`). Switching styles
  would diverge from every other dsh definition package for no gain.
- **A generic `react(chatKey, messageId, emoji)` primitive gated by a `supportsReactions` fact** —
  shipped once for the `ack-long` UX and retired (design §12.3). Emoji are platform dialect, not
  shared vocabulary, so the bridge's choice leaked into every provider as a translation table, and
  the fact was redundant with the failure fallback. The contract carries the *intent*
  (`ackInbound`); the provider owns the rendering. Re-add a reaction primitive only for a consumer
  that needs reactions as such (the agent reacting on request), never as a means to acknowledge.
- **Default-auto-approve on unanswered confirmation** — the exact opposite of R8/A6's "never
  default to allowing". Kept here as a negative example: the `next()`-on-timeout-and-no-answerer
  design is correct and must not be softened toward it.
- **A 1+N busy queue** (a single pending slot + an overflow queue) — an artifact of retrofitting a
  FIFO onto a single-slot design. The merge-buffer-as-queue is the clean form.
- **A dead-target registry** — pays off with fan-out/cron delivery; the `forbidden` / chat-level
  `not_found` error kinds capture the per-delivery decision without it. The session manager's
  notification path confirmed the call: a forbidden/not_found give-up `unwatch`es the subscriber
  (design §14.6) — self-healing subscriptions, still no registry.
- **Multi-process claim machinery** (pid+starttime identity, cross-process ledger claim protocols)
  — correct engineering, wrong process model: one `$DSH_HOME` = one resident host process is the
  only supported topology, and 0.2's single-writer session ownership already blocks concurrent log
  writes. The manager therefore only manages **this process's** sessions, and a `foreign` session
  (persisted, not live here) requires an explicit `--take` confirm before adoption. Revisit only
  when `dsh-api-remotes` grows an authenticated host↔host channel.
- **Admission evidence graphs, session envelopes, route projections** — compliance/audit machinery
  and legacy-shape reconciliation; the latter is a cost to avoid, not a mechanism to build.
- **Volume-mount path translation and audio/TTS caching** — no voice or container deployment story
  here.

### 3.2 Internal architecture

- **No package split of the kit.** A three-package `format`/`policy`/`bridge` layout buys dependency
  hygiene obtainable from directories plus review, at the cost of three build configs, version
  coupling, and a re-export shim. Revisit when an external consumer needs `policy/` standalone.
- **No `MergePolicy` / `RoutePolicy` / `DeliveryPolicy` / `InteractionPolicy` / `FormatPolicy`.**
  None has a second implementation with demonstrated demand. They stay pure functions called by the
  bridge; promoting one later is a mechanical, non-breaking refactor. Rule of three: abstract on the
  second real implementation, not before.
- **No `ReconcilePolicy`.** `Channel.reconcile` is already the reconciliation seam; a policy whose
  default implementation is "delegate to `Channel.reconcile`" is a second door-frame on one door.
- **No third policy seam for busy handling.** The busy decision is one pure function; promoting it
  to a seam violates the same rule of three.
- **The session manager does not go into the `dsh-channel` contract.** The contract says "what a
  channel looks like"; the manager says "how sessions are managed". Merging them would break A5
  (add-a-platform without contract change) and D1 (the web UI consumes the manager too) at once.
- **No "mode switch" config in the bridge for the manager.** Presence of `ctx.sessionManager`
  decides the upstream (D4); a config flag would create two paths to maintain and two ways to be
  wrong.
- **No LLM in the v1 control plane.** List/switch/dispatch/stop must be testable, instant, and
  token-free (D2). The concierge agent (§2.2) is an additional layer on the same API, never a
  replacement for the deterministic one.
- **No per-chat "manager conversation log".** Command round-trips enter no session log (the same
  reasoning as `ctx.commands`' non-turn `command/run`); audit consumers listen to
  `manager/task` / `manager/notification`.

---

## Appendix: where the finished work is written down

| Question | Document |
|---|---|
| What the architecture *is*, the R1–R10 constraints, and the design rationale | `../dsh-channel-design.md` |
| What the 0.2 core actually exposes | `dsh-core-reference.md` |
| Which capabilities and mechanisms shipped (M7–M14), and how | `../dsh-channel-design.md` §12/§13 + the package READMEs |

Everything older — the completed roadmaps and the original research they came from — lives in git
history, not in the tree.
