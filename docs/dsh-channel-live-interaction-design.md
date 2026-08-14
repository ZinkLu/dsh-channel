# dsh-channel 交互能力设计：流式 / 工具与思考 / offer 选项 / 处理状态

> 状态：设计草案（只设计，不实现）· 日期：2026-08-14
> 上游：`dsh-channel-design.md`（架构与契约、R1–R10 硬约束见其 §6/§7）
> 调研基线：dsh rc.6 已装类型（`node_modules/@deepseek-ai/*`）+ dsh master 源码
> （`packages/interaction/user-questions`）· hermes-agent main · openclaw main（均 2026-08-14 快照）

---

## 0. TL;DR

四个诉求在 dsh 里**都有原生"原料"**，缺的不是数据而是渠道层的**呈现层**。设计结论一句话：

> **把 channel 的职责从"终态投递"扩成"呈现器"**——它消费 session 事件流
> （`assistant/chunk` / `tool/call` / `tool/result` / `reasoning` 块 / `turn·step`），
> 按平台的**能力事实**降级成"进度草稿 / 状态行 / typing / 终态消息"四档呈现；
> 把现在只做二进制审批的 `approval-render` 扩成**统一交互提示**（approve/reject、
> 选项 A/B、多选、自由文本、plan-review 全走一条渲染 + 一条应答路由），同时接上
> dsh 的 `user-questions` seam。所有新行为都是纯函数 + 能力事实，不动 dsh 一行代码。

四点 → 现有状态 → 缺口，见下表；每点的 dsh seam、hermes/openclaw 可搬结论、落地位置分别在 §2/§3/§4。

| # | 诉求 | 现状（代码 + 设计文档） | 缺口 |
|---|---|---|---|
| 1 | 流式 | v1 明确"只做终态投递"（openclaw `off` 档）；`supportsEdit` 事实已声明但流式 v2 才用 | 无逐 token/分块呈现 |
| 2 | 工具过程/结果 + thinking | 只做"防泄漏"（`stripToolCallMarkup` 净化 `<tool_calls>` 文本）；不读 `tool/call`/`tool/result`；`reasoning` 块被直接丢弃 | 无工具进度行、无结果回显、无思考呈现 |
| 3 | offer 选项（approve/reject、A/B 选择） | `approval-render` 只有 approve/reject 二进制；`OutboundChoice` 类型已通用化但渲染只服务审批 | 无 N 选项/多选/自由文本/plan-review |
| 4 | 处理状态 | `turn/start`→typing（5s 节流）+ `turn/end` 状态行；`§5.4` 预留"progress 心跳"（默认关） | 无逐工具状态、无"正在思考"、无 step 粒度 |

---

## 1. "文档里有没有提到"——先回答这个问题

`dsh-channel-design.md` 已经**预埋了三处**，但没有展开：

- **流式**：§4.1 明确"v1 只做终态投递，`supportsEdit` 平台的草稿流式（openclaw `block` 模式 + 定时器门控）列入 v2"——方向对，但没设计 `off/partial/block/progress` 四档与 chunk 归并。
- **工具与 thinking**：`format.ts` 有 `stripToolCallMarkup`（防 `<tool_calls>` XML 泄漏），是"负面"处理；**没有**"正面"的 `tool/call`/`tool/result` 呈现，也没有 thinking 的呈现策略。
- **offer 选项**：§3.2 的 `OutboundChoice[]` 与 §4.4 `renderApproval` 已经**把选项从"审批专用"泛化成数组**（`choices: [{id,label}...]`），但只做了 approve/reject 两个；§4.4 的 answerer 纪律（只答自己 agent、超时 `next()`）是对的，可直接复用到 N 选项。
- **状态**：§5.3 `turn/end` 状态行 + §5.4 可选 progress 心跳（`digestLine` 从日志折叠）已有雏形。

**结论：设计文档提了方向，没给机制；四点里唯一"文档完全没提"的是 thinking 呈现与 N 选项 offer 的 seam 对接。**

---

## 2. dsh 原生 seam 全景（四点的"原料"）

> 全部来自已装 rc.6 类型 + master 源码，逐条带出处。

### 2.1 流式（原料：`assistant/chunk` / `llm/stream`）

- `SessionEventMap['assistant/chunk'] = { turn, step, chunk: StreamChunk }`（`dsh-session/lib/types/types.d.ts:264`）——token 级重放保真，**逐 delta 可读**。
- `StreamChunk`（`dsh-llm/lib/types/types.d.ts:267`）是判别联合：`block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish`。`block-end` 携带装配好的整块 `ContentBlock`。
- `llm/stream`（waterfall，`dsh-llm/lib/types/index.d.ts:43`）暴露 `AsyncIterable<StreamChunk>`——想抢在日志 commit 前拿到流也行，但渠道读 `session/event` 的 `assistant/chunk` 已够（post-commit、可重放，符合 R7）。

### 2.2 工具过程/结果 + thinking（原料：`tool/call` / `tool/result` / `reasoning` 块）

- `tool/call = { turn, step, callId, name, arguments }`（`types.d.ts:286`）——`arguments` 是模型原始 JSON 字符串。
- `tool/result = { turn, step, message: ToolResultMessage, error?, meta? }`（`types.d.ts:304`）——`error` 带 `{name, code}`；`meta` 是工具私有呈现载荷（JSON 可序列化）。
- thinking = `ContentBlock` 里的 `reasoning` 块（`type:'reasoning', text`，`dsh-llm/types.d.ts:44`），以及流式里的 `reasoning-delta`。**注意：`assistant/message` 的 `content` 会带 `reasoning` 块，当前 bridge 的 `assistantMessageText()` 只 `filter(type==='text')`，等于把思考丢掉了。**

### 2.3 offer 选项（原料：`approval/request` + **`user-questions`**）

两个 seam，一个是二进制，一个正是"选项 A/B"：

