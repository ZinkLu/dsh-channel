# Hermes-Agent Channel-Facing Capabilities — Source-Grounded Report

> Research target: `NousResearch/hermes-agent` @ `main` (tree SHA `c896c09c42910c584c4c7d2325b58c14713ea42c`).
> Purpose: port the ideas into a TypeScript "dsh-channel" abstraction layer using the **capability-fact + graceful-degradation** pattern.
>
> **Important layout correction:** the task description says adapters live in `gateway/platforms/base.py`, `discord.py`, `telegram.py`, `slack`. As of `main`, the base class IS `gateway/platforms/base.py`, but the per-platform adapters have moved to **`plugins/platforms/<name>/adapter.py`** (Discord/Telegram/Slack/Matrix/Feishu). `gateway/platforms/` now holds the base + a few legacy in-tree adapters (signal, whatsapp*, weixin, yuanbao, bluebubbles, api_server, webhook…). All line numbers below refer to the fetched `main`-branch files.

---

## 1. Adapter surface (`gateway/platforms/base.py`)

### 1.1 The base class and the enforced vs. documented "required" set

`BasePlatformAdapter(ABC)` is defined at **`gateway/platforms/base.py:2884`** (7322 lines total). Only **four** methods are actually enforced with `@abstractmethod`:

| Method | Location | Signature (abridged) |
|---|---|---|
| `connect` | `base.py:3870` | `async def connect(self, *, is_reconnect: bool = False) -> bool` |
| `disconnect` | `base.py:3890` | `async def disconnect(self) -> None` |
| `send` | `base.py:3895` | `async def send(self, chat_id, content, reply_to=None, metadata=None) -> SendResult` |
| `get_chat_info` | `base.py:7112` | `async def get_chat_info(self, chat_id) -> Dict[str, Any]` (returns at least `{name, type}`) |

The two others the docs call "required" are **not** abstract — they degrade silently:

- `send_typing(self, chat_id, metadata=None)` — `base.py:4273`, body is `pass` (no-op). "Override in subclasses if the platform supports it."
- `send_image(...)` — `base.py:4371`, falls back to **sending the URL as plain text** (`f"{caption}\n{image_url}"`).

`gateway/platforms/ADDING_A_PLATFORM.md:91-101` lists the "Required methods" as `__init__`, `connect`, `disconnect`, `send`, `send_typing`, `send_image`, `get_chat_info`. So **the docs over-state the contract** — only connect/disconnect/send/get_chat_info are hard-required; send_typing and send_image have safe defaults. This is exactly the "graceful-degradation" nuance to copy.

### 1.2 Capability flags (class attributes, read generically via `getattr(adapter, "…", default)`)

These are the heart of the "capability-fact" idea — each is a boolean/string/function the *gateway* reads generically so there is **no per-platform branching at call sites**:

| Flag | Default | Location |
|---|---|---|
| `supports_code_blocks` | `False` | `base.py:2903` |
| `supports_status_text` | `False` | `base.py:2911` (enables `set_status_text`, `base.py:2913`) |
| `supports_async_delivery` | `True` | `base.py:2945` |
| `splits_long_messages` | `False` | `base.py:2953` |
| `typed_command_prefix` | `"/"` | `base.py:2965` (Slack/Matrix alias to `"!"`) |
| `supports_inchannel_continuable` | `False` | `base.py:2980` |
| `interactive_resume` | `True` | `base.py:2993` |
| `REQUIRES_EDIT_FINALIZE` | `False` | `base.py:3922` |
| `MAX_MESSAGE_LENGTH` | `4096` (when absent) | `base.py:3128-3136` |
| `supports_draft_streaming(chat_type, metadata)` | `False` | `base.py:3209` |
| `prefers_fresh_final_streaming(content, metadata)` | `False` | `base.py:3228` |
| `streaming_overflow_limit()` | `None` | `base.py:3251` |
| `supports_streaming_tts(chat_id, audio_format)` | `False` | `base.py:4532` |

### 1.3 The full optional surface + how each default degrades

Every one of these has a **safe, "do less" default** (never a crash, never a leak):

