# dsh-channel Backlog: Open Questions, Deferred Work, and Rejected Designs

> Status: **live** · Date: 2026-08-17 · Baseline: the tree at `b4bc254` (M0–M14 shipped)
> Upstream: `../dsh-channel-design.md` (architecture, contracts, R1–R10) ·
> `dsh-core-reference.md` (rc.6 core alignment baseline)
>
> This is the single list of what is **not** built, what is **not verified**, and what was
> **deliberately rejected** — the only forward-looking list in the repo. The completed roadmaps
> and the survey documents they came from have been removed from the tree (git history keeps
> them); shipped work is written down in the design document (§12/§13) and the package READMEs.
> Every item below was re-checked against the tree on 2026-08-17.

---

## 0. TL;DR

Nothing here blocks the three shipped providers. The list is three kinds of debt:

- **§1 — one real risk** (`userQuestions` provider scope, still unverified since the first
  interaction design) plus four smaller unknowns.
- **§2 — deferred work, each with a named trigger.** Nothing is scheduled; each item waits for a
  concrete consumer, and the trigger is written down so "is it time yet?" is answerable.
- **§3 — designs considered and rejected.** These are guardrails against re-proposal, not
  oversights. The reasoning matters more than the verdict.

---

## 1. Open questions (unverified)

| # | Question | Why it is still open | What would close it |
|---|---|---|---|
| Q1 | **`userQuestions` provider scope** | `agentCtx.userQuestions.registerProvider(...)` inside `setup(agentCtx)` is assumed to be **per-agent isolated**. If it is a global single slot, the shared prompt broker in `ChannelBridge` needs a fallback. `dsh-user-questions` / `dsh-tool-ask-user` are still not in local `node_modules` — only the master source was ever read | A spike against a real install. This is the one hard risk carried from the original interaction design; it does not block anything shipped, because the current prompt path goes through `approval/request`, not `userQuestions` |
| Q2 | **"Bare events outside a turn are dropped on reload"** | The design's store/log boundary (design §4.5) leans on this, but it was never verified word-for-word in `dsh-session-persistence`. rc.6 evidence is indirect: `TurnEndReasonMap.interrupted` documents that the persistence backend closes crash-orphaned turns on reload | Read the `dsh-session-persistence` source when persistence is actually wired up. The conclusion it supports (ledger belongs in the store, not the log) is independently justified by "delivery status is not a model-visible fact", so a surprise here would not invalidate the design |
| Q3 | **`assistant/chunk` coalescing parameters** | The `block` streaming tier's `minChars`/`idleMs` were chosen by analogy (1500ms-class defaults), never measured against real token volume | Real-world measurement once block streaming (v2) has a consumer. The shipped `delta`/`status-line` tiers are throttle-gated and unaffected |
| Q4 | **Draft transport hooks assume one editable status message per session** | The Telegram model. A platform that streams append-only would need the *hook surface* to grow — which is the intended place for such variance, not the handler | The next streaming-capable platform. This is a shape prediction, not a defect |
| Q5 | **A5 (add-a-platform costs no contract change) has not been re-run against an `edit` + `threads` platform** | All three shipped providers were added without contract changes, but none of them exercises threads or in-place edit as its primary streaming mode | Adding Discord — `streamingMode='off'`, `supportsStatusText=true`, real thread support — is the designated comparison case |

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
| **`route()` / resolver chain tri-state + provenance** | `null` = explicit rejection stops the chain, `undefined` = no opinion, plus a provenance tag on the result. **Cheap now, unretrofittable once more resolvers exist** | The second resolver. This is the one item here with a decay cost |
| **Chunker: single-backtick balancing, mid-stream truncation closure** | `chunk.ts` treats fenced blocks as atomic and re-fences on hard split; inline code spans and mid-stream cuts are not balanced | Block streaming (v2) — only reachable when partial text is rendered mid-turn |
| **`always` / `session` approval memory** | dsh's `approval/request` has no `always`/`session` outcome. "Remember always for this tool this session" requires the channel to record it in its own store and short-circuit in the answerer, never calling back into `approval/request` | A user asking for it. Interface space is reserved; nothing is built |

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
- **Default-auto-approve on unanswered confirmation** — the exact opposite of R8/A6's "never
  default to allowing". Kept here as a negative example: the `next()`-on-timeout-and-no-answerer
  design is correct and must not be softened toward it.
- **A 1+N busy queue** (a single pending slot + an overflow queue) — an artifact of retrofitting a
  FIFO onto a single-slot design. The merge-buffer-as-queue is the clean form.
- **A dead-target registry** — pays off with fan-out/cron delivery; the `forbidden` / chat-level
  `not_found` error kinds capture the per-delivery decision without it.
- **Multi-process claim machinery** (pid+starttime identity, cross-process ledger claim protocols)
  — correct engineering, wrong process model: dsh-channel bridges are single-process per provider.
  Revisit only with a multi-worker deployment story.
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

---

## Appendix: where the finished work is written down

| Question | Document |
|---|---|
| What the architecture *is*, the R1–R10 constraints, and the design rationale | `../dsh-channel-design.md` |
| What the rc.6 core actually exposes | `dsh-core-reference.md` |
| Which capabilities and mechanisms shipped (M7–M14), and how | `../dsh-channel-design.md` §12/§13 + the package READMEs |

Everything older — the completed roadmaps and the original research they came from — lives in git
history, not in the tree.