- **`approval/request`**（waterfall，`dsh-user-approval`）：`req={agent, toolName, callId?, reason?, signal?}`，outcome ∈ `allowed-once|rejected|cancelled|unavailable`。现有 bridge 已正确实现"只答自己 agent + 超时 `next()`"。
- **`ctx.userQuestions`**（`dsh-user-questions`，`packages/interaction/user-questions/src/index.ts`，master）——**这才是"选项 A/B/多选/自由文本/plan-review"的官方 seam**，文档见 `docs/subsystems/user-questions.zh.md`：
  - `AskUserQuestionItem = { id, question, detail?, header?, options?: AskUserQuestionOption[], multiSelect?, intent? }`
  - `AskUserQuestionOption = { label, description? }`
  - `intent = { kind:'plan-review', approve: string }`——plan 审批：`approve` 指名哪个 label 是"批准"，其余都算否决；**意图只改呈现，不改进协议**（回答仍是一串 label）。
  - `AskUserQuestionAnswerItem = { id, selected: string[], custom? }`——单选时 `custom` 覆盖 `selected`（自由文本）；多选时 `custom` 补充。
  - `UserQuestionProvider.ask(request): Promise<AskUserQuestionAnswer>`，`registerProvider(provider)` **一个 context 只有一个活跃 provider**（重复注册抛 `DUPLICATE_PROVIDER`）。
  - `ask()` 的 `agent` 校验：`CALLER_NOT_LIVE`（非当前存活实例）/ `DELEGATED_CALLER`（该 agent 被另一 agent 拥有）；无 provider → `NO_PROVIDER`。
  - 模型侧工具是 `@deepseek-ai/dsh-tool-ask-user`（agent 平面，经 preset 挂载）。

**关键设计张力**：`approval/request` 是 waterfall（能 `next()` 委托给 web UI）；`userQuestions` 是**单 provider 槽**（不能委托）。§4.3 展开怎么解。

### 2.4 处理状态（原料：`turn/step/tool` 事件 + `agent/status`）

- `turn/start`、`step/start`、`step/end`、`turn/end`（`types.d.ts`）——step = 一次模型请求 + 它调的工具；turn = 零或多 step。这正是"进行到第几步/第几轮"的粒度。
- `agent.status`（`idle|running`）与 `agent/status` 事件（`runtime-types.d.ts:45/169`）——typing 与"正在跑"的驱动源。
- `tool/call`/`tool/result` 自带 `turn/step` 编号——进度行可从日志折叠、天然可重放（R7）。

---

## 3. hermes 与 openclaw 的实现（可搬结论）

### 3.1 流式

- **openclaw 四模式**（`src/channels/streaming.ts`、`docs/concepts/streaming.md`、`docs/concepts/progress-drafts.md`）：`off | partial | block | progress`；能力事实 `capabilities.blockStreaming`。
  - **两层流式分离，从不下发 token delta**：`streaming.mode` 管的是**预览草稿**（编辑一条临时消息），`block.enabled` 管的是**分块终态投递**（block 按块发普通消息）——两者独立。dsh 的 `assistant/chunk` 是 token 级原料，但渠道只消费"已装配块/终态"这一层。
  - **progress 门控**（最值得抄）：`createChannelProgressDraftGate` 的 `DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS = 1500`——**定时器触发才建草稿消息，快回答根本不发草稿**，finalize 取消定时器；`noteWork()` 只计数 + 排定时器，不同步建草稿；`start()` 幂等防双建。
  - **草稿压缩**：`maxLines` 默认 8、`maxLineChars` 默认 120、`textChunkLimit` 默认 4000；每行带稳定 `id`/关联键以原地更新。
  - `partial`/`block` = 一条消息原地编辑（edit 能力）；`block` 按 `BlockStreamingCoalesceConfig {minChars, maxChars, idleMs}` 归并（默认 `{minChars:1500, idleMs:1000}`；preview chunk 默认 `200/800/paragraph`）。
  - 逐 channel 默认表：Telegram 默认 `progress`、Discord 默认 `off`、Mattermost/Teams 默认 `partial`。
- **hermes `send_draft`**（`gateway/platforms/base.py:3268`）：`send_draft(chat_id, draft_id, content)` 动画草稿；`streaming_overflow_limit()`（单消息可超 4096 时别切）；`should_finalize_as_new_message()`——**有些平台最终答复应"新发一条 + 删草稿"而非原地编辑**（Telegram 富文本编辑路径弱）。**三层 transport 降级**：native draft（Telegram `sendMessageDraft`）→ 渐进编辑 → 新发终态；无 edit 能力平台（QQ/WeChat）直接跳过流式。默认 `edit_interval=0.8s / buffer_threshold=24 / cursor=" ▉"`，**flood 门控**：连续 3 次 flood strike 关掉编辑、指数退避（§6 Q8）。

### 3.2 工具过程/结果 + thinking

- **hermes 结构化流事件**（`gateway/stream_events.py`）是**教科书答案**：
  - 事件只描述"发生了什么"，不规定"怎么发"：`MessageChunk{text}` / `MessageStop{final}` / `Commentary{text}` / `ToolCallChunk{tool_name,preview,args,index}` / `ToolCallFinished{tool_name,duration,ok,index}` / `LongToolHint` / `GatewayNotice{kind,text}`。
  - **adapter 逐事件决定呈现**：`format_tool_event` → `"🔎 tool_name: \"preview\""`（mode `all/new/verbose`，preview 上限默认 40）；平台渲染不了就 **`return None` 把 chrome 吃掉**（iMessage 无富文本）。
  - **呈现是 presentation-only，不进历史**：adapter 吃掉什么都不改变 agent 存的字节——这正是我们 R7 要的"日志=模型所见，呈现=平台交接"。
  - **thinking 被上游过滤**：`MessageChunk` 注释明说"Reasoning/think-block content is filtered upstream and never arrives as a MessageChunk"——hermes 默认**不把思考下放渠道**。
