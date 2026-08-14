# DSH 核心与能力 Seam 参考（对齐 `@deepseek-ai/*@0.1.0-rc.6`）

> 本文记录 DeepSeek Harness (dsh) 自身的核心架构与能力 seam，作为本仓库
> (`dsh-channel`) 的**唯一对齐基线**。写作时逐条对照了官方参考文档
> （https://deepseek-harness.github.io/deepseek-harness/reference/ ）**与已安装的
> rc.6 编译类型声明**（`node_modules/@deepseek-ai/*/lib/types/*.d.ts`）。凡是
> 两者有版本漂移的地方都单独标注，不要拿 master 文档里的符号直接写代码。

- 官方文档 = `deepseek-harness` **master 分支**生成（含 `steering/message`、
  `TurnTriggerMap` 等 rc.6 里尚不存在的符号）。
- 本项目 `package.json` 的 devDependencies 钉在 `^0.1.0-rc.6`；运行时 harness
  也跑在 rc.6 上。**代码以 rc.6 为准**，文档仅作语义参考。

---

## 0. 一句话结论（对齐后的形状）

dsh 没有需要打补丁的"特权内核"。**每个 ctx 键要么是 `core`（唯一主干服务）、
要么是 `seam`（可替换能力的 Service Definition）、要么是 `bundle`（组合点）**。
扩展 dsh 的方式是往别的插件旁边挂一个插件：所有注册都是可逆副作用，插件卸载即撤销。

- `core`：一个进程/作用域内唯一的服务，持有产品事实（注册表、日志、状态折叠）。
- `seam`：**声明接口的 Service Definition + 实现它的 Provider + 使用它的 Consumer**
  三者合起来才构成一项能力；替换 provider 就能换掉整个产品行为（如把
  `ctx.subprocess` 指向远程沙箱，Bash/PTY/LSP 一起搬走，无需 provider 专用 fork）。
- `bundle`：组合点（如 `ctx.agentLoop`），是"默认产品循环"的**唯一具体实现**，
  扩展包依赖 `dsh-agent` 的事件与服务，**绝不**直接依赖 `dsh-agent-loop`，以保持循环可替换。

