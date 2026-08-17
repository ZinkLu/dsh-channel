# dsh-channel Interaction Capability Design: Streaming / Tools & Thinking / Offer Options / Processing Status

> **ARCHIVED — historical record, not a plan.** Its own header below says "design draft, not
> implementation"; that is stale. Streaming, thinking (as a three-level `thinkingLevel`, per §6 Q2),
> tool display, the unified prompt renderer, and adaptive flood throttling (§6 Q8) all shipped in
> M11–M14. §7's interface inventory is superseded by the real types in `packages/`. The questions
> from §6 that are genuinely still unverified are carried in `../dsh-channel-backlog.md` §1.

> Status: design draft (design only, not implementation) · Date: 2026-08-14
> Upstream: `dsh-channel-design.md` (architecture and contracts; the R1–R10 hard constraints are in its §6/§7)
> Research baseline: dsh rc.6 installed types (`node_modules/@deepseek-ai/*`) + dsh master source
> (`packages/interaction/user-questions`) · hermes-agent main · openclaw main (all 2026-08-14 snapshots)

---

## 0. TL;DR

All four needs already have native "raw material" in dsh; what's missing isn't data but a **presentation layer** at the channel level. The design conclusion in one sentence:

> **Expand the channel's responsibility from "terminal delivery" into a "presenter"** — it consumes the session event stream
> (`assistant/chunk` / `tool/call` / `tool/result` / `reasoning` blocks / `turn·step`),
> degrading, per the platform's **capability facts**, into four presentation tiers — "progress draft / status line / typing / final message";
> expand the currently binary-approval-only `approval-render` into a **unified interaction prompt** (approve/reject,
> option A/B, multi-select, free text, and plan-review all go through one rendering path + one answer-routing path), while also wiring up
> dsh's `user-questions` seam. All new behavior is pure functions + capability facts, touching not a single line of dsh.

The four points → current state → gap are shown in the table below; each point's dsh seam, the transferable hermes/openclaw conclusions, and its landing position are in §2/§3/§4 respectively.

| # | Need | Current state (code + design doc) | Gap |
|---|---|---|---|
| 1 | Streaming | v1 is explicit about "terminal delivery only" (openclaw `off` tier); the `supportsEdit` fact is already declared but only consumed by streaming v2 | No per-token/chunked presentation |
| 2 | Tool progress/results + thinking | Only "leak prevention" (`stripToolCallMarkup` sanitizing `<tool_calls>` text); doesn't read `tool/call`/`tool/result`; `reasoning` blocks are dropped outright | No tool progress lines, no result echo, no thinking presentation |
| 3 | Offer options (approve/reject, A/B choice) | `approval-render` only does the approve/reject binary; the `OutboundChoice` type is already generalized but rendering only serves approval | No N-option/multi-select/free-text/plan-review |
| 4 | Processing status | `turn/start`→typing (5s throttle) + `turn/end` status line; `§5.4` reserves a "progress heartbeat" (off by default) | No per-tool status, no "thinking", no step granularity |

---

## 1. "Does the doc mention it?" — answer this first

`dsh-channel-design.md` has already **planted three hooks**, but hasn't expanded them:

- **Streaming**: §4.1 is explicit that "v1 does terminal delivery only; draft streaming on `supportsEdit` platforms (openclaw `block` mode + timer gating) is slated for v2" — the direction is right, but the `off/partial/block/progress` four tiers and chunk coalescing aren't designed.
- **Tools & thinking**: `format.ts` has `stripToolCallMarkup` (prevents `<tool_calls>` XML leakage), which is "negative" handling; there is **no** "positive" `tool/call`/`tool/result` presentation, nor any presentation policy for thinking.
- **Offer options**: §3.2's `OutboundChoice[]` and §4.4's `renderApproval` have already **generalized options from "approval-only" into an array** (`choices: [{id,label}...]`), but only two (approve/reject) were implemented; §4.4's answerer discipline (only answer for its own agent, on timeout call `next()`) is correct and can be reused directly for N options.
- **Status**: §5.3's `turn/end` status line + §5.4's optional progress heartbeat (`digestLine` folded from the log) already exist in embryonic form.

**Conclusion: the design doc points the direction but gives no mechanism; of the four points, the only things "the doc never mentions" are thinking presentation and wiring N-option offers to the seam.**

---

## 2. dsh's native seam landscape (the "raw material" for the four points)

> All sourced from the installed rc.6 types + master source, each item with its provenance.

### 2.1 Streaming (raw material: `assistant/chunk` / `llm/stream`)

- `SessionEventMap['assistant/chunk'] = { turn, step, chunk: StreamChunk }` (`dsh-session/lib/types/types.d.ts:264`) — token-level replay fidelity, **readable delta-by-delta**.
- `StreamChunk` (`dsh-llm/lib/types/types.d.ts:267`) is a discriminated union: `block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish`. `block-end` carries the assembled full `ContentBlock`.
- `llm/stream` (waterfall, `dsh-llm/lib/types/index.d.ts:43`) exposes `AsyncIterable<StreamChunk>` — grabbing the stream before the log commit is possible, but reading `assistant/chunk` from the channel's `session/event` already suffices (post-commit, replayable, conforming to R7).

### 2.2 Tool progress/results + thinking (raw material: `tool/call` / `tool/result` / `reasoning` blocks)

- `tool/call = { turn, step, callId, name, arguments }` (`types.d.ts:286`) — `arguments` is the model's raw JSON string.
- `tool/result = { turn, step, message: ToolResultMessage, error?, meta? }` (`types.d.ts:304`) — `error` carries `{name, code}`; `meta` is the tool's private presentation payload (JSON-serializable).
- thinking = the `reasoning` block inside `ContentBlock` (`type:'reasoning', text`, `dsh-llm/types.d.ts:44`), plus the streaming `reasoning-delta`. **Note: `assistant/message`'s `content` carries `reasoning` blocks, and the current bridge's `assistantMessageText()` only does `filter(type==='text')`, which amounts to throwing the thinking away.**

### 2.3 Offer options (raw material: `approval/request` + **`user-questions`**)

Two seams: one is binary, and the other is precisely "option A/B":