- **openclaw 工具显示**（`src/agents/tool-display.ts`、`tool-display-exec.ts`、`auto-reply/tool-meta.ts`）：`resolveToolDisplay({name,args,detailMode})` → `{emoji,title,label,detail}`；`formatToolSummary` → `"{emoji} {label}: {detail}"`，shell 族（`bash/exec/shell` 或带 `command` 参数的工具）→ `"{emoji} {command}"`（命令整行）；内置脱敏 `redactToolDetail`、`MAX_DETAIL_ENTRIES=8`。**双轴详情策略**：`detailMode: explain|raw`（语义摘要 vs 原始参数）× `commandText: status|raw`（命令文本）——`explain` 有富语义摘要器（git/grep/find/ls/npm…），`formatToolAggregate` 把路径按目录 `brace-collapse` 成 `dir/{a,b,c}`。
- **openclaw thinking 呈现**（`src/auto-reply/thinking.ts`、`src/agents/thinking-runtime.ts`、`src/shared/text/reasoning-tags.ts`）：`ReasoningLevel = off | on | stream`（`normalizeReasoningLevel` 把 `stream/streaming/draft/live→stream`、`show/visible/on→on`、`hide/hidden/off→off`）；`isThinkingLikeBlock` 识别 `thinking`/`redacted_thinking` 块；`stripReasoningTagsFromText` 从**可见文本**里剥掉 `<reasoning>/<thinking>` 标签与 "Reasoning:"/"Thinking" 前导行（`strict|preserve`、`all|leading`，保留代码字面量）——**思考是"等级"而非"布尔"：off=不下放、on=只下放最终思考、stream=逐 delta 下放**。比 hermes 的"上游一律过滤"多给了 `on` 一档，且 typing 档 `thinking` 直接绑定 reasoning delta。

### 3.3 offer 选项

- **hermes 三个交互原语共用一个回调路由**（`tools/clarify_gateway.py` + `base.py`）：
  - `clarify`：`_ClarifyEntry{clarify_id, question, choices, multi_select, awaiting_text}`；`send_clarify(chat_id, question, choices, clarify_id)` 两档渲染——按钮（编号 1..n + "Other"）+ 文本回退（编号列表，用户回 "2" 或选项文本）；`resolve_gateway_clarify(id, response)` 收答案；`mark_awaiting_text(id)` 让 "Other" 进入自由文本捕获。**clarify 约束**（`tools/clarify_tool.py:236`）：`question` 必填 + `choices` 最多 4 + `multi_select`；**首个 choice 自动标 "(Recommended)"**；第 5 个 "Other" 自动追加；输出 JSON `{question, choices_offered, user_response}`。
  - `send_slash_confirm`：三个固定选项 Approve Once / Always / Cancel，`_resolve_slash_confirm(id, "once"|"always"|"cancel")`。
  - `approval`：`tools.approval` 的 choice 是 **`once|session|always|deny` 四值**（timeout 300s），`approval_data={command, description, pattern_keys}`。
  - 统一 `prompt_response{prompt_id, option_id, label}` 入站路由到三个 resolver，**在正常 dispatch 之前拦截**。**回调 id 是 channel-local 的**（Telegram `ea:{choice}:{id}` / `sc:` / `cl:{id}:{idx}`+`cl:{id}:other`；Discord `clarify:{id}:{idx}`；Slack `action_id`+value；Matrix 表情反应 ✅🌀♾️❎）——文档里的 `appr:` 前缀已过时，但 **resolver 调用是全渠道同一份**。
- **openclaw**：`ChannelApprovalCapability`（approve 动作、`approvalKind: exec|plugin`）+ `capabilities.polls` + `PollInput{question, options[], maxSelections, durationSeconds}`（`src/polls.ts`）。
- **openclaw `ask_user` 工具**（`src/agents/tools/ask-user-tool.ts`）——**与 dsh `user-questions` 一一对应**：阻塞式工具，`{questions: [{id(snake_case), header(≤12), question, options[{label(≤64),description}] (2–4 个), multiSelect?}], timeoutSeconds(默认 900, min 30, max 3600)}`，始终 `isOther:true`；只有**单个非多选、非 secret 问题**才渲染按钮，多选/多题降级文本；答案经 `question.resolve` 路由回阻塞的工具调用。这印证了 §2.3 的结论：dsh 的 `user-questions` 就是"选项 A/B"的正确 seam，不必自造。
- **openclaw 的"可移植载荷 → 能力适配 → 文本降级"链**（`src/interactive/payload.ts` + `src/channels/plugins/outbound/presentation-limits.ts`）——这是 offer/选项的**核心抽象，最值得抄**：
  - **载荷是 channel-agnostic 的**：`MessagePresentationAction = command | callback | model-picker | approval{approvalId,approvalKind,decision:allow-once|allow-always|deny} | question{questionId,optionValue} | url | web-app`。agent 侧工具**只产出这个可移植形状**，不含任何平台回调 id。
  - **适配是一份能力事实的纯函数**：`ChannelPresentationCapabilities {supported, buttons?, selects?, limits.actions.{maxActions,maxActionsPerRow,maxRows,maxLabelLength,maxValueBytes,supportsStyles,supportsDisabled}, limits.selects.{maxOptions,…}, limits.text.{maxLength,encoding,markdownDialect,supportsEdit}}` → `adaptMessagePresentationForChannel` 把不支持的块降级成 `context`/`text`，`applyPresentationActionLimits` 只留放得下的按钮子集。
  - **文本降级绝不泄漏传输数据**：`renderMessagePresentationFallbackText` 把按钮渲染成 `- <label>` 列表，`approval`/`question` 动作**只出 label、不带 callback_data/optionValue**。