| Method | Location | Graceful-degradation default |
|---|---|---|
| `send_draft(...)` | `base.py:3268` | raises `NotImplementedError`; consumer falls back to `send`+`edit_message` |
| `edit_message(...)` | `base.py:3951` | `SendResult(success=False, error="Not supported")` → caller sends a new message instead |
| `delete_message(...)` | `base.py:3980` | `False` → leave message in place |
| `create_handoff_thread(...)` | `base.py:3924` | `None` → use `parent_chat_id` |
| `send_slash_confirm(...)` | `base.py:4144` | `Not supported` → gateway text fallback (`/approve` `/always` `/cancel`) |
| `send_clarify(...)` | `base.py:4179` | numbered text list `❓ question\n 1. a\n 2. b…` + `mark_awaiting_text(clarify_id)` |
| `send_private_notice(...)` | `base.py:4253` | falls back to `send()` |
| `stop_typing(...)` | `base.py:4282` | no-op |
| `send_multiple_images(...)` | `base.py:4314` | loops `send_image`/`send_animation`/`send_image_file` |
| `send_animation(...)` | `base.py:4390` | falls back to `send_image` |
| `send_voice(...)` | `base.py:4461` | sends `"⚠️ Couldn't deliver the audio attachment."` — **never echoes the host path** |
| `play_tts(...)` | `base.py:4510` | falls back to `send_voice` |
| `begin/write/finish/abort_streaming_tts` | `base.py:4539-4567` | `None`/no-op → whole-file TTS fallback |
| `send_video(...)` | `base.py:4607` | `"⚠️ Couldn't deliver the video attachment."` |
| `send_document(...)` | `base.py:4634` | `"⚠️ Couldn't deliver the file attachment (name)."` |
| `format_message(content)` | `base.py:7142` | returns content as-is |
| `truncate_message(content, max_length=4096, len_fn=None)` | `base.py:7154` | static; code-fence-aware splitting, adds `(1/3)` indicators |
| `toolsets_for_source(source)` | `base.py:7122` | `None` (use platform-level toolset) |
| `on_processing_start(event)` | `base.py:5327` | no-op |
| `on_processing_complete(event, outcome)` | `base.py:5330` | reaction-ack only if `_OK_EMOJI`/`_FAIL_EMOJI` + `_add_reaction`/`_remove_reaction` defined |
| `format_tool_event(event, mode, preview_max_len=40)` | `base.py:3331` | reproduces historical emoji + tool_name + preview chrome; return `None` to "eat" it |
| `format_tool_preview(preview)` | `base.py:3380` | returns `preview.text` |
| `render_message_event(event, sink)` | `base.py:3310` | maps MessageChunk/MessageStop/Commentary onto `sink.on_delta/on_segment_break/on_commentary` |

Supporting types/constants:

- `SendResult` — `base.py:2460`: `success`, `message_id`, `error`, `raw_response`, `retryable`, `retry_after`, `continuation_message_ids`, `error_kind`. `SEND_ERROR_KINDS` = `{too_long, bad_format, forbidden, not_found, rate_limited, transient, unknown}` — `base.py:2510`, populated by `classify_send_error` (`base.py:2559`).
- `MessageType` enum — `base.py:2272` (`text/location/photo/video/audio/voice/document/sticker/command`); `ProcessingOutcome` — `base.py:2285` (`success/failure/cancelled`).
- Exec-approval text template constants — `_EA_HEADER = "⚠️ Command Approval Required\n\n"`, `_EA_CMD_BUDGET = 3000`, etc. at `base.py:4064-4071`; `_format_exec_approval(...)` at `base.py:4090`.
- `_format_choice_page(options, page, per_page)` pagination core — `base.py:4115`.

### 1.4 The "built-in paths" maintenance burden (16 places to touch)

`gateway/platforms/ADDING_A_PLATFORM.md` documents **two paths**:

1. **Plugin path (recommended)** — `plugin.yaml` + `adapter.py` + `ctx.register_platform()`; **zero core changes** (`ADDING_A_PLATFORM.md:5-73`).
2. **Built-in path (core contributors)** — a 16-point checklist (`ADDING_A_PLATFORM.md:78-404`). The list, for your "argue AGAINST" case:

1. Core adapter `gateway/platforms/<platform>.py`
2. `Platform` enum + env loading in `gateway/config.py` (`_apply_env_overrides`)
3. Adapter factory `gateway/run.py` (`_create_adapter`)
4. Authorization maps in `gateway/run.py` (`_is_user_authorized`: `platform_env_map` + `platform_allow_all_map`)
5. `SessionSource` dataclass in `gateway/session.py`
6. `PLATFORM_HINTS` in `agent/prompt_builder.py`
7. Named toolset in `toolsets.py`
8. Cron delivery `platform_map` in `cron/scheduler.py`
9. `tools/send_message_tool.py` (`platform_map` + `_send_to_platform` + `_send_<platform>()`)
10. `tools/cronjob_tools.py` schema description
11. `gateway/channel_directory.py` session-discovery list
12. `hermes_cli/status.py` status display dict
13. `hermes_cli/gateway.py` setup wizard `_PLATFORMS` list
14. `agent/redact.py` phone/ID redaction
15. Documentation (README, AGENTS.md, website docs ×4 files)
16. Tests (`tests/gateway/test_<platform>.py`)