- **`approval/request`** (waterfall, `dsh-user-approval`): `req={agent, toolName, callId?, reason?, signal?}`, outcome ∈ `allowed-once|rejected|cancelled|unavailable`. The existing bridge already correctly implements "only answer for its own agent + on timeout `next()`".
- **`ctx.userQuestions`** (`dsh-user-questions`, `packages/interaction/user-questions/src/index.ts`, master) — **this is the official seam for "option A/B / multi-select / free text / plan-review"**, documented in `docs/subsystems/user-questions.zh.md`:
  - `AskUserQuestionItem = { id, question, detail?, header?, options?: AskUserQuestionOption[], multiSelect?, intent? }`
  - `AskUserQuestionOption = { label, description? }`
  - `intent = { kind:'plan-review', approve: string }` — plan approval: `approve` names which label is "approved", and all others count as rejection; **intent only changes presentation, not the protocol** (the answer is still a list of labels).
  - `AskUserQuestionAnswerItem = { id, selected: string[], custom? }` — for single-select, `custom` overrides `selected` (free text); for multi-select, `custom` supplements it.
  - `UserQuestionProvider.ask(request): Promise<AskUserQuestionAnswer>`, `registerProvider(provider)` **one context has only one active provider** (duplicate registration throws `DUPLICATE_PROVIDER`).
  - `ask()`'s `agent` validation: `CALLER_NOT_LIVE` (not the currently live instance) / `DELEGATED_CALLER` (that agent is owned by another agent); no provider → `NO_PROVIDER`.
  - The model-side tool is `@deepseek-ai/dsh-tool-ask-user` (agent plane, mounted via preset).

**Key design tension**: `approval/request` is a waterfall (it can `next()` to delegate to the web UI); `userQuestions` is a **single-provider slot** (it cannot delegate). §4.3 elaborates how to resolve this.

### 2.4 Processing status (raw material: `turn/step/tool` events + `agent/status`)

- `turn/start`, `step/start`, `step/end`, `turn/end` (`types.d.ts`) — step = one model request + the tools it called; turn = zero or more steps. This is exactly the granularity for "which step/turn we're on".
- `agent.status` (`idle|running`) and the `agent/status` event (`runtime-types.d.ts:45/169`) — the driving source for typing and "is running".
- `tool/call`/`tool/result` carry their own `turn/step` numbering — progress lines can be folded from the log, naturally replayable (R7).

---

## 3. hermes and openclaw implementations (transferable conclusions)

### 3.1 Streaming

- **openclaw's four modes** (`src/channels/streaming.ts`, `docs/concepts/streaming.md`, `docs/concepts/progress-drafts.md`): `off | partial | block | progress`; capability fact `capabilities.blockStreaming`.
  - **Two streaming layers are separate, and token deltas are never delivered**: `streaming.mode` governs the **preview draft** (editing one temporary message), `block.enabled` governs **chunked terminal delivery** (blocks send ordinary messages chunk by chunk) — the two are independent. dsh's `assistant/chunk` is token-level raw material, but the channel only consumes the "assembled block / terminal" layer.
  - **progress gating** (most worth copying): `createChannelProgressDraftGate`'s `DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS = 1500` — **the draft message is only created when the timer fires, so quick answers never send a draft**, finalize cancels the timer; `noteWork()` only counts + schedules the timer, without synchronously creating the draft; `start()` is idempotent to prevent double-creation.
  - **Draft compression**: `maxLines` defaults to 8, `maxLineChars` to 120, `textChunkLimit` to 4000; each line carries a stable `id`/association key for in-place updates.
  - `partial`/`block` = editing one message in place (edit capability); `block` coalesces by `BlockStreamingCoalesceConfig {minChars, maxChars, idleMs}` (defaults `{minChars:1500, idleMs:1000}`; preview chunk defaults `200/800/paragraph`).
  - Per-channel default table: Telegram defaults to `progress`, Discord to `off`, Mattermost/Teams to `partial`.
- **hermes `send_draft`** (`gateway/platforms/base.py:3268`): `send_draft(chat_id, draft_id, content)` for animated drafts; `streaming_overflow_limit()` (don't split when a single message can exceed 4096); `should_finalize_as_new_message()` — **on some platforms the final reply should be "send a new message + delete the draft" rather than in-place edit** (Telegram's rich-text editing path is weak). **Three-tier transport degradation**: native draft (Telegram `sendMessageDraft`) → progressive editing → send a fresh terminal message; platforms without edit capability (QQ/WeChat) skip streaming outright. Defaults `edit_interval=0.8s / buffer_threshold=24 / cursor=" ▉"`, **flood gating**: after 3 consecutive flood strikes, disable editing with exponential backoff (§6 Q8).

### 3.2 Tool progress/results + thinking

- **hermes structured stream events** (`gateway/stream_events.py`) are the **textbook answer**:
  - Events only describe "what happened", not "how to send": `MessageChunk{text}` / `MessageStop{final}` / `Commentary{text}` / `ToolCallChunk{tool_name,preview,args,index}` / `ToolCallFinished{tool_name,duration,ok,index}` / `LongToolHint` / `GatewayNotice{kind,text}`.
  - **The adapter decides presentation per-event**: `format_tool_event` → `"🔎 tool_name: \"preview\""` (mode `all/new/verbose`, preview limit defaults to 40); when the platform can't render it, **`return None` and eat the chrome** (iMessage has no rich text).
  - **Presentation is presentation-only, never in history**: whatever the adapter eats never changes the bytes the agent stores — exactly the R7 property we want: "log = what the model sees, presentation = what the platform hands off".
  - **thinking is filtered upstream**: the `MessageChunk` comment explicitly says "Reasoning/think-block content is filtered upstream and never arrives as a MessageChunk" — hermes by default **does not hand thinking down to the channel**.