- **openclaw 审批**（`src/infra/approval-presentation.ts`、`exec-approvals-policy.ts`、`exec-approval-command-display.ts`）：`ApprovalPresentation` kinds `exec|plugin|system-agent`，`allowedDecisions` 恒含 `deny`；`DEFAULT_EXEC_APPROVAL_DECISIONS = ["allow-once","allow-always","deny"]`，`ask==="always"` 时塌缩成 `["allow-once","deny"]`；命令文本做**反混淆净化**（不可见字符转义、密钥脱敏、`EXEC_APPROVAL_MAX_INPUT=256KB / MAX_OUTPUT=16KB`）。
- **共同教训 1（按钮是快捷方式，文本永远是降级路径）**：编号/选项文本/自由文本都要能答，超时不清空就 `next()`/`NO_PROVIDER` 兜底。
- **共同教训 2（approve 常是 N 值而非二值）**：openclaw `decision: allow-once|allow-always|deny`、hermes slash-confirm `once|always|cancel`、hermes approval `once|session|always|deny`（**四值**）——"一次/本次会话/永远/拒绝"。dsh 的 `approval/request` 只有 `allowed-once|rejected`（无 `always`/`session`），"记住本次会话的 always"需渠道在 store 里自记（见 §6 Q6），v1 先不做。
- **共同教训 3（fail-closed 超时是集中化的）**：hermes 阻塞原语带配置超时（**approval 300s、clarify 3600s**），1s 切片轮询以保活心跳，超时/interrupt/`clear_session` 一律 `deny`/空串；**迟到的按钮点击渲染成"⌛ 已过期"而不是假装成功**。resolve 回调签名统一为 `resolve_*(id, choice)`，按钮渲染是 channel-local、回调 id 是 channel-local，但 **resolver 调用是全渠道同一份**——这正是 §4.3 的"统一 PendingPrompt 注册表"要抄的形状。

### 3.4 处理状态

- **openclaw progress-drafts**：一条可编辑的 "Working..." 消息 + 滚动进度行（`🔎 Web Search: ...`、`🛠️ Bash: run tests`），有 status headline、label、工具 emoji；`AgentPlanStep{step,status: pending|in_progress|completed}`。纯文本回答不建草稿（只有真实工作行才出现）。
- **openclaw typing 档**（`src/auto-reply/reply/typing-mode.ts` / `typing.ts`）：`TypingMode = never | instant | thinking | message`，`DEFAULT_TYPING_INTERVAL_SECONDS = 6`、`DEFAULT_TYPING_TTL_MS = 2min`——`thinking` 档在**reasoning delta 出现时**才打 typing，`message` 档在"有可渲染文本后的工具调用"时打。比布尔 `supportsTyping` 多了一维：**typing 的触发信号可以区分"在思考"与"在跑工具"**。
- **hermes 状态是"廉价的分层梯"**（每层可选、骑在下一层上，裸平台至少还有 typing）：
  1. `send_typing`（一次性，no-op 默认）→
  2. `_keep_typing`（**2s 刷新循环**，Telegram/Discord typing ~5s 过期；单次调用 1.5s 上限）→
  3. `supports_status_text` + `set_status_text`（**Slack 把"is running scripts/run_tests.sh…"喂给文本状态行，`build_status_phrase(tool_name, args, max_len=49)`，零额外 API 成本**，骑在 typing 刷新上）→
  4. 生命周期 reaction（`on_processing_start/complete` 换 ✅/❌）。
  - **审批等待期间暂停 typing**（`pause_typing_for_chat`）：Slack 的助手状态会禁掉输入框，用户必须能打出 `/approve`。
- **hermes 工具进度 mode**：`off | all | new | verbose | log`（比 openclaw 的 explain/raw 更细），`TurnRunner.progress_callback` 是单点（emoji+verb+preview，preview 上限 40）。

---

## 4. 设计：按公共层 + provider 两层落地（只设计，不实现）

> 原则不变：能力差异走"能力事实 + 降级"（R6）；呈现层是纯函数（kit）；日志=模型所见、呈现=平台交接（R7）；waterfall 只答自己、不夺权（R8）。

### 4.1 `dsh-channel`：新增能力事实（`Channel` 抽象类）

在现有六个 getter 后追加，全部保守默认（照抄 `FileSystem.sandboxMode` 写法）：

```ts
// ---- 呈现能力事实：基类保守默认 ----
/** 流式档位。'off'=只终态；'block'=分块原地编辑草稿；'progress'=一条可编辑状态草稿+终态。
 *  需要 supportsEdit 才能是非 off；无编辑能力的平台永远 off。 */
get streamingMode(): 'off' | 'block' | 'progress' { return 'off' }
/** 是否以文本呈现"正在做 X…"状态行（hermes supports_status_text，Slack 类）。
 *  textless 平台（Telegram/Discord）保持 false。 */
get supportsStatusText(): boolean { return false }
/** 是否向渠道下放 reasoning/thinking 内容。默认 false（不泄漏思考链）。
 *  可升级为 thinkingLevel: 'off'|'on'|'stream'（openclaw ReasoningLevel，见 §6 Q2）。 */
get supportsThinking(): boolean { return false }
/** 呈现上限（openclaw ChannelPresentationCapabilities.limits 的缩小版）：
 *  maxOptions=单消息按钮数、maxLabelLength=按钮文字上限、maxValueBytes=回调数据上限。
 *  均 undefined=无已知上限。渲染器据此把放不下的选项降级成编号文本。 */
get presentationLimits(): { maxOptions?: number; maxLabelLength?: number; maxValueBytes?: number } { return {} }
/** 是否支持多选选项。false 时多选降级为"逐条单选 + 文本补充"。 */
get supportsMultiSelect(): boolean { return false }
```

- `OutboundMessage` 增加一个可选字段承载"呈现意图"，供策略插件与渲染器共用：

```ts
export interface OutboundMessage {
  // …现有字段不变…
  /** 呈现意图：终态消息 / 新建草稿 / 编辑已有草稿 / 状态行。策略插件据此决定是否拦截/改写。 */
  readonly presentation?: 'final' | 'draft-new' | 'draft-edit' | 'status-line'
  /** draft-edit 时指向的草稿平台消息 id。 */
  readonly editTarget?: string
}
```

- 新增事件（可选、观察性，供策略插件审计流式/工具流量，不承载路由决定）：

```ts
// @mode emit —— provider 已把某条呈现帧推给平台（审计/统计用；不用于决策）
'channel/present'(presentation: PresentationFrame): void
```

### 4.2 `dsh-channel-kit`：两个新模块 + 一个重命名

**A. `tool-display.ts`（新，纯函数）**——把 `tool/call`/`tool/result` 变成一行"人话"：