The doc's own "Quick Verification" even says: `grep -r "telegram\|discord\|whatsapp\|slack" gateway/ tools/ agent/ cron/ hermes_cli/ toolsets.py` and "if it mentions other platforms but not yours, you missed it" (`ADDING_A_PLATFORM.md:400-403`) — i.e. the integration is **string-greppable sprawl**, not an interface. This is the concrete evidence to argue for a capability-flag seam + plugin registry instead of the 16-touchpoint spread.

---

## 2. Streaming

### 2.1 Architecture

`gateway/stream_consumer.py` — `GatewayStreamConsumer` (`:156`) bridges sync agent callbacks to async platform delivery. The agent fires `stream_delta_callback(text)` from its worker thread; `on_delta()` (`:611`) enqueues onto a `queue.Queue`; the async `run()` loop (`:781`) buffers, rate-limits, and **progressively edits a single message**.

`gateway/stream_events.py` defines a small typed event vocabulary (frozen dataclasses, presentation-only, nothing persisted to history): `MessageChunk`, `MessageStop`, `Commentary`, `ToolCallChunk`, `ToolCallFinished`, `LongToolHint`, `GatewayNotice` (union `StreamEvent`, `stream_events.py:151`). The platform adapter decides *how* to render each (`BasePlatformAdapter.render_message_event` / `format_tool_event`), so tool chrome can be eaten on platforms that can't render it (`stream_events.py:11-32`).

### 2.2 Per-platform nature and transport selection

- `StreamConsumerConfig` (`stream_consumer.py:128`): `edit_interval`, `buffer_threshold`, `cursor`, `buffer_only`, `fresh_final_after_seconds`, `transport` (`"auto" | "draft" | "edit" | "off"`), `chat_type`.
- Config defaults (`gateway/config.py`): `DEFAULT_STREAMING_EDIT_INTERVAL = 0.8` (`:760`), `DEFAULT_STREAMING_BUFFER_THRESHOLD = 24` (`:761`), `DEFAULT_STREAMING_CURSOR = " ▉"` (`:762`). `StreamingConfig` (`:765`) has `enabled=False`, `transport="auto"`, `fresh_final_after_seconds=0.0`.
- **Per-platform shipped defaults**: `display.platforms.telegram.streaming=true`, `.discord=false`, `.slack=false` (`tests/gateway/test_per_platform_streaming_defaults.py:14-19`) — Telegram streams natively, edit-only platforms flicker, so streaming is off-by-default there.
- Native draft streaming: Telegram `sendMessageDraft` (Bot API 9.5+). `_resolve_draft_streaming()` (`stream_consumer.py:1696`) honors `transport`, probes `adapter.supports_draft_streaming(chat_type, metadata)`; `_send_draft_frame()` (`:1739`) disables drafts permanently for the run on first failure and falls back to edit. Drafts have no `message_id`; the final answer is always delivered as a real `send`.

### 2.3 Degradation on platforms without edit

- `SUPPORTS_MESSAGE_EDITING` class attribute (default `True`): platforms that can't edit (QQ, WeChat) **skip streaming entirely** — otherwise a partial first message could never be updated and would duplicate (`gateway/run.py:26153-26155`).
- Matrix: `cursor=""` + `buffer_only=True` (some Matrix clients render the cursor as tofu) — `gateway/run.py:26160-26163`.
- `edit_message` base default returns `success=False` → consumer routes to `_send_fallback_final` (`stream_consumer.py:1384`) and `_send_empty_fallback_final` (`:1581`).
- Fresh-final path (Telegram only): `prefers_fresh_final_streaming` / `fresh_final_after_seconds` → delete the preview and send the completed reply as a fresh message so the timestamp reflects completion (`stream_consumer.py:1863-1964`; `gateway/run.py:26164-26173`).

### 2.4 Rate-limit / flood gating