- **openclaw tool display** (`src/agents/tool-display.ts`, `tool-display-exec.ts`, `auto-reply/tool-meta.ts`): `resolveToolDisplay({name,args,detailMode})` → `{emoji,title,label,detail}`; `formatToolSummary` → `"{emoji} {label}: {detail}"`, the shell family (`bash/exec/shell` or tools with a `command` argument) → `"{emoji} {command}"` (the full command line); built-in redaction `redactToolDetail`, `MAX_DETAIL_ENTRIES=8`. **Two-axis detail strategy**: `detailMode: explain|raw` (semantic summary vs raw arguments) × `commandText: status|raw` (command text) — `explain` has rich semantic summarizers (git/grep/find/ls/npm…), `formatToolAggregate` `brace-collapse`s paths by directory into `dir/{a,b,c}`.
- **openclaw thinking presentation** (`src/auto-reply/thinking.ts`, `src/agents/thinking-runtime.ts`, `src/shared/text/reasoning-tags.ts`): `ReasoningLevel = off | on | stream` (`normalizeReasoningLevel` maps `stream/streaming/draft/live→stream`, `show/visible/on→on`, `hide/hidden/off→off`); `isThinkingLikeBlock` recognizes `thinking`/`redacted_thinking` blocks; `stripReasoningTagsFromText` strips `<reasoning>/<thinking>` tags and "Reasoning:"/"Thinking" leading lines from **visible text** (`strict|preserve`, `all|leading`, preserving code literals) — **thinking is a "level", not a "boolean": off=don't hand down, on=only hand down the final thinking, stream=hand down delta by delta**. It adds the `on` tier that hermes's "filter everything upstream" lacks, and the `thinking` typing tier is bound directly to reasoning deltas.

### 3.3 Offer options

- **hermes's three interaction primitives share one callback route** (`tools/clarify_gateway.py` + `base.py`):
  - `clarify`: `_ClarifyEntry{clarify_id, question, choices, multi_select, awaiting_text}`; `send_clarify(chat_id, question, choices, clarify_id)` renders two tiers — buttons (numbered 1..n + "Other") + a text fallback (a numbered list, the user replies "2" or the option text); `resolve_gateway_clarify(id, response)` collects the answer; `mark_awaiting_text(id)` puts "Other" into free-text capture. **clarify constraints** (`tools/clarify_tool.py:236`): `question` required + at most 4 `choices` + `multi_select`; **the first choice is automatically marked "(Recommended)"**; a 5th "Other" is auto-appended; outputs JSON `{question, choices_offered, user_response}`.
  - `send_slash_confirm`: three fixed options Approve Once / Always / Cancel, `_resolve_slash_confirm(id, "once"|"always"|"cancel")`.
  - `approval`: `tools.approval`'s choice is the **four-value `once|session|always|deny`** (timeout 300s), `approval_data={command, description, pattern_keys}`.
  - A unified `prompt_response{prompt_id, option_id, label}` inbound route to the three resolvers, **intercepted before normal dispatch**. **Callback ids are channel-local** (Telegram `ea:{choice}:{id}` / `sc:` / `cl:{id}:{idx}`+`cl:{id}:other`; Discord `clarify:{id}:{idx}`; Slack `action_id`+value; Matrix emoji reactions ✅🌀♾️❎) — the `appr:` prefix in the docs is outdated, but **the resolver calls are the same across all channels**.
- **openclaw**: `ChannelApprovalCapability` (approve action, `approvalKind: exec|plugin`) + `capabilities.polls` + `PollInput{question, options[], maxSelections, durationSeconds}` (`src/polls.ts`).
- **openclaw's `ask_user` tool** (`src/agents/tools/ask-user-tool.ts`) — **one-to-one with dsh's `user-questions`**: a blocking tool, `{questions: [{id(snake_case), header(≤12), question, options[{label(≤64),description}] (2–4), multiSelect?}], timeoutSeconds(default 900, min 30, max 3600)}`, always `isOther:true`; buttons are only rendered for a **single non-multi-select, non-secret question**, while multi-select/multi-question degrades to text; answers route back to the blocked tool call via `question.resolve`. This confirms §2.3's conclusion: dsh's `user-questions` is the correct seam for "option A/B" — no need to reinvent it.
- **openclaw's "portable payload → capability adaptation → text degradation" chain** (`src/interactive/payload.ts` + `src/channels/plugins/outbound/presentation-limits.ts`) — this is the **core abstraction for offer/options, most worth copying**:
  - **The payload is channel-agnostic**: `MessagePresentationAction = command | callback | model-picker | approval{approvalId,approvalKind,decision:allow-once|allow-always|deny} | question{questionId,optionValue} | url | web-app`. The agent-side tool **only produces this portable shape**, with no platform callback ids.
  - **Adaptation is a pure function of the capability facts**: `ChannelPresentationCapabilities {supported, buttons?, selects?, limits.actions.{maxActions,maxActionsPerRow,maxRows,maxLabelLength,maxValueBytes,supportsStyles,supportsDisabled}, limits.selects.{maxOptions,…}, limits.text.{maxLength,encoding,markdownDialect,supportsEdit}}` → `adaptMessagePresentationForChannel` degrades unsupported blocks into `context`/`text`, and `applyPresentationActionLimits` keeps only the subset of buttons that fit.
  - **Text degradation never leaks transport data**: `renderMessagePresentationFallbackText` renders buttons as a `- <label>` list, and `approval`/`question` actions **only emit the label, never callback_data/optionValue**.
- **openclaw approval** (`src/infra/approval-presentation.ts`, `exec-approvals-policy.ts`, `exec-approval-command-display.ts`): `ApprovalPresentation` kinds `exec|plugin|system-agent`, `allowedDecisions` always contains `deny`; `DEFAULT_EXEC_APPROVAL_DECISIONS = ["allow-once","allow-always","deny"]`, collapsing to `["allow-once","deny"]` when `ask==="always"`; command text gets **de-obfuscation sanitization** (escaping invisible characters, secret redaction, `EXEC_APPROVAL_MAX_INPUT=256KB / MAX_OUTPUT=16KB`).
- **Shared lesson 1 (buttons are shortcuts, text is always the degradation path)**: numbered / option-text / free-text must all be answerable; on timeout, without clearing, fall back to `next()`/`NO_PROVIDER`.
- **Shared lesson 2 (approve is often N-valued, not binary)**: openclaw `decision: allow-once|allow-always|deny`, hermes slash-confirm `once|always|cancel`, hermes approval `once|session|always|deny` (**four values**) — "once / this session / always / deny". dsh's `approval/request` only has `allowed-once|rejected` (no `always`/`session`), so "remember always for this session" requires the channel to record it in its own store (see §6 Q6); not done in v1.
- **Shared lesson 3 (fail-closed timeouts are centralized)**: hermes's blocking primitives carry configured timeouts (**approval 300s, clarify 3600s**), poll in 1s slices to keep a heartbeat alive, and on timeout/interrupt/`clear_session` uniformly `deny`/empty-string; **a late button click is rendered as "⌛ expired" rather than pretending success**. The resolve callback signature is unified as `resolve_*(id, choice)`; button rendering is channel-local and callback ids are channel-local, but **the resolver calls are the same across all channels** — exactly the shape that §4.3's "unified PendingPrompt registry" should copy.