```ts
export function resolveToolDisplay(name: string, argsJson?: string): { emoji: string; label: string; detail?: string }
export function formatToolLine(display, opts: { detailMode: 'compact' | 'verbose'; maxDetailChars: number }): string
export function formatToolResultLine(tool: string, opts: { ok: boolean; durationMs?: number; summary?: string }): string
```

- 对齐 openclaw：内置小配置表（bash/fs/web/subagent… 的 emoji + label），shell 族（`bash/exec/shell` 或参数含 `command`）→ 命令整行；`maxDetailChars` 默认 40（hermes preview 上限）；**双轴详情**：`detailMode: 'explain'|'raw'` × `commandText: 'status'|'raw'`（openclaw 结论）；路径按目录 brace-collapse；**永远走脱敏**（长度截断 + 路径 `~` 缩写）。
- 在 `format.ts` 里加一个 `stripReasoningTags(text, opts)`（openclaw `stripReasoningTagsFromText` 的同款）：从**可见文本**剥掉 `<reasoning>/<thinking>` 标签块与 "Reasoning:"/"Thinking" 前导行，`strict|preserve` 保护代码字面量——与现有 `stripToolCallMarkup` 一起构成"绝不把模型内部字节泄漏给用户"的最后一道闸。

**B. `stream.ts`（新，纯函数 reducer）**——把 session 事件序列折叠成"呈现帧"，定时器在外面（照 `merge.ts` 的做法）：

```ts
export type StreamFrame =
  | { kind: 'final'; text: string }                    // 终态（assistant/message）
  | { kind: 'draft'; text: string; finalize: boolean } // 建/改草稿；finalize=true 时转终态
  | { kind: 'status-line'; text: string }              // 状态行（工具/step/思考）
  | { kind: 'noop' }
export function streamReduce(state: StreamState, input: StreamInput, caps: StreamCaps): { state; frames: StreamFrame[] }
// StreamInput 由消费方把 session 事件投影成：turn/start、step/start、tool/call、tool/result、
// reasoning-delta、text-delta、assistant/message、turn/end
// StreamCaps = { streamingMode, supportsEdit, supportsStatusText, supportsThinking, now }
```

- **门控**（openclaw 结论）：`progress` 模式首次 `tool/call` 或超阈值文本量才产出 `draft`，且带 `armTimer`（1500ms 初始延迟）——快回答零噪音；`block` 模式按 `minChars + idleMs` 归并 token delta（openclaw `blockStreamingCoalesceDefaults`）；`off` 模式只吐 `final`。

**C. `approval-render.ts` → `prompt-render.ts`（重命名 + 泛化，向后兼容保留旧导出）**：

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
// PromptAnswer = { selected: string[]; custom?: string }   —— 与 AskUserQuestionAnswerItem 同构
```

- `renderApproval` / `parseApprovalReply` 变成 `renderPrompt` 的 `options = ['批准','拒绝']` 特例，**旧 API 保留**（现有测试/消费方不破）。
- **渲染约定**（hermes clarify 教训）：`options` 超 `presentationLimits.maxOptions` 时降级文本并提示编号；`recommendedIndex` 指定的首选项标 "(Recommended)"；`allowFreeText` 时按钮/文本都追加 "Other/自由文本" 入口；标签超 `maxLabelLength` 截断加 `…`；`maxValueBytes`（如 Telegram 64）约束 `choice.id`。

### 4.3 统一交互提示应答器（offer 选项的核心）

**目标**：approve/reject、选项 A/B、多选、自由文本、plan-review **全走一套渲染 + 一套应答路由**，且严格遵守 R8（不抢 web UI 的活）。

```
                       ┌──────────────────────────────────────────────┐
  approval/request ──▶ │  统一 PendingPrompt 注册表（num → entry）        │
  (waterfall, next())  │    entry = { num, source, agentId, chatKey,    │
                       │              options[], multiSelect, expiresAt }│
  userQuestions.ask ──▶ │   renderPrompt → 按钮/编号文本 → 发出去          │
  (single provider)    │   回调/文本 → parsePromptReply → resolve → 返回  │
                       └──────────────────────────────────────────────┘
```

- **核心不变式（openclaw 结论 #6 的同构）**：载荷是 **channel-agnostic 的**（`question + options[] + multiSelect + intent`，与平台回调 id 无关）；适配是**一份能力事实的纯函数**（`renderPrompt` 读 `supportsChoices/supportsMultiSelect/presentationLimits`，一个函数出按钮/编号文本/多选降级三种形态，不 per-channel 分支）；**文本降级绝不泄漏传输数据**（编号回退只出"回复 1/2/…"或选项文本，不带 callback_data/optionValue）。
- **approval 侧（已实现，保持）**：`onApprovalRequest` 的"`req.agent.id` 非本渠道路由 → `next()`""超时 → `next()`"不变，只是渲染调用从 `renderApproval` 换成 `renderPrompt(..., options:['批准','拒绝'])`。
- **user-questions 侧（新增）**：渠道实现 `UserQuestionProvider`，`ask(request)` 里：
  1. 每个 `AskUserQuestionItem` → `renderPrompt({question, detail, options: options.map(o=>o.label), multiSelect, allowFreeText:true, num})`（`intent: 'plan-review'` 时把 `approve` label 标成"✅ 批准"）。
  2. 用户应答（按钮/文本）→ `parsePromptReply` → 组装 `AskUserQuestionAnswerItem[]`（`selected`/`custom`）返回。
  3. `request.signal` abort → 清 pending，抛 `UserQuestionError('ASK_ABORTED')`（或返回空）。

- **单 provider 槽的解法（这是本设计的唯一硬风险，见 §6 Q1）**：`userQuestions` 一个 context 只有一个 provider，且 `approval` 是 waterfall 能 `next()` 而它不能。**推荐**：在 `setup(agentCtx)`（agent 作用域）里注册渠道自己的 provider——让渠道 agent 的 `ctx.userQuestions` 解析到渠道 provider，web 会话的 agent 仍走根层 web provider，互不打架（与渠道现在 `setup` 里注入 `promptHint` 的 systemPrompt 段是同一作用域手法）。**若验证发现 `userQuestions` 无法按 agent 作用域隔离**，退路是：渠道注册一个"路由 provider"，`ask(request)` 里判 `request.agent` 是否本渠道路由的会话——是则渲染应答，否则 `throw NO_PROVIDER`（等价于"不接这单"，由上层约定 web 与渠道分治）。

### 4.4 `dsh-channel-telegram`：编排（stream consumer）

把 `onSessionEvent` 从"三个 if"扩成"投喂 `streamReduce` 的投影 + 帧执行器"：

```
ctx.on('session/event') → project(event) → streamReduce(state, input, caps)
  frames:
    draft          → supportsEdit ? (首次 sendMessage 建草稿并记 id / editMessageText 改) : 降级为 final
    status-line    → supportsStatusText ? 发状态行 : (progress 草稿追加一行 / 忽略)
    final          → 停掉草稿 → 终态 send（现有 sendOutbound 全链路 + ledger）
    noop           → 忽略