- `_MAX_FLOOD_STRIKES = 3` — after 3 consecutive flood-control edit failures, progressive edits are permanently disabled for the stream (`stream_consumer.py:171-173`).
- Adaptive backoff via `_current_edit_interval`; `_max_fallback_flood_retry_seconds = 5.0` (`:260`); `_fallback_flood_retry_delay`/`_is_flood_error` (`:1674`, `:1690`).
- Overflow split (`_split_text_chunks`, `_truncate_for_stream`) with code-fence balancing and `(n/total)` indicators; `streaming_overflow_limit()` lets rich-capable adapters (Telegram 32,768) raise the cap (`base.py:3251`).
- `send_draft` per-frame failure → permanent disable for that run (`:1760-1774`).

### 2.5 Typing gating around streaming

`on_before_finalize` callback pauses the typing refresh before a slow final rich-text edit (Telegram), wired in `gateway/run.py:26140-26145` (`_pause_typing_before_finalize`). This is the streaming↔typing coupling point.

---

## 3. Tool-use display + thinking/reasoning rendering

### 3.1 Central handler

`TurnRunner.progress_callback(event_type, tool_name, preview, args, **kwargs)` — **`gateway/run.py:3911`**. This is the single chokepoint for tool progress, live status, thinking relay, log mode, and long-tool onboarding.

### 3.2 Tool progress (status lines / "cards")

- Only `tool.started` events render bubbles (`gateway/run.py:4011-4013`); `tool.completed` is used for duration/long-tool hints (`:3959`).
- Modes (`progress_mode`): `off` / `all` / `new` / `verbose` / `log` (see `_display_surface_mode`, `gateway/run.py:26760`). `new` = only report when tool changes (`:4043`).
- Chrome: `get_tool_emoji(tool_name, default="⚙️")` (`agent/display.py:148`) + friendly verb + preview. `_TOOL_VERBS` map (`agent/display.py:639-664`, e.g. `web_search→"Searching the web"`, `terminal→"Running"`); `get_tool_verb` (`:693`), `tool_verb_connector` (`:706`), `verb_drops_preview` (`:711`).
- Short preview cap: `tool_preview_length` default **40** (`gateway/run.py:4061, 4088, 4122`). Verbose mode dumps full args JSON (`:4098-4120`).
- Terminal commands on `supports_code_blocks` platforms render as fenced code blocks instead of `terminal: "cmd…"` (`gateway/run.py:4070-4096`).
- `format_tool_preview` / `format_tool_event` adapter hooks (`base.py:3380`, `3331`) let rich-text adapters (Telegram) override presentation, and plain-text adapters (iMessage) "eat" chrome by returning `None`.
- Rendering drain: `TurnRunner.send_progress_messages` (`gateway/run.py:4364`) edits one progress bubble, throttled by `_PROGRESS_EDIT_INTERVAL = 1.5`s (`:4398`); `progress_grouping="separate"` = one message per tool (`:4396`); dedups consecutive identical lines with `(×N)` (`:4168-4176`).
- Skip progress for non-editable platforms (each line would be a separate bubble) — `gateway/run.py:4379-4392`.
- Clarify tool is never rendered as a progress bubble (`gateway/run.py:4023-4024`).
- Slack-only native "task cards" via `chat.startStream` when `adapter.native_task_cards_enabled()` (`gateway/run.py:4182-` `_send_native_task_card_progress`; `:26842-26862`).
- `log` mode writes `~/.hermes/logs/tool_calls.log` (rotating, redacted) instead of chat (`gateway/run.py:26816-26819`; `tests/gateway/test_tool_log_mode.py`).
- Long-tool onboarding nudge: `_LONG_TOOL_THRESHOLD_S = 30.0` (`gateway/run.py:26924`) → one-shot `/verbose` hint.

### 3.3 Thinking / reasoning surfacing

- **Hidden by default.** Inline `<think>/<reasoning>/<THINKING>/<thought>` blocks are stripped from streamed edits by a state machine in `GatewayStreamConsumer._filter_and_accumulate` (`stream_consumer.py:635`), with `_OPEN_THINK_TAGS`/`_CLOSE_THINK_TAGS` (`:178-185`) and `_strip_orphan_close_tags` (`:737`). This mirrors the CLI's `_stream_delta` suppression.
- `_thinking` / `reasoning.available` agent scratch text is **relayed only when `thinking_progress` is enabled** (default off; Mattermost requires explicit per-platform override) as `💬 {text}` (`gateway/run.py:3982-3994`, `:26832-26841`).
- TTS scripts strip reasoning blocks (`⋗` reasoning + `<think>`) via `prepare_tts_text` (`base.py:4490-4508`) and `tools/tts_text_normalize`.
- Reasoning config is per-session: `_resolve_session_reasoning_config` (`gateway/run.py:8857`); hidden-reasoning-without-visible-answer is detected by `_is_gateway_hidden_reasoning_incomplete_turn` (`gateway/run.py:3724`).

