# dsh-channel 设计对齐核对（对照 rc.6 源码）

> 核对对象：`dsh-channel-design.md` §1.1/§1.2 与 `dsh-channel-handoff.md` R1–R10 里
> **对 dsh 核心 API 的每一条具体断言**。
> 核对基线：`@deepseek-ai/*@0.1.0-rc.6` 编译类型（`node_modules/@deepseek-ai/*/lib/types/*.d.ts`）
> + 官方参考文档（master）。
> 结论标记：✅ 逐字对齐 / ⚠️ 对齐但需补精 / ❌ 与 rc.6 不符。

---

## 1. `dsh-channel-design.md` §1.1「dsh 源码给出的形状答案」

| 断言 | 结论 | 源码 |
|---|---|---|
| `LlmRuntime extends Service`（具体类，`ctx.llm`）+ `registerAdapter(providers, adapter)` 返回带 `dispose` 的 handle | ✅（⚠️ 补精：handle 是**可调用 disposer + `.replace(providers)`**，不是 `{ dispose }` 对象） | `dsh-llm/lib/types/index.d.ts:198`（类）、`:215`（registerAdapter）、`:155-173`（`AdapterRegistrationHandle`） |
| adapter 是**普通抽象类**，不是 Service | ✅ | `dsh-llm/lib/types/index.d.ts:113`（`abstract class LlmAdapter`） |
| 定义包形状 = `declare module` + 抽象类（能力事实用 `get` 保守默认值）+ 类型导出 | ✅ | `LlmAdapter` 的 `providerRetryPolicy`/`listModels` 等 getter 式保守默认；`declare module '@deepseek-ai/cordis'` 归并 Context/Events 是全仓范式 |
| 纯事件旁路 = 不提供服务，只 `ctx.on('fs/*')`，每个 `apply()` 一份状态、disposer 归零 | ✅ | 与 `ctx.on`（fiber 拥有、卸载撤销）语义一致 |
| 依赖方向 = 跨 dsh 包 `peerDependencies`、`dependencies` 只留第三方 | ✅ | 与 dsh 生态约定一致 |
| 可选依赖降级 = `import type {}` + `ctx.get('approval')`，缺失→deny | ✅ | `dsh-tools/lib/types/index.d.ts:784-794`（`serviceAsk`：`ctx.get('approval')`，无 ApprovalService 时"historical degrade to deny"） |

**设计裁定复核**：`Channel` 不继承 `Service`、`ChannelRegistry` 是唯一 Service core——正确。
一个 Service 独占一个 ctx key；`LlmAdapter` 正是普通抽象类；provider 生命周期由它自己
的插件 fiber 承载，注册项由 `register()` 返回的 disposer 回收。**与 rc.6 完全一致。**

---

## 2. `dsh-channel-design.md` §1.2「待核实 API：已全部核实」

| 断言 | 结论 | 源码 |
|---|---|---|
| `ctx.agents.create({ sessionId, meta:{cwd, agentPreset…}, agentOptions:{provider,model}, setup? })` → `AgentHandle { agent, dispose }` | ✅（⚠️ 补精：`meta` 另有 `parentSession`/`seedLength`/`origin`/`delegationDepth`；`setup` 是异步事务回调） | `dsh-agent/lib/types/index.d.ts:65-118`、`:155-158`、`:288` |
| `ctx.agents.resume({ resumeSessionId, … })` 恢复持久化会话（依赖 sessionPersistence） | ✅ | `dsh-agent/lib/types/index.d.ts:123-140`、`:296` |
| `ctx.agents.get(id)` 返回裸 `Agent` | ✅ | `dsh-agent/lib/types/index.d.ts:349` |
| 投递入站：`agent.followup(msg)` / `agent.steer(msg)` / `agent.inject(msg)` | ✅ | `dsh-agent/lib/types/runtime-types.d.ts:115/123/132` |
| 输出没有回调 API——从 `session/event` 读 `assistant/message` / `turn/end` | ✅ | `dsh-session/lib/types/index.d.ts:66`（emit feed）；`assistant/message`/`turn/end` 是 `SessionEventMap` 变体（`types.d.ts:241/275`） |
| `agent.status`（`idle`/`running`）与 `agent/status` 事件可驱动 typing | ✅ | `runtime-types.d.ts:45`（`AgentStatus`）、`:169`（`agent/status` emit） |
| `session/event` schema = `(session, event)`、emit、post-commit、fire-and-forget | ✅ | `dsh-session/lib/types/index.d.ts:66` |
| `SessionEvent = { type, seq, time, data, ignorable? }` | ⚠️ 补精：它是**按 `type` 判别的联合**；`user/message`/`assistant/message`/`tool/result` 三类表面事件还带 `sourceEventSeqs?`/`surfaceOp?` | `dsh-session/lib/types/types.d.ts:420-452`、`:362`（`SurfaceEventType`） |
| `SessionEventMap` 经 `declare module '@deepseek-ai/dsh-session/types'` 归并扩展 | ✅ | `dsh-agent/lib/types/types.d.ts:9`、`dsh-user-approval/lib/types/index.d.ts:27` |
| `approval/asked`/`approval/decided` 是现成范例 | ✅ | `dsh-user-approval/lib/types/index.d.ts:28-51` |
| 「裸事件夹在 turn 之外，reload 时视作 crash tail 被丢弃」 | ⚠️ 未在已读源码里逐字核实（属 `dsh-session-persistence` 后端行为）。rc.6 证据：`TurnEndReasonMap.interrupted`（"persistence backend closed a crash-orphaned turn on reload"）说明孤儿轮次由持久化后端在 reload 关闭；"turn 外 append 裸事件会丢"的精确语义应在接持久化时再对 `dsh-session-persistence` 源码复核 | `dsh-session/lib/types/types.d.ts:164-166` |
| `approval/request`：waterfall `(req, next) => Promise<ApprovalOutcome>`；`req = { agent, toolName, callId?, reason?, signal? }`；outcome ∈ `'allowed-once'|'rejected'|'cancelled'|'unavailable'` | ✅ | `dsh-user-approval/lib/types/index.d.ts:24`（事件）、`:104-125`（`ApprovalRequest`）、`types.d.ts:23`（`ApprovalOutcome`） |
| 无 answerer / answerer 抛错 → `'unavailable'`（fail-closed）；`signal` abort → `'cancelled'`，迟到回答丢弃 | ✅ | `dsh-user-approval/lib/types/index.d.ts:154-171`（`request` 文档） |
| 会话策略 `'never'` 在 dispatch 之前就地拒绝 | ✅ | `index.d.ts:81`（`ApprovalPolicy = 'ask'|'never'`）、`:75-79` |
| 审计对（asked/decided）由 `ApprovalService` 落日志，answerer 无需管 | ✅ | `index.d.ts:28-51` + `request()` 文档 |
| `ctx.sessions.fork(source, boundary?, childSessionId?)`；`OPEN_TURN` 拒绝 | ✅ | `dsh-session/lib/types/index.d.ts:413`（fork）、`:278`（`SessionForkErrorCode` 含 `OPEN_TURN`） |
| `ctx.credentials.resolve(credentialRef('X'))` → `{ value, source } | undefined`；每次操作重解析 | ✅ | `dsh-credentials/lib/types/index.d.ts:18`（`credentialRef`）、`:20-25`（`ResolvedCredential`）、`:56`（`resolve`） |