turn/start → sendTyping（现有 5s 节流）
turn/end(non-completed) → 状态行（现有）+ 草稿 settle/删除
```

- **thinking**：`reasoning` 块/`reasoning-delta` 仅在 `supportsThinking` 时产出状态行（折叠成"🤔 …"），否则丢弃（保持现有 `assistantMessageText` 只取 text 的净化为兜底）。
- **工具**：`tool/call` → `resolveToolDisplay` + `formatToolLine` 产出 `status-line`；`tool/result` → `formatToolResultLine`（`✅/⛔ · 时长`）settle 该行。
- **Telegram 能力事实**：`streamingMode = 'progress'`（Telegram 默认 progress，对齐 openclaw）、`supportsEdit = true`（已声明）、`supportsStatusText = false`、`supportsThinking = false`（默认关）、`presentationLimits = { maxValueBytes: 64 }`（inline keyboard `callback_data` ≤64 字节）、`supportsMultiSelect = false`（Telegram 无原生多选，降级为逐条 + 文本）。

### 4.5 store：草稿 ledger（极小扩展）

草稿消息有一个平台 id 需要跨重启回收。在 `ChannelStore` 加一个并行表（对齐 delivery ledger 语义）：

```ts
setDraft(chatKey: string, draftKey: string, platformMessageId: string): void
draftMessageId(chatKey: string, draftKey: string): string | undefined
clearDraft(chatKey: string, draftKey: string): void
```

- 语义照抄 delivery ledger：草稿是"可能已发出但未 settle"的呈现态；重启后 `sweepRecoverable` 一样处理——孤儿草稿要么 `finalize` 要么删除（带"恢复"标记）。ledger 故障绝不阻塞真实发送。

---

## 5. 能力矩阵（四点 × 来源 × 能力事实 × kit × 降级）

| 诉求 | dsh 原料 | 能力事实 | kit 函数 | 降级路径 |
|---|---|---|---|---|
| 流式 | `assistant/chunk` / `llm/stream` | `streamingMode` + `supportsEdit` | `streamReduce` | `off` → 只 `final`；`block/progress` 无 edit → 自动 `off` |
| 工具过程/结果 | `tool/call` / `tool/result` | `supportsStatusText` | `tool-display` | 无状态行能力 → 吃掉 chrome（hermes 教训） |
| thinking | `reasoning` 块 / `reasoning-delta` | `supportsThinking` | `stripReasoningTags`（净化）+ `streamReduce`（status-line） | 默认丢弃 + 可见文本剥标签（不泄漏思考链） |
| offer 选项 | `approval/request` + `userQuestions` | `supportsChoices` + `supportsMultiSelect` + `presentationLimits` | `renderPrompt` / `parsePromptReply` | 无按钮 → 编号文本；多选 → 逐条单选 + 文本；标签过长 → 截断 |
| 处理状态 | `turn·step` + `agent/status` | `supportsTyping` / `supportsStatusText` / `supportsEdit` | `streamReduce`（status-line/draft） | 纯文本平台 → 一次性状态行，不建草稿 |

---

## 6. 开放问题 / 待核实（诚实标注）

1. **`userQuestions` 的 provider 作用域**（§4.3 的唯一硬风险）：`dsh-user-questions` 与 `dsh-tool-ask-user` **不在本机 node_modules**（只核对了 master 源码）。需 spike 确认：`setup(agentCtx)` 里 `agentCtx.userQuestions.registerProvider(...)` 是**按 agent 作用域隔离**（推荐路径成立）还是**全局单槽**（需退路方案）。这决定 offer 选项的接线方式。
2. **thinking 默认关，但可以是"等级"而非"布尔"**：hermes 上游过滤思考、openclaw `ReasoningLevel = off|on|stream`（默认 `off`）。设计草案把 `supportsThinking` 定为布尔（保守、R6 最小），但 openclaw 的 `off/on/stream` 三档更贴合需求（`on`=只给最终思考、`stream`=逐 delta）。是否升级成 `thinkingLevel: 'off'|'on'|'stream'` 能力事实？默认 `off`、config 可开。
3. **`assistant/chunk` 的噪音**：token 级事件量大；progress 草稿必须靠定时器门控（openclaw 1500ms）+ 归并，否则刷屏。`block` 的 `minChars/idleMs` 归并参数要实测。
4. **最终答复"新发 + 删草稿" vs "原地编辑"**（hermes `should_finalize_as_new_message`）：Telegram `editMessageText` 对富文本能力弱，最终答复建议"停草稿 + 正常 `send` 终态"（现有 `sendOutbound` 已具备），草稿删除 best-effort。
5. **A5 验证**：下一个平台（Discord，有 `edit` + `threads` + markdown 档）做能力对照——Discord 默认 `streamingMode='off'`、`supportsStatusText=true`（能改消息文本呈现状态），用来验证"能力事实 + 降级"没分叉；此后每加一个平台都是 A5 的一次复现。
6. **"always/session" 多值审批**（openclaw `allow-always`、hermes approval `once|session|always|deny`）：dsh `approval/request` 无 `always`/`session` 结局，"记住本次会话某工具的 always"需渠道在 store 自记并在 answerer 里短路（不回 `approval/request`）。v1 先不做，接口预留即可。
7. **审批/提问等待期间暂停 typing**（hermes `pause_typing_for_chat`）：有的平台打字指示会禁掉输入框，用户必须还能回复 `/approve` 或选项。接入 `user-questions`/审批时要在 answerer 的等待分支里 `stop_typing`/`resume_typing`。
8. **流式编辑的 flood 门控**（hermes）：连续 3 次 flood strike 关掉编辑、指数退避、per-run 降级到终态投递；Telegram typing 短暂失败有 30s cooldown。这些是运营性护栏，v1 至少要"编辑失败自动降级终态"，完整 strike 计数可后补。

---

## 7. 完整接口清单（interface spec）

> 把 §4 散落的接口收敛成**每个类型名都有定义**的自洽草案。只定签名与语义，不写实现体。
> 归属分两层（`dsh-channel`/`dsh-channel-kit` 公共层 + `dsh-channel-telegram` provider）；标 `[新]` 为本设计新增、`[改]` 为对现有类型的扩展、`[现有]` 为直接复用不动。
> 关键裁定：**可移植载荷（`ChannelPrompt`）不进契约包的 `OutboundMessage`**——它只在 kit 的
> `renderPrompt` 输入侧出现；适配后的结果（`text` + `choices`）才是走 `channel/deliver` 的 `OutboundMessage`，
> 所以策略插件仍只需看 `channel/deliver`/`channel/message` 就能完整审计"问"与"答"，无需新词汇。

### 7.1 `dsh-channel`（契约包）

```ts
// ---- [改] Channel 抽象类新增 getter（§4.1）----
export interface PresentationLimits {
  /** 单条消息最多按钮数；undefined=无已知上限。超限降级编号文本。 */
  readonly maxOptions?: number
  /** 按钮文字上限（字符）；超限截断加 `…`。 */
  readonly maxLabelLength?: number
  /** 回调数据（callback_data/value）上限（字节）；如 Telegram=64。超限必须走文本降级。 */
  readonly maxValueBytes?: number
}