**Key takeaway:** thinking/reasoning is *never* surfaced to the user by default; the two opt-in surfaces are (a) `thinking_progress` scratch text, and (b) the streaming consumer's tag-filter, which only *removes* reasoning. There is no "expandable thinking card" — thinking is filtered, not rendered.

---

## 4. Agent offer / options (approve-reject, option A/B, clarify) — most important

### 4.1 Clarify request shape (the "option A/B" primitive)

The tool schema is **`tools/clarify_tool.py`** `CLARIFY_SCHEMA` (`:236`) / `clarify_tool` (`:153`):

- `question` (string, **required**) — and the schema explicitly forbids enumerating options in the question text (`:248-253`).
- `choices` (array of strings, **max `MAX_CHOICES = 4`** — `:23`).
- `multi_select` (bool, default false → radio vs checkbox).
- First choice is auto-decorated `" (Recommended)"` by `mark_recommended` (`:64`), stripped back on resolve by `strip_recommended` (`:86`). A 5th `"✏️ Other (type your answer)"` option is always appended by the UI (`:22-24`).
- Output JSON: `{"question", "choices_offered", "user_response"}` (`:220-224`).
- Choice normalization: dict-shaped LLM choices are unwrapped via canonical keys `label → description → text → title` (never `name`/`value`) — `_flatten_choice` (`clarify_tool.py:31-61`).

### 4.2 The blocking gateway primitive

**`tools/clarify_gateway.py`** is module-level state (so adapters resolve without a back-reference to the runner):

- `_ClarifyEntry` (`:48`): `clarify_id`, `session_key`, `question`, `choices`, `multi_select`, `event` (threading.Event), `response`, `awaiting_text`.
- `register(...)` (`:80`) → `wait_for_response(clarify_id, timeout)` (`:107`, polls in 1s slices so the inactivity heartbeat keeps firing) → `resolve_gateway_clarify(clarify_id, response)` (`:164`) unblocks the thread.
- `mark_awaiting_text(clarify_id)` (`:350`) flips an entry to text-capture (the "Other" path). `resolve_text_response_for_session` (`:329`) handles typed replies (numbers "2" → choice[1], exact label, or custom text; multi-select "1,3" → JSON array).
- Timeout default **3600s (1 hour)** — `resolve_clarify_timeout` (`:398`), `get_clarify_timeout` (`:421`); `<= 0` = unlimited. (Was 600s; raised because late taps landed on evicted entries — `:421-436`.)
- `clear_session` (`:370`) resolves all pending with `""` on `/new`/shutdown.

### 4.3 Approval request shape (the approve/deny primitive)

**`tools/approval.py`**:

- `approval_data` dict shape: `{command, description, pattern_keys}` (plus `pattern_key`) — see `register_gateway_notify` (`:2581-2587`) and `_await_gateway_decision` (`:3887-3914`).
- `_ApprovalEntry` (`:2563`): `event`, `data`, `result` (`"once" | "session" | "always" | "deny"`), `reason`.
- Queue: `_gateway_queues[session_key] = [_ApprovalEntry, …]` (`:2577`). `resolve_gateway_approval(session_key, choice, resolve_all=False, reason=None)` (`:2606`) pops the oldest (FIFO) and sets `entry.event`.
- Timeout default **300s** — `_get_approval_timeout` (`:3086`); wait loop polls 1s slices, resolves `"deny"` on interrupt/timeout (`:3949-4014`). `human_wait_window` excludes this from batch deadlines.
- `clear_session` (`:2698`) resolves pending with `"deny"`. `approve_session`/`approve_permanent`/`is_approved` persist scopes (`:2654`, `:2742`, `:2728`).
- Base renders exec-approval text via `_format_exec_approval(command, description, smart_denied)` (`base.py:4090`); button construction is per-adapter.

### 4.4 Per-platform button rendering + callback id conventions

**Telegram** (`plugins/platforms/telegram/adapter.py`) — inline keyboard (`InlineKeyboardMarkup`/`InlineKeyboardButton`):