**结论**：§1.2 的 dsh 触点断言**全部与 rc.6 源码对齐**，仅两处需要补精（`SessionEvent`
联合形状、`registerAdapter` handle 形状），没有发现 ❌ 项。

---

## 3. `dsh-channel-handoff.md` R1–R10 硬约束核对

| 规则 | 结论 | 说明 |
|---|---|---|
| R1 可逆副作用 | ✅ | `ctx.effect(execute, label?)` 返回单次 disposer；`register()` 返回 disposer 随 fiber 回收（`cordis/lib/types/fiber.d.ts:157-159`） |
| R2 `inject` 声明依赖；可选依赖 `ctx.get` + type-only + 缺失降级 | ✅ | `ToolRuntime.serviceAsk` 是"approval 缺失→deny"的**精确现成范例**（`dsh-tools:784-794`） |
| R3 接口/实现分包，依赖只指接口 | ✅ | 与 `LlmRuntime`(def)/`LlmAdapter`(seam)/`llm-deepseek`(provider) 三分一致 |
| R4 契约 = 方法签名 + 事件词汇表，同一 `declare module '@deepseek-ai/cordis'` | ✅ | 全仓范式：`Context`/`Events` 归并 |
| R5 注册表是 core、单个 channel 是 seam | ✅ | `LlmRuntime`(core Service) + `LlmAdapter`(抽象类 seam) 逐字对照 |
| R6 能力差异用 get 保守默认值 | ✅ | `LlmAdapter` 的 getter 式保守默认；`FileSystem`/`sandboxMode` 同理 |
| R7 模型可见 = 必须入日志 | ✅ | `deriveMessages()` 从日志投影历史；"模型可见即已记录"是运行时不变式 |
| R8 waterfall 必须调 `next()`，不要夺权 | ✅ | `agent/pre-step`/`approval/request`/`tools/*`/`llm/stream` 均 waterfall |
| R9 装配在 YAML；凭据走 `ctx.credentials` | ✅ | `credentialRef` + `resolve` 每操作重解析 |
| R10 作用域，不写死全局假设 | ✅ | `ctx.scope`（`createScope`/`scopeOf`/`scopeTarget`）+ `agent.ctx`；agent preset 用 `isolate` realm |

---

## 4. 需要落地到实现里的三处精度

1. **入站构造 `UserMessage` 用 `createUserMessage()`**（`dsh-llm/lib/types/message.d.ts:171`）：
   完整 `UserMessage` 需要 `id` + `role:'user'` + `content: ContentBlock[]` + `source`。
   设计 §5.2 的 `msg.source = {…}` 是伪代码；实际应 `createUserMessage({ content: [文本块], source: { kind:'channel', … } })`
   再 `agent.followup(msg)`。
2. **`MessageSourceMap.channel` 扩展点定位正确**：`declare module '@deepseek-ai/dsh-llm'`
   里的 `interface MessageSourceMap`（`dsh-llm/lib/types/message.d.ts:94`），成员带 `kind`
   判别字段；现有 `user|plugin|model|tool` 四种，加 `channel` 与它们并列即可。
3. **读输出走 `session/event`**：`assistant/message` 的 `data` 是
   `{ turn, step, message: AssistantMessage, usage? }`；`turn/end` 的 `data` 是
   `{ turn, reason }`——设计 §5.3 的 `textOf(event)` / 状态行推送要按这两个 data 形状解包。