export abstract class Channel {
  // …现有 id / maxMessageChars / formatTier / supportsChoices / supportsEdit /
  //   supportsTyping / chatTypes / send / sendTyping 不变…
  get streamingMode(): 'off' | 'block' | 'progress' { return 'off' }
  get supportsStatusText(): boolean { return false }
  get supportsThinking(): boolean { return false }
  get presentationLimits(): PresentationLimits { return {} }
  get supportsMultiSelect(): boolean { return false }
}

// ---- [改] OutboundMessage 扩展：呈现意图（§4.1）----
export type PresentationIntent = 'final' | 'draft-new' | 'draft-edit' | 'status-line'
export interface OutboundMessage {
  // …现有 channel/chatKey/markdown/choices/deliveryKey/origin 不变…
  readonly presentation?: PresentationIntent
  /** draft-edit 时指向的草稿平台消息 id。 */
  readonly editTarget?: string
}

// ---- [新] 呈现帧：channel/present 事件的 payload，也是策略插件审计流式/工具流量的统一词汇 ----
// 帧与 OutboundMessage 的区别：OutboundMessage 是"投递请求"（走 deliver waterfall），
// PresentationFrame 是"已发生的呈现事实"（emit，观察性，不承载路由/拦截决定）。
export type PresentationFrame =
  | { readonly kind: 'final'; readonly channel: string; readonly chatKey: string; readonly deliveryKey: string; readonly text: string }
  | { readonly kind: 'draft-new'; readonly channel: string; readonly chatKey: string; readonly draftKey: string; readonly text: string }
  | { readonly kind: 'draft-edit'; readonly channel: string; readonly chatKey: string; readonly draftKey: string; readonly editTarget: string; readonly text: string }
  | { readonly kind: 'draft-finalize'; readonly channel: string; readonly chatKey: string; readonly draftKey: string }
  | { readonly kind: 'draft-discard'; readonly channel: string; readonly chatKey: string; readonly draftKey: string }
  | { readonly kind: 'status-line'; readonly channel: string; readonly chatKey: string; readonly text: string }

declare module '@deepseek-ai/cordis' {
  interface Events {
    // @mode emit —— provider 已把某条呈现帧推给平台（审计/统计用；不用于决策）
    'channel/present'(frame: PresentationFrame): void
  }
}
```

### 7.2 `dsh-channel-kit`（纯函数层，全部 `[新]`/`[改]`）

```ts
// ---- A. tool-display.ts ----
export interface ToolDisplay { readonly emoji: string; readonly label: string; readonly detail?: string }
export function resolveToolDisplay(name: string, argsJson?: string): ToolDisplay
export interface ToolLineOptions {
  detailMode: 'compact' | 'verbose'            // explain/raw 的简化两档（见 §3.2 双轴）
  commandText?: 'status' | 'raw'               // shell 命令文本是否整行输出
  maxDetailChars?: number                      // 默认 40
}
export function formatToolLine(display: ToolDisplay, opts: ToolLineOptions): string
export function formatToolResultLine(name: string, opts: { ok: boolean; durationMs?: number; summary?: string }): string

// ---- [改] format.ts 增 ----
export function stripReasoningTags(text: string, opts?: { mode?: 'strict' | 'preserve'; scope?: 'all' | 'leading' }): string

// ---- B. stream.ts ----
export interface StreamCaps {
  streamingMode: 'off' | 'block' | 'progress'
  supportsEdit: boolean
  supportsStatusText: boolean
  supportsThinking: boolean
}
/** 消费方把 session 事件投影成这个判别联合，再喂给 reducer（不直接喂 SessionEvent，保持纯）。 */
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
  | { readonly kind: 'tick' }                    // 定时器边沿（门控 1500ms，照 merge.ts 的 tick）