- Exec approval `send_exec_approval` (`:5823`): buttons `✅ Allow Once / ✅ Session / ✅ Always / ❌ Deny`, `callback_data=f"ea:{choice}:{approval_id}"` (`:5854-5864`), approval_id from a monotonic counter, `_approval_state[approval_id] = session_key` (`:5892`).
- Slash confirm `send_slash_confirm` (`:5899`): `sc:once|always|cancel:{confirm_id}` (`:5912-5916`).
- Clarify `send_clarify` (`:5947`): renders full option text in the body, short numeric buttons `callback_data=f"cl:{clarify_id}:{idx}"` + `cl:{clarify_id}:other` (`:5993-6009`); `_clarify_state[clarify_id] = session_key` (`:6023`). Telegram caps `callback_data` at 64 bytes (`:5993`).
- Dispatch `_handle_callback_query`-style: `ea:` (`:6755-6815`), `sc:` (`:6817-6915`), `cl:` (`:6917-7031`). Auth check `_is_callback_user_authorized`, resolve-first-then-render, `query.answer()` + `edit_message_text` with buttons removed; "Other" flips via `mark_awaiting_text`; stale tap → "⌛ Approval expired" / `_notify_clarify_expired`.
- Model picker (`:6029`) & choice picker (`:6103`): `cp:{i}`, `mp:{slug}`, `mpg:{group_id}`, `mpv:{page}`, `mm:{idx}`, `mg:{page}`, `mb`, `mc:{idx}`, `mx` (`:6128-6329`).

**Discord** (`plugins/platforms/discord/adapter.py`) — `discord.ui.View` + closure callbacks (no string dispatcher):

- `ExecApprovalView` (`:8745`): `@discord.ui.button` Allow Once/Session/Always/Deny → `_resolve(interaction, choice, color, label)` → `resolve_gateway_approval`. `timeout=_read_discord_prompt_timeout()` default **300s**, clamped 30–900 (`:984-1024`); `on_timeout` disables buttons (`:8891`).
- `ClarifyChoiceView` (`:9540`): buttons `custom_id=f"clarify:{clarify_id}:{index}"` + `clarify:{clarify_id}:other` (`:9615`, `:9623`); label truncation to 80 chars (`_DISCORD_BUTTON_LABEL_LIMIT = 80`, `:87`), cut on word/soft boundary; `_resolve_choice` (`:9638`) looks up canonical choice text from the entry.
- Auth: `_component_check_auth` (`:8609`) gates every click on allowlist/roles; unauthorized → ephemeral rejection; single-use `self.resolved` guard.

**Slack** (`plugins/platforms/slack/adapter.py`) — Block Kit buttons (`type: "button"` in an `actions` block):

- Approval (`send_exec_approval` `:6867`): `action_id` = `hermes_approve_once/session/always/deny`, `value = session_key` (`:6911-6934`). Section text capped at 3000 chars (`:6892-6904`).
- Slash confirm (`:6973`): `hermes_confirm_once/always/cancel`, `value = f"{session_key}|{confirm_id}"` (`:6999`).
- Clarify (`:7054`): `hermes_clarify_choice_{idx}` with `value = f"{clarify_id}|{idx}"`, plus `hermes_clarify_other` (`:7120-7127`); chunked into 5-element actions blocks (Slack cap) (`:7133-7134`). Open-ended delegates to `super().send_clarify`.
- Handlers: `_handle_approval_action` (`:7372`) and `_handle_clarify_action` (`:7528`) — atomic-pop double-click guard via `_approval_resolved`/`_clarify_resolved` maps (`:7420-7424`), `_is_interactive_user_authorized` (`:7159`), `chat.update` rewrites message to a `context` block with the decision text and drops buttons.

**Matrix** (`plugins/platforms/matrix/adapter.py`) — **no buttons; emoji reactions**: `send_exec_approval` (`:2610`) renders `_format_exec_approval` + a reaction legend `✅ = approve once / 🌀 = session / ♾️ = always / ❎ = deny`; `_approval_reaction_map` (`:1306`), `_approval_timeout_seconds` default 300 (`:1322-1326`); reaction routing in `_on_reaction` (`:2044`).

**Feishu** (`plugins/platforms/feishu/adapter.py`) — interactive **card** actions: `send_exec_approval` (`:2057`) builds `value={"hermes_action": ..., "approval_id": approval_id}`; `_handle_approval_card_action` (`:2781`) schedules `resolve_gateway_approval` and returns the resolved card synchronously.

### 4.5 Callback id convention — a correction

`ADDING_A_PLATFORM.md:125` documents `cl:<id>:<idx>`, `appr:<id>:<choice>`, `sc:<choice>:<id>`. The **actual** `main` code uses:

- `ea:{choice}:{approval_id}` for exec approval (Telegram) — **not** `appr:`.
- `sc:{choice}:{confirm_id}` for slash confirm.
- `cl:{clarify_id}:{idx}` / `cl:{clarify_id}:other` for clarify (Telegram) and `clarify:{clarify_id}:{idx}` (Discord).
- Slack uses `action_id` + `value` packing instead of a serialized string id.

So the docs are stale on the `appr:` prefix; the real convention is **`<verb>:<payload…>` with the resolvable id embedded in `callback_data`/`value`/`custom_id`**, and the resolution is always `resolve_gateway_approval(session_key, choice)` / `resolve_gateway_clarify(clarify_id, text)` at the module level (no runner reference).

### 4.6 Timeout / cancellation summary

- Clarify: `wait_for_response` timeout (default 3600s, `<=0` unlimited); text-intercept catches typed replies; `clear_session` on `/new`/shutdown resolves with `""`.
- Approval: `_await_gateway_decision` timeout (default 300s) resolves `"deny"` on timeout/interrupt; `clear_session` resolves `"deny"`.
- Platform-side expiry: Discord `View.on_timeout` disables buttons; Telegram/Slack edit the message to "⌛ Approval expired"/"⏱ Prompt expired" when `resolve_*` returns 0/False (count==0 = already timed out), never claiming "Approved" on a stale tap.

---

## 5. Processing status (typing / working / heartbeat)

### 5.1 Typing indicators