### 3.4 Processing status

- **openclaw progress-drafts**: one editable "Working..." message + rolling progress lines (`🔎 Web Search: ...`, `🛠️ Bash: run tests`), with a status headline, label, and tool emoji; `AgentPlanStep{step,status: pending|in_progress|completed}`. Plain-text answers don't create a draft (it only appears when there are real work lines).
- **openclaw typing tiers** (`src/auto-reply/reply/typing-mode.ts` / `typing.ts`): `TypingMode = never | instant | thinking | message`, `DEFAULT_TYPING_INTERVAL_SECONDS = 6`, `DEFAULT_TYPING_TTL_MS = 2min` — the `thinking` tier types only **when a reasoning delta appears**, the `message` tier types on "a tool call after renderable text". It adds one dimension beyond the boolean `supportsTyping`: **the typing trigger signal can distinguish "thinking" from "running a tool"**.
- **hermes status is a "cheap layered ladder"** (each layer optional, riding on the one below; a bare platform still has at least typing):
  1. `send_typing` (one-shot, no-op default) →
  2. `_keep_typing` (**2s refresh loop**, Telegram/Discord typing expires in ~5s; 1.5s cap per call) →
  3. `supports_status_text` + `set_status_text` (**Slack feeds "is running scripts/run_tests.sh…" into the text status line, `build_status_phrase(tool_name, args, max_len=49)`, zero extra API cost**, riding on the typing refresh) →
  4. lifecycle reactions (`on_processing_start/complete` swap ✅/❌).
  - **Pause typing while waiting for approval** (`pause_typing_for_chat`): Slack's assistant status disables the input box, and the user must still be able to type `/approve`.