本文其余部分：
1. [Cordis 底座](#1-cordis-底座) —— Context / Service / Events / 分发模式 / effect
2. [ctx 全表：seam 与 core](#2-ctx-全表seam-与-core) —— 主干 + 本项目触点的完整角色表
3. [核心包（packages/core/）](#3-核心包packagescore) —— 六包与 `ctx.agents` 精确 API
4. [轮次/步骤生命周期](#4-轮次步骤生命周期) —— turn/step 与 `agent/*` 事件
5. [工具执行流水线](#5-工具执行流水线) —— `tools/*` 事件与 approval 降级
6. [会话日志与 SessionEventMap](#6-会话日志与-sessioneventmap) —— 唯一真源
7. [全仓通用类型模式](#7-全仓通用类型模式) —— `…Map→union` 与 Branded id
8. [与本项目设计的对齐核对](#8-与本项目设计的对齐核对) —— 摘要（详见 `dsh-core-alignment-audit.md`）

---

## 1. Cordis 底座

dsh 底层是 vendor 进来的 Cordis。五个核心概念（官方 cordis-primer）：

1. **插件** = 实现 `Service` 的对象：函数插件（可选 `inject` + `apply(ctx)`）或
   `Service` 子类。生命周期由 Cordis 挂载到当前上下文。
2. **上下文是服务容器**：一个服务占一个稳定 `ctx.<key>`；其他插件**通过 key 查找**，
   不 import 具体实现。
3. **`inject` 声明服务依赖**：插件等待所依赖的服务就绪才启动；加载顺序用服务依赖
   表达，不手工编排。
4. **类型化事件用于通信**：通过 TypeScript 声明合并注册事件名，再以 emit /
   waterfall / parallel / serial / bail 分发。
5. **注册是可逆副作用**：提示片段、工具 schema、适配器、provider、监听器经
   `ctx.effect()` 或 `ctx.on()` 安装，reload/teardown 自动撤销。

### 1.1 事件分发模式（`DispatchMode`）

| 模式 | await | 顺序 | 有返回值 | 语义 |
|---|---|---|---|---|
| `emit` | 否 | 注册顺序 | 否 | 观察；同步跑、忽略返回值 |
| `waterfall` | 否* | 注册顺序 | 是 | 环绕中间件：`(...args, next)`，调 `next()` 委托下去，不调则短路 |
| `parallel` | 是 | 并发 | 否 | 全部并行，等所有监听器 settle |
| `serial` | 是 | 注册顺序 | 是 | 依次 await，直到一个 bail（返回非 null/false/undefined） |
| `bail` | 否 | 注册顺序 | 是 | 同步依次调用，遇到第一个 bail 值停止 |

> *`waterfall` 本身返回最外层监听器的返回值（可能是 Promise）；"是否 await"指分发本身不等待。

**waterfall 语义**：每个监听器包装"链的其余部分"——`next()` 执行下一个监听器
（最终是内置行为），下游返回值经 `next()` 回传到当前包装层；不调 `next()` 直接
返回 = 短路。**单决策事件里短路是设计意图**（策略监听器拥有决策权时直接返回）；
纯观察/标注的监听器必须委托。对应源码：`@deepseek-ai/cordis/lib/types/events.d.ts`
（`ctx.parallel/emit/serial/bail/waterfall/on/once`）。

### 1.2 Context / Service / effect 要点

- `Context` 是**代理**：属性读取走服务解析器；`extend()`/`isolate()`/`intercept()`
  创建有作用域的子上下文而不改父上下文。
  - `ctx.isolate(name, label?)`：给 `name` 一个独立服务作用域（同 label 两次 = 同作用域）。
  - `ctx.intercept(name, config)`：为下方插件合并该服务的拦截配置。
- `ctx.provide(name, value)`：注册一个**归当前 fiber 所有**的服务实现；fiber 激活后可见，
  卸载时撤销并唤醒依赖方。
- `Service` 基类：`super(ctx, name)` 即注册为 `ctx.<name>`；持有 `protected ctx`。
  子类实例就是那个 ctx 键的值。
- `ctx.effect(execute, label?)`：`execute` 返回 disposer（或 generator，按 yield 顺序
  逐个登记）；返回的 disposer 单次、可 await。副作用创建与销毁写在同一个 effect 里，
  才能保证 teardown 顺序。签名：`@deepseek-ai/cordis/lib/types/fiber.d.ts`。

---

## 2. ctx 全表：seam 与 core

角色标注规则（官方 capability-seams 页）：**seam = 可替换能力**（Service Definition
+ Provider + Consumer 三者设计成一体）；**core = 唯一主干服务**；**bundle = 组合点**。
下表左侧列是官方全表里与本项目/主干最相关的一部分（完整 ~50 项见官方
`/reference/capability-seams`）。

| ctx 键 | 角色 | 声明包 | rc.6 具体类型 | 直接消费方 | 说明 |
|---|---|---|---|---|---|
| `ctx.sessions` | **core** | dsh-session | `SessionStore`（`extends Service`） | agent-loop、agent、session-persistence、query、subagent、invariants | 仅追加 `Session` 实例 + 持久会话事件流 |
| `ctx.systemPrompt` | **core** | dsh-system-prompt | `SystemPrompt` | agent-loop、tools、tool-fs/terminal/web | 每步收集提示片段 + 面向模型的 tool schema |
| `ctx.tools` | **core** | dsh-tools | `ToolRuntime` | agent-loop、各 tool-* | 作用域化注册表 + 把关执行流水线 |
| `ctx.agents` | **core** | dsh-agent | `AgentRegistry` | agent-loop、acp、subagent-inprocess | 实时 `Agent` 句柄、创建/恢复工厂 seam、发起者传播 |
| `ctx.agentLoop` | **bundle** | dsh-agent-loop | `AgentLoop`（`implements AgentFactory`） | —（唯一具体循环） | 默认产品循环；扩展包不得依赖它 |
| `ctx.scope` | （无 ctx 键） | dsh-scope | 库：`createScope`/`scopeOf`/`scopeTarget` | session、system-prompt 等 | 按 agent 划分作用域的注册原语 |
| `ctx.llm` | **seam** | dsh-llm | `LlmRuntime`（抽象 `LlmAdapter`） | agent-loop、compaction | 消息/流词汇 + 适配器注册表 |
| `ctx.approval` | **seam** | dsh-user-approval | `ApprovalService` | tools、tool-bash | 一次性权限决策（`approval/request` waterfall） |
| `ctx.credentials` | **seam** | dsh-credentials | `CredentialProvider`（抽象） | llm 适配器、apiproxy | 机密引用解析，每次操作重解析 |
| `ctx.sessionPersistence` | seam | dsh-session-persistence | — | agent-loop、session-query、tool-bash | 同一套 SessionEvent 词汇的持久化后端 |
| `ctx.subprocess` | seam | dsh-subprocess | — | bash、terminal、LSP、subagent | 进程坐标、进程树/会话生命周期、stdio、kill 升级 |
| `ctx.shell` | seam | dsh-shell | — | tool-bash、tool-pwsh | 面向模型的 shell 执行 |
| `ctx.terminals` | seam | dsh-terminal | — | tool-terminal | 持久化 PTY 会话 |
| `ctx.fs` | seam | dsh-fs | — | tool-fs、fs-observation-policy | 读/写/编辑 + 沙箱限制 |
| `ctx.sandbox` | seam | dsh-sandbox | — | bash-sandbox、terminal-bash | 包装 spawn 的 argv，报告强制执行情况 |
| `ctx.jobs` | seam | dsh-jobs | — | tool-jobs、tool-bash/subagent | 后台工作登记/收集/终止 |
| `ctx.subagents` | seam | dsh-subagent | — | tool-subagent、tool-ralph | 委派（一次性/可延续）的传输 |
| `ctx.invariants` | **core** | dsh-invariants | `InvariantRegistry` | session、agent、scope、agent-loop | 包自有的运行时不变式注册表 |

> 本项目直接触点的精确签名（rc.6 源码行号）见 §3、§5、§6 与 `dsh-core-alignment-audit.md`。

---

## 3. 核心包（packages/core/）

一个轮次按同一循环流经六个包：agent-loop 的 driver 认领排队提示词 → 在
`ctx.sessions` 上开轮次 → `ctx.systemPrompt` 组装请求前缀、从日志派生历史 →
`ctx.llm` seam 流式取响应 → `ctx.tools` 分发工具调用 → 每个模型可见事实追加回日志。

| 包 | 职责 | ctx 键 |
|---|---|---|
| session | 仅追加 `SessionEvent` 日志 + 内存 store（唯一真源） | `ctx.sessions` |
| system-prompt | 提示片段与工具 schema 组装 | `ctx.systemPrompt` |
| tools | 作用域化工具注册表 + 受保护执行流水线 | `ctx.tools` |
| agent | `Agent` 接口、实时注册表、发起者作用域、`agent/*` 事件 | `ctx.agents` |
| agent-loop | 实现公开 Agent 约定的具体 driver | `ctx.agentLoop` |
| scope | 按 agent 作用域的注册原语库（**非服务、零依赖**） | 无 |

`scope/` 是唯一非服务包，位于 session/system-prompt 之下，让二者消费它而不成环。

### 3.1 `ctx.agents` 精确 API（rc.6）

源码：`dsh-agent/lib/types/index.d.ts`、`dsh-agent/lib/types/runtime-types.d.ts`。

```ts
// 创建 / 恢复（index.d.ts）
interface CreateAgentOptions {
  readonly sessionId: SessionId                       // 活 agent/session 共享身份
  readonly meta?: { cwd?; parentSession?; seedLength?; origin?: 'subagent'; delegationDepth?; agentPreset? }
  readonly seed?: readonly SessionEvent[]             // 可选 fork 回放前缀
  readonly agentOptions?: AgentOptions
  readonly signal?: AbortSignal                       // 仅创建期有效
  readonly setup?: AgentSetup                          // 发布前组装 agent 作用域世界
}
interface ResumeAgentOptions { resumeSessionId; agentOptions?; signal?; setup? }
interface AgentHandle { agent: Agent; dispose(): Promise<void> }
// AgentRegistry（Service）
class AgentRegistry {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
  register(agent: Agent): () => void
  get(id: SessionId): Agent | undefined
  list(): Agent[]; roots(): Agent[]
  withInitiator<T>(agent, op: () => T): T; currentInitiator(): Agent | undefined
  setFactory(factory: AgentFactory): () => void
}
```

```ts
// Agent（runtime-types.d.ts）—— 面向编程的 surface
interface Agent {
  readonly id: SessionId
  readonly options: AgentOptions                       // { provider?, model?, maxTokens? }
  readonly session: Session                            // 其日志 = 持久唯一真源
  readonly inbox: Inbox
  readonly status: AgentStatus                         // 'idle' | 'running'
  readonly ctx: Context                                // agent 作用域上下文
  cancel(cause: AgentCancelCause, options?: CancelOptions): void
  whenIdle(): Promise<void>
  runMaintenance<T>(task: (signal) => Promise<T>): Promise<T>
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
  followup(message: UserMessage): void                 // 独立新 turn + 唤醒
  steer(message: UserMessage): void                    // 插话，最近 step 边界消费
  inject(message: UserMessage): void                   // 注入上下文，不唤醒
}
// InboxTarget = 'next-turn' | 'next-step'
// PreStepDecision = {kind:'reject'} | {kind:'enter', messages: UserMessage[]}
// RequestErrorAction = {kind:'retry'} | undefined
// SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'
```

**要点**：
- `create()`/`resume()` 是**异步事务**：先 `setup(agentCtx)`（未发布），再 insert →
  announce session → announce agent → `agent/session-start` → 才起循环；setup 拒绝、
  commit 抛错或 owner dispose 都回滚、两个 id 都不发布。
- 投递三预设：`followup`（独立 turn）、`steer`（最近 step 边界）、`inject`（不唤醒）。
- **输出没有回调 API**：从 `session/event` 流读 `assistant/message` / `turn/end`
  （见 §6）。`agent/status`（emit）+ `agent.status` 可驱动 typing 指示。

### 3.2 `ctx.agentLoop`（bundle）

`AgentLoop extends Service implements AgentFactory`（`dsh-agent-loop/lib/types/index.d.ts:102`）：
`create(id, options?, meta?)` / `createAgent(ownerCtx, options)` / `resume(ownerCtx, options)`。
它是 `ctx.agents.setFactory()` 注册的工厂；**消费方通过 `ctx.agents` 编程，永不依赖
`dsh-agent-loop`**。

### 3.3 `ctx.scope`（库）

`dsh-scope/lib/types/index.d.ts`：
- `type ScopeKey = object`（不透明、身份比较）
- `type Scoped<T>`：`scopeTarget(base, key)` 返回的路由接收器品牌标记
- `createScope(ctx, key, options?): Scope`、`scopeOf(ctx): ScopeKey | undefined`、
  `scopeTarget<T>(base, key): Scoped<T>`
- 作用域过滤的事件用 `Scoped<T>` 作 `this` 类型；真实主体仍走显式参数。

---

## 4. 轮次/步骤生命周期

一个**步骤** = 一次模型请求 + 它调用的工具。一个**轮次** = 零或多个步骤：领到首条
输入前打开，不再欠任何工作时关闭。

```
turn/start
  claim next-step 输入 + 一条排队消息
  组装提示片段 + 工具 schema
  -> agent/pre-step        （waterfall：reject | enter(messages)）
  reject / 首次 enter 改写为空 -> 以零步骤关闭轮次
  step/start
    已进入消息追加为 user/message
    从日志 deriveMessages() 派生模型历史
    agent/request -> llm/stream -> assistant/chunk* -> assistant/message
    tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
  step/end
  工具欠另一次请求 或 next-step 输入到达 -> claim -> 下一步
  -> agent/turn-stopping  （serial，无 next()）
turn/end
```

- **持久会话事件**：`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*`。
- **实时扩展点**（三域）：`agent/*`（inbox/step/status/request/验证/续跑）、
  `tools/*`（能力 seam 策略/适配器）、`llm/stream`。
- `agent/pre-step`、`agent/request`、`llm/stream` 与三个 `tools/*` 是 **waterfall**
  （监听器必须调 `next()` 才委托）；`agent/turn-stopping` 是 **serial**（无 `next()`）。
- 输入通过同一个 inbox 到达 driver；`agent/pre-step` 决定模型看到什么。

**`agent/*` 事件**（`dsh-agent/lib/types/runtime-types.d.ts`）：
`agent/created`、`agent/disposed`、`agent/status`、`agent/inbox/inserted|claimed|discarded`、
`agent/session-start`（以上 emit）、`agent/pre-step`、`agent/request`、`agent/request-error`
（waterfall）、`agent/turn-stopping`（serial）、`agent/error`（emit）。

---

## 5. 工具执行流水线

源码：`dsh-tools/lib/types/index.d.ts`（`ToolRuntime`、`ToolDefinition`、`defineTool`、
`tools/*` 事件）。

```ts
class ToolRuntime extends Service {   // ctx.tools
  register(definition: ToolDefinition): () => void
  restrict(filter: ToolRestriction): () => void     // 作用域内 allow/deny 全局工具
  guard(guard: ToolGuard): () => void                // 单调守卫（只能 deny，不能 force-allow）
  get(name, scope?): ToolDefinition | undefined
  schemas(scope?): ToolSchema[]
  execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>
}
```

顺序：`tools/pre-execute`（waterfall，可 `allow | deny | ask`）→ **单调守卫** →
`tools/execute`（waterfall，around-dispatch，超时/重试/度量）→ 工具体 →
`tools/post-execute`（waterfall，`accept | block` + 可选 `additionalContexts`）→
`finalizeContent`（定义自有，同步纯内容变换）→ 无损快照 → `tools/result`（emit，冻结快照）。

**approval 降级（本项目 R2/A3 的直接依据）**：`ToolRuntime.serviceAsk`（源码
`dsh-tools/lib/types/index.d.ts:784-794`）**机会主义地 `ctx.get('approval')`**——
没装 `ApprovalService` 时"保持历史上的 degrade to deny"，`ask` 一律转 deny；
只有 `allowed-once` 放行，三个非放行结果各自带不同 reason。agentless 执行同样降级。

**`approval/request`（seam，`dsh-user-approval`）**：
```ts
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
type ApprovalPolicy  = 'ask' | 'never'
interface ApprovalRequest {
  readonly agent: Agent; readonly toolName: string
  readonly callId?: CallId; readonly reason?: string; readonly signal?: AbortSignal
}
// 事件：'approval/request'(req, next) => Promise<ApprovalOutcome>   (waterfall)
// 审计对：SessionEventMap 扩展 'approval/asked' / 'approval/decided'（log-only）
```
`signal` abort → `'cancelled'`（迟到回答丢弃）；无/抛错 answerer → `'unavailable'`
（fail-closed）；`'never'` 策略在 dispatch 前就地 `'rejected'`；rogue 非词汇返回值
归一化为 `'unavailable'`。源码：`dsh-user-approval/lib/types/index.d.ts` 与 `types.d.ts`。

### 5.1 工具属于 agent preset（agent 平面）

Web 部署下**工具不是全局的**，而是按会话由 preset 在 agent 平面挂载。分两层：

- `dsh-base` 全局装载 `tool-*`（TUI 单会话直接用）；`dsh-web-app` 把这些全局工具行
  **全部 `disabled: true`**，改挂 `dsh-agent-presets`（`default: standard`）。
- `standard` preset（`config/agent-presets/standard/agent.cordis.yml`）是 **agent-plane
  组合**：把 `tool-bash`/`tool-fs`/`tool-web`/`tool-subagent`/`tool-ralph`/`tool-workflow`/
  `plan-mode`/`tool-todo`/`tool-ask-user` 等整套工具 + persona + skills 重新挂进每个会话。

**join 机制**：`dsh-agent-presets` 提供 `mount(agentCtx, id?)` 与 `composeFrom(agentCtx, parentCtx)`，
**必须在 agent factory 的 `setup(agentCtx)` 里调用**（失败会回滚整个创建）。canonical 调用点
是 `dsh-host-apiproxy` 的 `composeAgent`：先 `resolve(id)` 拿到 resolved id → 写进
`meta.agentPreset`（session header，供 resume 重建）→ setup 里 `await presets.mount(agentCtx, resolvedId)`。

**漏 join 的后果**：agent 发布时 `dsh-agent-presets` 打警告——

> `agent … was published without joining an agent preset; its tools, prompt sections, and skill catalog resolve against the empty global layer`

空全局层 ⇒ `request/header.tools` 为空 ⇒ DeepSeek 模型把想调用的工具写成 `<tool_calls>`
XML 纯文本吐出来。**对本项目（channel）的直接要求**：任何渠道 provider 用
`ctx.agents.create()` 建 agent 时，都必须 resolve + 记录 + mount preset，才能继承宿主
默认能力；无 roster（`ctx.get('agentPresets')` 为空）时降级走 host 全局层。

---

## 6. 会话日志与 SessionEventMap

源码：`dsh-session/lib/types/types.d.ts`、`dsh-session/lib/types/index.d.ts`。

- `Session`：一份类型化 `SessionEvent` 的**仅追加日志**（唯一真源）。`deriveMessages()`
  从中投影 LLM 消息历史，不单独存历史。
- 信封（rc.6）：**按 `type` 判别的联合**，不是独立的 `type`/`data` 联合：
  ```ts
  type SessionEvent<T = SessionEventType> = {
    [K in SessionEventType]: {
      type: K; seq: number; time: number; data: SessionEventMap[K]; ignorable?: true
    } & (K extends SurfaceEventType ? { sourceEventSeqs?: number[]; surfaceOp?: SurfaceOp } : object)
  }[T]
  ```
- `SessionEventType = keyof SessionEventMap`；插件经
  **`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { … } }`**
  归并扩展（`dsh-user-approval` 的 `approval/asked|decided|policy` 是现成范例）。
- `SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result'`——**只有这三类
  能携带 `surfaceOp`/`sourceEventSeqs`、也只有它们派生模型历史**。
- rc.6 的 `SessionEventMap` 变体（dsh-session）：`turn/start`、`turn/end`、`step/start`、
  `step/end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、
  `tool/result`、`todo/write`、`request/header`、`request/context`、`session/end-seed`。
  扩展：`agent/inbox/spliced`（dsh-agent）、`approval/asked|decided|policy`（dsh-user-approval）。
  > master 文档还列了 `steering/message`，rc.6 **没有**；rc.6 的 steering/注入落在
  > inbox 里，认领后以 `user/message`（`source` 区分）落日志。

- `ctx.sessions`（`SessionStore extends Service`，`index.d.ts:290`）：
  `create(id?, options?)` / `prepare` + `enter` + `announce`（有序复合 effect 用）/
  `get(id)` / `list()` / `fork(source, boundary?, childSessionId?)` / `flush(session)`。
  - `fork` 拒绝码（`SessionForkErrorCode`）：`SESSION_NOT_FOUND` / `SESSION_NOT_LIVE` /
    `SESSION_ALREADY_EXISTS` / `INVALID_BOUNDARY` / `OPEN_TURN`。
- `session/event`（`index.d.ts:66`）：**emit、post-commit、fire-and-forget**；
  `(this: Scoped<Session>, session, event)`；observer 失败被包含，不影响已提交的 append。
- `session/flush`（`index.d.ts:75`）：**parallel** 持久化检查点（无 veto）。
- `TurnEndReasonMap`（`types.d.ts:135`）：`completed | aborted(reason) | blocked |
  error(error) | max-tokens | interrupted`。

---

## 7. 全仓通用类型模式

### 7.1 `…Map → derived-union`（声明合并扩展）

```ts
interface ThingMap { 'a': { kind: 'a' }; 'b': { kind: 'b' } }
type Thing = ThingMap[keyof ThingMap]           // 判别联合
declare module '@deepseek-ai/dsh-llm' { interface ThingMap { 'c': { kind: 'c' } } }
```

rc.6 的规范 map（本项目会扩展 `MessageSourceMap`）：
- dsh-llm：`ContentBlockMap`、`MessageSourceMap`、`FinishReasonMap`（另有 `ModelModalityMap`）
- dsh-session：`TurnEndReasonMap`、`SessionEventMap`

消费方 switch 两个大判别联合：`StreamChunk`（流协议）与 `SessionEvent`（日志条目）。
**约定 switch 标签、不用链式 if**，拼错标签编译失败。

`MessageSourceMap`（`dsh-llm/lib/types/message.d.ts:94`）现状：
`user | plugin | model | tool`；`MessageSource = MessageSourceMap[keyof MessageSourceMap]`。
本项目加 `channel` 变体即对齐此扩展点（见设计 §3.1）。

### 7.2 Branded id

`Branded<B>` 原语在纯类型包 `dsh-brand`（零运行时、零依赖）。结构是字符串，类型层面
不可互换。核心 id：`SessionId`（dsh-session）、`CallId`（dsh-llm），另有
`CredentialRef`（dsh-credentials）、`ApprovalRequestId`（dsh-user-approval）、
`MessageId`/`ProviderRequestId`（dsh-llm）。

---

## 8. 与本项目设计的对齐核对

`dsh-channel-design.md` §1.1/§1.2 与 R1–R10（现见 design §6）的**逐条核对**
（每条附 rc.6 源码行号）见 `dsh-core-alignment-audit.md`。

摘要结论：
- **`ChannelRegistry`(core) + `Channel`(普通抽象类 seam) 的拆分、`ctx.llm`/`LlmAdapter`
  的对照、`approval/request` 的降级语义、`ctx.credentials.resolve`、`ctx.sessions.fork`、
  `session/event` 与 `SessionEventMap` 扩展点——全部与 rc.6 源码逐字对齐。**
- 需要修正/补精的两处：`SessionEvent` 是**按 type 判别的联合**（表面事件才带
  `surfaceOp`/`sourceEventSeqs`）；`registerAdapter` 返回的是**可调用 disposer +
  `.replace()`** 的 handle（不是 `{ dispose }` 对象）。详见 audit 文档。