- `send_typing(chat_id, metadata)` — one-shot, no-op default (`base.py:4273`).
- `_keep_typing(chat_id, interval=2.0, metadata, stop_event)` — **`base.py:5079`**: refreshes every 2s (Telegram/Discord typing expires after ~5s), each call bounded by a `~1.5s` timeout (`_send_typing_timeout = max(0.25, min(1.5, interval-0.25))`, `:5109`), skips when chat is in `_typing_paused`.
- `stop_typing` (`:4282`) / `_stop_typing_with_metadata` (`:4290`) / `_stop_typing_refresh` (`:5165`, 0.5s timeout, 2 attempts).
- `pause_typing_for_chat` / `resume_typing_for_chat` (`:5198`/`:5206`) — pause during approval waits (Slack's assistant status disables the compose box; users must be able to type `/approve`), resume after resolution (also `gateway/run.py:5564, 5722-5724`).
- Telegram-specific cooldown on transient failures: `_telegram_typing_cooldown_seconds` (default 30s), `_telegram_typing_cooldown_until` dict (`tests/gateway/test_telegram_typing_backoff.py:49-72`).
- Telegram `extra.status_indicator` sets the bot's **short description** to "Online"/"Offline" on connect/disconnect (no presence dot exists for bots) — `tests/gateway/test_telegram_status_indicator.py`.

### 5.2 "Working" status line (Slack assistant status)

- `supports_status_text` capability (`base.py:2911`) + `set_status_text(chat_id, text)` (`:2913`, in-memory only; next typing refresh renders it).
- Live phrase built by `build_status_phrase(tool_name, args, max_len=49)` (`agent/display.py:716`) — e.g. `"is running scripts/run_tests.sh…"`, starting lowercase "is" to follow the bot name; `live_status` mode `"verb"` (no args) vs `"full"` (`gateway/run.py:26808-26815`). Rides the `_keep_typing` refresh so it costs **zero extra API calls** (`gateway/run.py:26802-26807`).

### 5.3 Lifecycle reactions

- `on_processing_start` / `on_processing_complete` (`base.py:5327`/`:5330`): swap an in-progress reaction for `_OK_EMOJI`/`_FAIL_EMOJI` (`:5324-5325`) when `_add_reaction`/`_remove_reaction` are defined; CANCELLED leaves unreacted.

### 5.4 Progress cleanup + heartbeat

- `display.platforms.<platform>.cleanup_progress: true` auto-deletes tool-progress / "⏳ Working — N min" / status bubbles after the final response (Telegram + any adapter with `delete_message`) — `gateway/run.py:26899-26919`.
- Event-loop liveness heartbeat: `loop_heartbeat_forever` rewrites `state/gateway.heartbeat` every 30s (`gateway/run.py:6372-6375`, `:12210-12228`); per-session `/heartbeat` command backed by `hermes_cli/heartbeat.py` `HeartbeatManager` + `POLL_SECONDS` poller (`gateway/run.py:20268-20336`).
- "⏳ Gateway is running/…" busy notices and "⏳ Subagent working — your message is queued…" are `GatewayNotice`/status strings (`gateway/run.py:9561-9563`, `:9910-9920`).

---

## Key takeaways for a "channel abstraction" (capability-fact + graceful-degradation)

1. **Separate "hard contract" from "capability facts".** Only `connect`/`disconnect`/`send`/`get_chat_info` are abstract in Hermes (`base.py:3869/3890/3895/7112`). Everything else — `send_typing`, `send_image`, `send_file`, `send_voice`, buttons, model picker, status — is an **optional method with a safe no-op/text-fallback default**, plus a **boolean/string capability flag** read generically via `getattr(adapter, flag, default)`. In TS: an interface `ChannelAdapter` with 4 required methods and a `capabilities` object (`supports_code_blocks`, `supports_status_text`, `supports_draft_streaming`, `supports_edit`, `splits_long_messages`, `typed_command_prefix`, …) instead of N optional methods each needing per-platform branching.

2. **The 16-touchpoint built-in path is the anti-pattern.** `ADDING_A_PLATFORM.md:78-404` proves a built-in adapter touches 16 unrelated files (enum, factory, auth maps, session source, prompt hints, toolsets, cron, send-message tool, channel directory, CLI status, setup wizard, redaction, docs, tests). The plugin path (`plugin.yaml` + `adapter.py` + `register_platform()`) needs **zero core changes** — mirror that: a registry-driven channel layer, not a string-grepped switch over `platform`.

3. **Model presentation as data events, not code.** `stream_events.py` defines a tiny frozen-event vocabulary (`MessageChunk/MessageStop/Commentary/ToolCallChunk/ToolCallFinished`) that the agent emits and each channel *chooses how to render* (or "eat"). Adopt the same: a `ChannelEvent` union, with a base renderer and per-channel overrides (`render_message_event`, `format_tool_event`).

4. **Streaming degrades in three explicit tiers**: native-draft (`send_draft`) → progressive-edit (`send`+`edit_message`) → single-shot final send; skip streaming entirely on non-editable channels (`SUPPORTS_MESSAGE_EDITING`). Encode the transport selection ("auto"/"draft"/"edit"/"off") and the per-channel default (Telegram on, Discord/Slack off) as data.

5. **Thinking is filtered, not rendered.** Reasoning/`<think>` content is stripped by default (state machine in `stream_consumer._filter_and_accumulate`) and only surfaced via an opt-in `thinking_progress` scratch-text channel. Don't build a "thinking card" as a core capability — make it an opt-in, per-channel `thinking_progress` flag.

6. **Offers/options = a blocking primitive + a presentation override.** The `clarify`/`approval` primitives are module-level blocking queues (`_entries`/`_gateway_queues` keyed by `clarify_id`/`session_key`) with `resolve_*(id, choice)` as the **only** routing contract. Every channel implements the same `send_clarify(question, choices, clarify_id, …)` / `send_exec_approval(command, session_key, …)` override and routes taps back to the same resolver. The id convention (`ea:`/`sc:`/`cl:`/`clarify:`/`action_id`+`value`) is channel-local, but the *resolver call* is identical. Keep that split: **the offer shape (`question` + `choices[]` + `multi_select`; `command` + `description` + `pattern_keys`) is channel-agnostic; the button rendering is a per-channel `renderOffer` that returns an opaque `offerId` the channel echoes on selection.**

7. **Timeout/cancellation is fail-closed and centralized.** Both primitives block with a configurable timeout (approval 300s, clarify 3600s), poll in 1s slices to keep inactivity heartbeats alive, and resolve to `"deny"`/`""` on timeout/interrupt/`clear_session`. Stale taps render "expired" instead of falsely succeeding. Centralize this lifecycle in the abstraction so channels only provide `resolve(id, choice)` + an `onExpired` render.

8. **Status is a cheap, layered ladder**: one-shot typing (`send_typing`) → refreshed typing loop (`_keep_typing`, 2s/1.5s bounds) → text status phrase (`set_status_text`/`supports_status_text`) → lifecycle reactions (`on_processing_complete`). Each layer is optional and rides the layer below it, so a bare channel still gets "typing or nothing", and a rich channel gets a live "is running X…" line at zero extra API cost.

9. **Never leak host paths or raw args.** `send_voice`/`send_video`/`send_document` defaults emit "⚠️ Couldn't deliver…" rather than echoing filesystem paths (`base.py:4478-4488`), and tool progress is capped (default 40 chars) to avoid dumping args into chat. Build the same guardrails into the abstraction's default renderers.