- **hermes tool progress mode**: `off | all | new | verbose | log` (finer than openclaw's explain/raw), `TurnRunner.progress_callback` is the single point (emoji+verb+preview, preview limit 40).

---

## 4. Design: landing on two layers, the common layer + provider (design only, not implementation)

> Principles unchanged: capability differences go through "capability facts + degradation" (R6); the presentation layer is pure functions (kit); log = what the model sees, presentation = what the platform hands off (R7); the waterfall only answers for itself and doesn't seize authority (R8).

### 4.1 `dsh-channel`: new capability facts (the `Channel` abstract class)

Appended after the existing six getters, all with conservative defaults (following the `FileSystem.sandboxMode` pattern):

```ts
// ---- Presentation capability facts: conservative base-class defaults ----
/** Streaming tier. 'off' = terminal only; 'block' = chunked in-place draft editing; 'progress' = one editable status draft + terminal.
 *  Requires supportsEdit to be anything other than off; platforms without edit capability are always off. */
get streamingMode(): 'off' | 'block' | 'progress' { return 'off' }
/** Whether to render the "doing X…" status line as text (hermes supports_status_text, the Slack class).
 *  textless platforms (Telegram/Discord) stay false. */
get supportsStatusText(): boolean { return false }
/** Whether to hand reasoning/thinking content down to the channel. Default false (don't leak the chain of thought).
 *  Could be upgraded to thinkingLevel: 'off'|'on'|'stream' (openclaw ReasoningLevel, see §6 Q2). */
get supportsThinking(): boolean { return false }
/** Presentation limits (a reduced version of openclaw ChannelPresentationCapabilities.limits):
 *  maxOptions = buttons per message, maxLabelLength = max button text, maxValueBytes = max callback data.
 *  All undefined = no known limit. The renderer degrades options that don't fit into numbered text. */
get presentationLimits(): { maxOptions?: number; maxLabelLength?: number; maxValueBytes?: number } { return {} }
/** Whether multi-select options are supported. When false, multi-select degrades to "item-by-item single-select + text supplement". */
get supportsMultiSelect(): boolean { return false }
```

- `OutboundMessage` gains an optional field carrying the "presentation intent", shared by policy plugins and the renderer:

```ts
export interface OutboundMessage {
  // …existing fields unchanged…
  /** Presentation intent: final message / new draft / edit existing draft / status line. Policy plugins use this to decide whether to intercept/rewrite. */
  readonly presentation?: 'final' | 'draft-new' | 'draft-edit' | 'status-line'
  /** The draft's platform message id, pointed to on draft-edit. */
  readonly editTarget?: string
}
```

- New event (optional, observational, for policy plugins to audit streaming/tool traffic; carries no routing decision):

```ts
// @mode emit — the provider has pushed a presentation frame to the platform (audit/stats only; not for decisions)
'channel/present'(presentation: PresentationFrame): void
```

### 4.2 `dsh-channel-kit`: two new modules + one rename

**A. `tool-display.ts` (new, pure functions)** — turn `tool/call`/`tool/result` into one line of plain language:

```ts
export function resolveToolDisplay(name: string, argsJson?: string): { emoji: string; label: string; detail?: string }
export function formatToolLine(display, opts: { detailMode: 'compact' | 'verbose'; maxDetailChars: number }): string
export function formatToolResultLine(tool: string, opts: { ok: boolean; durationMs?: number; summary?: string }): string
```

- Align with openclaw: a small built-in config table (emoji + label for bash/fs/web/subagent…), the shell family (`bash/exec/shell` or tools whose args contain `command`) → the full command line; `maxDetailChars` defaults to 40 (hermes's preview limit); **two-axis detail**: `detailMode: 'explain'|'raw'` × `commandText: 'status'|'raw'` (openclaw's conclusion); paths are brace-collapsed by directory; **always redact** (length truncation + `~` abbreviation of paths).
- Add a `stripReasoningTags(text, opts)` to `format.ts` (the same kind as openclaw's `stripReasoningTagsFromText`): strip `<reasoning>/<thinking>` tag blocks and "Reasoning:"/"Thinking" leading lines from **visible text**, with `strict|preserve` protecting code literals — together with the existing `stripToolCallMarkup` it forms the last gate for "never leak the model's internal bytes to the user".

**B. `stream.ts` (new, pure-function reducer)** — fold the session event sequence into "presentation frames", with timers on the outside (following the `merge.ts` approach):

```ts
export type StreamFrame =
  | { kind: 'final'; text: string }                    // final (assistant/message)
  | { kind: 'draft'; text: string; finalize: boolean } // create/edit draft; when finalize=true, turn into final
  | { kind: 'status-line'; text: string }              // status line (tool/step/thinking)
  | { kind: 'noop' }
export function streamReduce(state: StreamState, input: StreamInput, caps: StreamCaps): { state; frames: StreamFrame[] }
// StreamInput projects session events (on the consumer side) into: turn/start, step/start, tool/call, tool/result,
// reasoning-delta, text-delta, assistant/message, turn/end
// StreamCaps = { streamingMode, supportsEdit, supportsStatusText, supportsThinking, now }
```

- **Gating** (openclaw's conclusion): `progress` mode produces a `draft` only on the first `tool/call` or on above-threshold text volume, and with an `armTimer` (1500ms initial delay) — quick answers produce zero noise; `block` mode coalesces token deltas by `minChars + idleMs` (openclaw's `blockStreamingCoalesceDefaults`); `off` mode only emits `final`.

**C. `approval-render.ts` → `prompt-render.ts` (rename + generalize, keep old exports for backward compatibility)**:

```ts
export interface PromptOptions {
  supportsChoices: boolean
  supportsMultiSelect: boolean
  presentationLimits?: { maxOptions?: number; maxLabelLength?: number; maxValueBytes?: number }
}
export function renderPrompt(
  p: { num: number; question: string; detail?: string; options: readonly string[]; multiSelect?: boolean; allowFreeText?: boolean; recommendedIndex?: number },
  caps: PromptOptions,
): { kind: 'choices'; text: string; choices: OutboundChoice[] } | { kind: 'text'; text: string }
export function parsePromptReply(
  input: { text?: string; choiceId?: string; now?: number },
  pending: readonly PendingPrompt[],
): { kind: 'answer'; num; outcome: PromptAnswer } | { kind: 'not-an-answer' }
// PromptAnswer = { selected: string[]; custom?: string }   — isomorphic to AskUserQuestionAnswerItem
```

- `renderApproval` / `parseApprovalReply` become the special case of `renderPrompt` with `options = ['Approve','Reject']`, **old API preserved** (existing tests/consumers don't break).
- **Rendering conventions** (hermes clarify lessons): when `options` exceeds `presentationLimits.maxOptions`, degrade to text and hint at numbering; the first choice named by `recommendedIndex` is marked "(Recommended)"; with `allowFreeText`, both buttons/text append an "Other/free text" entry; labels over `maxLabelLength` are truncated with `…`; `maxValueBytes` (e.g. Telegram 64) constrains `choice.id`.

### 4.3 The unified interaction-prompt responder (the core of offer options)

**Goal**: approve/reject, option A/B, multi-select, free text, and plan-review **all go through one rendering path + one answer-routing path**, strictly obeying R8 (not stealing the web UI's job).

```
                       ┌──────────────────────────────────────────────┐
  approval/request ──▶ │ unified PendingPrompt registry (num → entry) │
  (waterfall, next())  │ entry = { num, source, agentId, chatKey,     │
                       │ options[], multiSelect, expiresAt }          │
  userQuestions.ask ──▶ │ renderPrompt → buttons/numbered text → send │
  (single provider)    │ reply → parsePromptReply → resolve → return  │
                       └──────────────────────────────────────────────┘
```

- **Core invariant (isomorphic to openclaw conclusion #6)**: the payload is **channel-agnostic** (`question + options[] + multiSelect + intent`, independent of platform callback ids); adaptation is **a pure function of the capability facts** (`renderPrompt` reads `supportsChoices/supportsMultiSelect/presentationLimits`, one function emits the three forms — buttons / numbered text / multi-select degradation — without per-channel branching); **text degradation never leaks transport data** (the numbered fallback only emits "reply 1/2/…" or the option text, never callback_data/optionValue).
- **approval side (already implemented, kept)**: `onApprovalRequest`'s "`req.agent.id` not routed to this channel → `next()`" and "timeout → `next()`" are unchanged, only the rendering call switches from `renderApproval` to `renderPrompt(..., options:['Approve','Reject'])`.
- **user-questions side (new)**: the channel implements `UserQuestionProvider`, and inside `ask(request)`:
  1. Each `AskUserQuestionItem` → `renderPrompt({question, detail, options: options.map(o=>o.label), multiSelect, allowFreeText:true, num})` (when `intent: 'plan-review'`, mark the `approve` label as "✅ Approve").
  2. The user's answer (button/text) → `parsePromptReply` → assemble `AskUserQuestionAnswerItem[]` (`selected`/`custom`) and return.
  3. `request.signal` abort → clear pending, throw `UserQuestionError('ASK_ABORTED')` (or return empty).

- **The single-provider-slot solution (this is the design's only hard risk, see §6 Q1)**: `userQuestions` has only one provider per context, and `approval` is a waterfall that can `next()` while it cannot. **Recommended**: register the channel's own provider inside `setup(agentCtx)` (agent scope) — so the channel agent's `ctx.userQuestions` resolves to the channel provider, while web-session agents still go through the root-level web provider, neither colliding with the other (the same scope technique as the channel's current injection of the `promptHint` systemPrompt segment inside `setup`). **If verification finds that `userQuestions` cannot be isolated by agent scope**, the fallback is: the channel registers a "routing provider" whose `ask(request)` checks whether `request.agent` is a session routed to this channel — if so, render and answer; otherwise `throw NO_PROVIDER` (equivalent to "declining this job", with the separation of web vs channel agreed at an upper layer).

### 4.4 `dsh-channel-telegram`: orchestration (stream consumer)

Expand `onSessionEvent` from "three ifs" into "a projection feeding `streamReduce` + a frame executor":

```
ctx.on('session/event') → project(event) → streamReduce(state, input, caps)
  frames:
    draft          → supportsEdit ? (first sendMessage creates the draft and records its id / editMessageText edits) : degrade to final
    status-line    → supportsStatusText ? send status line : (append a line to the progress draft / ignore)
    final          → stop the draft → terminal send (existing sendOutbound full path + ledger)
    noop           → ignore
turn/start → sendTyping (existing 5s throttle)
turn/end(non-completed) → status line (existing) + draft settle/delete
```

- **thinking**: `reasoning` blocks/`reasoning-delta` produce a status line only when `supportsThinking` (folded into "🤔 …"), otherwise discarded (keeping the existing `assistantMessageText` text-only sanitization as the fallback).
- **tools**: `tool/call` → `resolveToolDisplay` + `formatToolLine` produce the `status-line`; `tool/result` → `formatToolResultLine` (`✅/⛔ · duration`) settles that line.
- **Telegram capability facts**: `streamingMode = 'progress'` (Telegram defaults to progress, aligning with openclaw), `supportsEdit = true` (already declared), `supportsStatusText = false`, `supportsThinking = false` (off by default), `presentationLimits = { maxValueBytes: 64 }` (inline keyboard `callback_data` ≤ 64 bytes), `supportsMultiSelect = false` (Telegram has no native multi-select, degraded to item-by-item + text).

### 4.5 store: draft ledger (minimal extension)

A draft message has a platform id that must be recovered across restarts. Add a parallel table to `ChannelStore` (aligning with delivery-ledger semantics):

```ts
setDraft(chatKey: string, draftKey: string, platformMessageId: string): void
draftMessageId(chatKey: string, draftKey: string): string | undefined
clearDraft(chatKey: string, draftKey: string): void
```

- Semantics copy the delivery ledger: a draft is a "possibly sent but not yet settled" presentation state; after restart `sweepRecoverable` handles it the same way — an orphan draft is either `finalize`d or deleted (with a "recovered" marker). A ledger fault never blocks real sending.

---

## 5. Capability matrix (four points × source × capability facts × kit × degradation)

| Need | dsh raw material | Capability facts | kit functions | Degradation path |
|---|---|---|---|---|
| Streaming | `assistant/chunk` / `llm/stream` | `streamingMode` + `supportsEdit` | `streamReduce` | `off` → `final` only; `block/progress` without edit → auto `off` |
| Tool progress/results | `tool/call` / `tool/result` | `supportsStatusText` | `tool-display` | no status-line capability → eat the chrome (hermes lesson) |
| thinking | `reasoning` blocks / `reasoning-delta` | `supportsThinking` | `stripReasoningTags` (sanitize) + `streamReduce` (status-line) | discard by default + strip tags from visible text (no chain-of-thought leak) |
| Offer options | `approval/request` + `userQuestions` | `supportsChoices` + `supportsMultiSelect` + `presentationLimits` | `renderPrompt` / `parsePromptReply` | no buttons → numbered text; multi-select → item-by-item single-select + text; overlong labels → truncate |
| Processing status | `turn·step` + `agent/status` | `supportsTyping` / `supportsStatusText` / `supportsEdit` | `streamReduce` (status-line/draft) | plain-text platforms → one-shot status line, no draft |

---

## 6. Open questions / to be verified (honestly flagged)

1. **`userQuestions` provider scope** (§4.3's only hard risk): `dsh-user-questions` and `dsh-tool-ask-user` are **not in the local node_modules** (only the master source was checked). A spike must confirm whether `agentCtx.userQuestions.registerProvider(...)` inside `setup(agentCtx)` is **isolated per-agent scope** (the recommended path holds) or a **global single slot** (fallback needed). This determines how offer options are wired.
2. **thinking defaults to off, but could be a "level" rather than a "boolean"**: hermes filters thinking upstream; openclaw `ReasoningLevel = off|on|stream` (default `off`). The design draft makes `supportsThinking` a boolean (conservative, R6-minimal), but openclaw's `off/on/stream` three tiers fit the need better (`on` = only the final thinking, `stream` = delta-by-delta). Should it be upgraded to a `thinkingLevel: 'off'|'on'|'stream'` capability fact? Default `off`, configurable.
3. **`assistant/chunk` noise**: token-level event volume is high; the progress draft must rely on timer gating (openclaw 1500ms) + coalescing, or it spams. The `block` `minChars/idleMs` coalescing parameters need real-world measurement.
4. **Final reply "send new + delete draft" vs "edit in place"** (hermes `should_finalize_as_new_message`): Telegram's `editMessageText` is weak with rich text, so the final reply should be "stop the draft + normal `send` terminal" (the existing `sendOutbound` already supports this), with draft deletion best-effort.
5. **A5 verification**: the next platform (Discord, with `edit` + `threads` + a markdown tier) serves as the capability comparison — Discord defaults to `streamingMode='off'`, `supportsStatusText=true` (it can edit message text to present status), used to verify that "capability facts + degradation" hasn't forked; from then on, every added platform is a re-run of A5.
6. **"always/session" multi-value approval** (openclaw `allow-always`, hermes approval `once|session|always|deny`): dsh's `approval/request` has no `always`/`session` outcome; "remember always for a tool this session" requires the channel to record it in its own store and short-circuit in the answerer (not calling back into `approval/request`). Not done in v1; just reserve the interface.
7. **Pause typing while waiting for approval/questions** (hermes `pause_typing_for_chat`): on some platforms the typing indicator disables the input box, so the user must still be able to reply `/approve` or an option. When wiring `user-questions`/approval, the answerer's waiting branch must `stop_typing`/`resume_typing`.
8. **Flood gating for streaming edits** (hermes): after 3 consecutive flood strikes, disable editing with exponential backoff and per-run degrade to terminal delivery; Telegram typing has a 30s cooldown on transient failure. These are operational guardrails; v1 needs at least "auto-degrade to terminal on edit failure", with full strike counting added later.

---

## 7. Complete interface inventory (interface spec)

> Consolidate the interfaces scattered across §4 into a self-consistent draft where **every type name is defined**. Only signatures and semantics; no implementation bodies.
> Ownership is split across two layers (`dsh-channel`/`dsh-channel-kit` common layer + `dsh-channel-telegram` provider); `[new]` marks new-to-this-design, `[changed]` marks an extension of an existing type, `[existing]` marks direct reuse unchanged.
> Key ruling: **the portable payload (`ChannelPrompt`) does not go into the contract package's `OutboundMessage`** — it only appears on the kit's
> `renderPrompt` input side; the adapted result (`text` + `choices`) is what becomes the `OutboundMessage` going through `channel/deliver`,
> so policy plugins still only need to watch `channel/deliver`/`channel/message` to fully audit "question" and "answer", with no new vocabulary.

### 7.1 `dsh-channel` (contract package)

```ts
// ---- [changed] Channel abstract class: new getters (§4.1) ----
export interface PresentationLimits {
  /** Max buttons per message; undefined = no known limit. Over limit degrades to numbered text. */
  readonly maxOptions?: number
  /** Max button text (chars); over limit truncates with `…`. */
  readonly maxLabelLength?: number
  /** Max callback data (callback_data/value) size (bytes); e.g. Telegram=64. Over limit must degrade to text. */
  readonly maxValueBytes?: number
}

export abstract class Channel {
  // …existing id / maxMessageChars / formatTier / supportsChoices / supportsEdit /
  //   supportsTyping / chatTypes / send / sendTyping unchanged…
  get streamingMode(): 'off' | 'block' | 'progress' { return 'off' }
  get supportsStatusText(): boolean { return false }
  get supportsThinking(): boolean { return false }
  get presentationLimits(): PresentationLimits { return {} }
  get supportsMultiSelect(): boolean { return false }
}

// ---- [changed] OutboundMessage extension: presentation intent (§4.1) ----
export type PresentationIntent = 'final' | 'draft-new' | 'draft-edit' | 'status-line'
export interface OutboundMessage {
  // …existing channel/chatKey/markdown/choices/deliveryKey/origin unchanged…
  readonly presentation?: PresentationIntent
  /** The draft's platform message id, pointed to on draft-edit. */
  readonly editTarget?: string
}

// ---- [new] Presentation frame: the payload of the channel/present event, also the unified vocabulary for policy plugins auditing streaming/tool traffic ----
// The difference between a frame and OutboundMessage: OutboundMessage is a "delivery request" (through the deliver waterfall),
// PresentationFrame is a "presentation fact that already happened" (emitted, observational, carrying no routing/interception decision).
export type PresentationFrame =
  | { readonly kind: 'final'; readonly channel: string; readonly chatKey: string; readonly deliveryKey: string; readonly text: string }
  | { readonly kind: 'draft-new'; readonly channel: string; readonly chatKey: string; readonly draftKey: string; readonly text: string }
  | { readonly kind: 'draft-edit'; readonly channel: string; readonly chatKey: string; readonly draftKey: string; readonly editTarget: string; readonly text: string }
  | { readonly kind: 'draft-finalize'; readonly channel: string; readonly chatKey: string; readonly draftKey: string }
  | { readonly kind: 'draft-discard'; readonly channel: string; readonly chatKey: string; readonly draftKey: string }
  | { readonly kind: 'status-line'; readonly channel: string; readonly chatKey: string; readonly text: string }

declare module '@deepseek-ai/cordis' {
  interface Events {
    // @mode emit — the provider has pushed a presentation frame to the platform (audit/stats only; not for decisions)
    'channel/present'(frame: PresentationFrame): void
  }
}
```

### 7.2 `dsh-channel-kit` (pure-function layer, all `[new]`/`[changed]`)

```ts
// ---- A. tool-display.ts ----
export interface ToolDisplay { readonly emoji: string; readonly label: string; readonly detail?: string }
export function resolveToolDisplay(name: string, argsJson?: string): ToolDisplay
export interface ToolLineOptions {
  detailMode: 'compact' | 'verbose'            // simplified two tiers of explain/raw (see §3.2 two-axis)
  commandText?: 'status' | 'raw'               // whether shell command text outputs as a full line
  maxDetailChars?: number                      // default 40
}
export function formatToolLine(display: ToolDisplay, opts: ToolLineOptions): string
export function formatToolResultLine(name: string, opts: { ok: boolean; durationMs?: number; summary?: string }): string

// ---- [changed] format.ts additions ----
export function stripReasoningTags(text: string, opts?: { mode?: 'strict' | 'preserve'; scope?: 'all' | 'leading' }): string

// ---- B. stream.ts ----
export interface StreamCaps {
  streamingMode: 'off' | 'block' | 'progress'
  supportsEdit: boolean
  supportsStatusText: boolean
  supportsThinking: boolean
}
/** The consumer projects session events into this discriminated union, then feeds it to the reducer (never feeding SessionEvent directly, to stay pure). */
export type StreamInput =
  | { readonly kind: 'turn-start' }
  | { readonly kind: 'step-start'; readonly turn: number; readonly step: number }
  | { readonly kind: 'step-end'; readonly turn: number; readonly step: number }
  | { readonly kind: 'tool-call'; readonly callId: string; readonly name: string; readonly arguments: string }
  | { readonly kind: 'tool-result'; readonly callId: string; readonly name: string; readonly ok: boolean; readonly durationMs?: number; readonly summary?: string }
  | { readonly kind: 'text-delta'; readonly text: string }
  | { readonly kind: 'reasoning-delta'; readonly text: string }
  | { readonly kind: 'assistant-message'; readonly text: string }
  | { readonly kind: 'turn-end'; readonly reason: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' }
  | { readonly kind: 'tick' }                    // timer edge (1500ms gating, following merge.ts's tick)
/** The reducer's internal state (opaque to the consumer; a projection tests can assert on). */
export interface StreamState {
  readonly mode: 'off' | 'block' | 'progress'
  readonly bufferedText: string                  // text assembled but not yet final
  readonly draftState: 'none' | 'created' | 'finalized'
  readonly openToolLines: ReadonlyMap<string, string>   // callId → status line (awaiting tool/result settle)
  readonly progressStarted: boolean              // whether gating has fired
}
export type StreamFrame =
  | { readonly kind: 'noop' }
  | { readonly kind: 'final'; readonly text: string }
  | { readonly kind: 'draft-new'; readonly text: string }
  | { readonly kind: 'draft-edit'; readonly text: string }
  | { readonly kind: 'draft-finalize' }
  | { readonly kind: 'draft-discard' }
  | { readonly kind: 'status-line'; readonly text: string }
  | { readonly kind: 'arm-timer'; readonly at: number }   // ask the outside to feed one tick at time at
export function streamReduce(state: StreamState, input: StreamInput, caps: StreamCaps, now: number): { state: StreamState; frames: StreamFrame[] }

// ---- C. prompt-render.ts (generalized from approval-render.ts, old exports preserved) ----
export interface PendingPrompt {
  readonly num: number                      // incrementing number within the session (#n answer key)
  readonly requestId: string                // stable id (logging/audit)
  readonly question: string
  readonly detail?: string
  readonly options: readonly string[]       // option labels (channel-agnostic, independent of callback ids)
  readonly multiSelect: boolean
  readonly allowFreeText: boolean
  readonly recommendedIndex?: number        // the hermes "(Recommended)" marker
  readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
  readonly expiresAt: number
  /** Filled by the bridge layer: back-filled when the user's answer arrives. For single-select, custom overrides selected; for multi-select, custom supplements it. */
  resolve(selected: readonly string[], custom?: string): void
}
export type PromptAnswer = { readonly selected: string[]; readonly custom?: string }
export interface PromptOptions {
  supportsChoices: boolean
  supportsMultiSelect: boolean
  presentationLimits?: PresentationLimits   // passed through from Channel.presentationLimits
}
export type RenderedPrompt =
  | { readonly kind: 'choices'; readonly text: string; readonly choices: OutboundChoice[] }
  | { readonly kind: 'text'; readonly text: string }
/** Option id encoding convention (callback side, used only on the buttons path; text degradation never carries it):
 *  button `prompt:<num>:<idx>`, free-text entry `prompt:<num>:other`. Constrained by maxValueBytes (num is a short integer). */
export function renderPrompt(
  p: { num: number; question: string; detail?: string; options: readonly string[]; multiSelect?: boolean; allowFreeText?: boolean; recommendedIndex?: number; intent?: { kind: 'plan-review'; approve: string } },
  caps: PromptOptions,
): RenderedPrompt
export type PromptReply =
  | { readonly kind: 'answer'; readonly num: number; readonly answer: PromptAnswer }
  | { readonly kind: 'not-an-answer' }
export function parsePromptReply(
  input: { readonly text?: string; readonly choiceId?: string; readonly now?: number },
  pending: readonly PendingPrompt[],
): PromptReply
// Backward compatibility: renderApproval / parseApprovalReply are the options=['Approve','Reject'] special case of renderPrompt/parsePromptReply.
```

### 7.3 `dsh-channel-telegram` (bridge layer, `[new]`)

```ts
// ---- Unified interaction-prompt responder: one PromptBroker serving two dsh seams (§4.3) ----
interface PromptBroker {
  /** approval/request side: waterfall answerer (already implemented, rendering switched to renderPrompt). */
  onApprovalRequest(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>
  /** user-questions side: UserQuestionProvider (ask projected into renderPrompt + parsePromptReply). */
  askUserQuestions(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
  /** Unified inbound-answer entry point: text/callback first parsePromptReply, then resolve the matching PendingPrompt. */
  resolveInboundReply(input: { text?: string; choiceId?: string }): boolean
}

// ---- draft ledger key convention (§4.5) ----
// draftKey = `draft:<sessionId>:<turn>`; within one turn the progress draft reuses the same key, finalize/discard at turn end.
// store additions: setDraft(chatKey, draftKey, platformMessageId) / draftMessageId(chatKey, draftKey) / clearDraft(chatKey, draftKey)
```

### 7.4 Not yet defined / to be settled after a spike (honestly flagged, one-to-one with §6)

| Gap | Why not settle now | Depends on |
|---|---|---|
| Where `ChannelPromptProvider` registers (agent scope vs global routing provider) | §6 Q1 single-provider-slot scope unverified | `dsh-user-questions` spike |
| Whether `thinkingLevel: 'off'|'on'|'stream'` replaces the boolean `supportsThinking` | §6 Q2 | whether the `on` tier is wanted |
| Whether the callback id prefix is `prompt:` or reuses the existing `appr:` | our own convention, unrelated to dsh, settle at implementation time | none |

---

## Appendix: reference index

- dsh seam source: `dsh-session/lib/types/types.d.ts` (`assistant/chunk`/`tool/call`/`tool/result`/`turn·step`) · `dsh-llm/lib/types/types.d.ts` (`StreamChunk`/`ContentBlock`/`reasoning`) · `dsh-user-approval/lib/types` · [dsh `user-questions`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/user-questions/src/index.ts) and [user-questions docs](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/user-questions.zh.md)
- hermes: [`gateway/platforms/base.py`](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/base.py) (`send_draft`/`send_clarify`/`send_slash_confirm`/`send_typing`/`set_status_text`) · [`gateway/stream_events.py`](https://github.com/NousResearch/hermes-agent/blob/main/gateway/stream_events.py) · [`tools/clarify_gateway.py`](https://github.com/NousResearch/hermes-agent/blob/main/tools/clarify_gateway.py) · [`tests/gateway/test_discord_clarify_buttons.py`](https://github.com/NousResearch/hermes-agent/blob/main/tests/gateway/test_discord_clarify_buttons.py)
- openclaw: [`src/channels/streaming.ts`](https://github.com/openclaw/openclaw/blob/main/src/channels/streaming.ts) · [`src/agents/tool-display.ts`](https://github.com/openclaw/openclaw/blob/main/src/agents/tool-display.ts) · [`src/channels/plugins/types.core.ts`](https://github.com/openclaw/openclaw/blob/main/src/channels/plugins/types.core.ts) (`ChannelCapabilities`) · [`src/polls.ts`](https://github.com/openclaw/openclaw/blob/main/src/polls.ts) · [`docs/concepts/progress-drafts.md`](https://github.com/openclaw/openclaw/blob/main/docs/concepts/progress-drafts.md)