/** reducer 内部状态（不透明给消费方；测试可断言的投影）。 */
export interface StreamState {
  readonly mode: 'off' | 'block' | 'progress'
  readonly bufferedText: string                  // 已装配但未终态的文本
  readonly draftState: 'none' | 'created' | 'finalized'
  readonly openToolLines: ReadonlyMap<string, string>   // callId → 状态行（等 tool/result settle）
  readonly progressStarted: boolean              // 门控是否已触发
}
export type StreamFrame =
  | { readonly kind: 'noop' }
  | { readonly kind: 'final'; readonly text: string }
  | { readonly kind: 'draft-new'; readonly text: string }
  | { readonly kind: 'draft-edit'; readonly text: string }
  | { readonly kind: 'draft-finalize' }
  | { readonly kind: 'draft-discard' }
  | { readonly kind: 'status-line'; readonly text: string }
  | { readonly kind: 'arm-timer'; readonly at: number }   // 请求外部在 at 时刻喂一次 tick
export function streamReduce(state: StreamState, input: StreamInput, caps: StreamCaps, now: number): { state: StreamState; frames: StreamFrame[] }

// ---- C. prompt-render.ts（由 approval-render.ts 泛化，旧导出保留）----
export interface PendingPrompt {
  readonly num: number                      // 会话内递增编号（#n 应答键）
  readonly requestId: string                // 稳定 id（日志/审计）
  readonly question: string
  readonly detail?: string
  readonly options: readonly string[]       // 选项 label（channel-agnostic，与回调 id 无关）
  readonly multiSelect: boolean
  readonly allowFreeText: boolean
  readonly recommendedIndex?: number        // hermes "(Recommended)" 标记
  readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
  readonly expiresAt: number
  /** 桥接层填：用户应答到达时回填。单选时 custom 覆盖 selected；多选时 custom 补充。 */
  resolve(selected: readonly string[], custom?: string): void
}
export type PromptAnswer = { readonly selected: string[]; readonly custom?: string }
export interface PromptOptions {
  supportsChoices: boolean
  supportsMultiSelect: boolean
  presentationLimits?: PresentationLimits   // 从 Channel.presentationLimits 透传
}
export type RenderedPrompt =
  | { readonly kind: 'choices'; readonly text: string; readonly choices: OutboundChoice[] }
  | { readonly kind: 'text'; readonly text: string }
/** 选项 id 编码约定（回调侧，只在 buttons 路径用；文本降级绝不携带它）：
 *  按钮 `prompt:<num>:<idx>`，自由文本入口 `prompt:<num>:other`。受 maxValueBytes 约束（num 短整型）。 */
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
// 向后兼容：renderApproval / parseApprovalReply 是 renderPrompt/parsePromptReply 的 options=['批准','拒绝'] 特例。
```

### 7.3 `dsh-channel-telegram`（桥接层，`[新]`）

```ts
// ---- 统一交互提示应答器：一个 PromptBroker 服务两个 dsh seam（§4.3）----
interface PromptBroker {
  /** approval/request 侧：waterfall answerer（已实现，渲染换 renderPrompt）。 */
  onApprovalRequest(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>
  /** user-questions 侧：UserQuestionProvider（ask 投影到 renderPrompt + parsePromptReply）。 */
  askUserQuestions(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
  /** 入站应答统一入口：文本/回调先 parsePromptReply，再 resolve 对应 PendingPrompt。 */
  resolveInboundReply(input: { text?: string; choiceId?: string }): boolean
}

// ---- draft ledger 键约定（§4.5）----
// draftKey = `draft:<sessionId>:<turn>`；同一 turn 内 progress 草稿复用同键，turn 结束 finalize/discard。
// store 增：setDraft(chatKey, draftKey, platformMessageId) / draftMessageId(chatKey, draftKey) / clearDraft(chatKey, draftKey)
```

### 7.4 尚未定义 / 需 spike 后才定（诚实标注，与 §6 一一对应）

| 缺口 | 为什么现在不定 | 依赖 |
|---|---|---|
| `ChannelPromptProvider` 的注册位置（agent 作用域 vs 全局路由 provider） | §6 Q1 单 provider 槽作用域未验证 | `dsh-user-questions` spike |
| `thinkingLevel: 'off'|'on'|'stream'` 是否替换布尔 `supportsThinking` | §6 Q2 | 是否要 `on` 档 |
| 回调 id 前缀是 `prompt:` 还是沿用现有 `appr:` | 我们的自有约定，与 dsh 无关，实现时定即可 | 无 |

---

## 附：参考索引

- dsh seam 源码：`dsh-session/lib/types/types.d.ts`（`assistant/chunk`/`tool/call`/`tool/result`/`turn·step`）· `dsh-llm/lib/types/types.d.ts`（`StreamChunk`/`ContentBlock`/`reasoning`）· `dsh-user-approval/lib/types` · [dsh `user-questions`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/user-questions/src/index.ts) 与 [user-questions 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/user-questions.zh.md)
- hermes：[`gateway/platforms/base.py`](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/base.py)（`send_draft`/`send_clarify`/`send_slash_confirm`/`send_typing`/`set_status_text`）· [`gateway/stream_events.py`](https://github.com/NousResearch/hermes-agent/blob/main/gateway/stream_events.py) · [`tools/clarify_gateway.py`](https://github.com/NousResearch/hermes-agent/blob/main/tools/clarify_gateway.py) · [`tests/gateway/test_discord_clarify_buttons.py`](https://github.com/NousResearch/hermes-agent/blob/main/tests/gateway/test_discord_clarify_buttons.py)
- openclaw：[`src/channels/streaming.ts`](https://github.com/openclaw/openclaw/blob/main/src/channels/streaming.ts) · [`src/agents/tool-display.ts`](https://github.com/openclaw/openclaw/blob/main/src/agents/tool-display.ts) · [`src/channels/plugins/types.core.ts`](https://github.com/openclaw/openclaw/blob/main/src/channels/plugins/types.core.ts)（`ChannelCapabilities`）· [`src/polls.ts`](https://github.com/openclaw/openclaw/blob/main/src/polls.ts) · [`docs/concepts/progress-drafts.md`](https://github.com/openclaw/openclaw/blob/main/docs/concepts/progress-drafts.md)
