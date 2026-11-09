# Session Manager / Channel 现状 Review（2026-10-17）

> **状态：未提交的工作区 review 快照。**
> 这不是第五份 living document。正式提交前应把仍有效的结论折叠进
> `dsh-channel-design.md` / `docs/dsh-channel-backlog.md`，然后删除本文件；
> 或者明确把它降级为一次性过程文档。当前工作树里的未提交改动是
> §15.4 闭环加固（`wakeLimit` 断路器 + idle-edge 补扫 + fold listener 顺序），
> 本 review 基于这份未提交状态。

## 0. 结论摘要

- 工程状态健康：`npm run test` / `npm run typecheck` 全绿；架构方向（contract
  零实现、kit 共享 handler、manager 与 channel 解耦、provider 只做 transport）
  是对的，测试覆盖也扎实。
- 未提交的闭环加固本身设计合理，但踩到一个**高危持久化 bug**：JSON store
  重载时丢掉 `wokeAt`，导致重启后已经唤醒过的 task 被全部重新唤醒。默认
  `statePath` 路径和 dev-bot / self-test 都受影响。
- M20 的“资源管理面”有几个功能缺口：冷会话无法被 concierge 复活、
  `list({workspaceId})` 忽略过滤、`archive` 只写不读。
- Channel ⟷ manager 的多 chat 绑定存在一个真实体验问题：两个 chat focus 同一
  个 session 时，只有一个收到流式输出。
- 产品层面（附录）：按修正后的目标（manager 有自己的 session，管理其他
  working session），核心形态**已经实现**（`manager:concierge`）；两个场景
  的主要缺口是 channel 绑定仍是“全局单例 + 手动 `/bind`”、没有 owner
  scope、没有通用 per-task hook、冷会话不能由 manager 直接 dispatch。

## 1. 验证记录

| 命令 | 结果 |
|---|---|
| `npm run test` | 退出码 0；README 测试表 15 + 87 + 160 + 47 + 10 + 20 = 339 |
| `npm run typecheck` | 退出码 0 |
| JSON store `wokeAt` round-trip | **失败**（见 P1） |
| 两进程重启 re-wake | **复现**（见 P1） |
| `disposeSession` 后 task 状态 | **复现**（见 P5） |
| `list({workspaceId})` | **复现**（见 P3） |
| 先 watch 后 adopt 的 steer 折叠 | **复现**（见 P7） |

复现都用 `packages/session-manager/test/harness.ts` 和
`createJsonFileManagerStore`，脚本未落盘。

## 2. 问题清单

### P1（高）JSON store 重载时丢掉 `wokeAt`，重启后会重复唤醒

位置：

- `packages/session-manager/src/store/json-file.ts:64-80` — `normalizeTasks`
  是白名单重建，没有 `wokeAt`。
- `packages/session-manager/src/manager.ts:1052-1061` —
  `unwokenConciergeTasks` 把 `wokeAt === undefined` 当作“尚未唤醒”。
- `packages/session-manager/src/manager.ts:1167` — wake 完成后
  `putTask({ ...task, wokeAt: Date.now() })`。
- `packages/session-manager/src/types.ts:101-107` /
  `dsh-channel-design.md:1177` — 文档把它描述成 “presentation-cache flag”，
  但启动扫描实际把它当持久化决策游标。

机制：

1. 写盘时 `JSON.stringify` 会带上 `wokeAt`（落盘内容里确实有）。
2. 重载时 `normalizeTasks` 逐字段重建，丢掉未列出的字段。
3. 下一个进程启动，`recoverConciergeWakes` 认为所有历史 task 都没唤醒过，
   对最近 7 天、每会话最多 20 条 task 逐条 re-wake。

复现：

```
写盘:   {"taskId":"1",...,"state":"done","wokeAt":123}
重载:   {"taskId":"1",...,"state":"done"}          // wokeAt 消失
两进程: 第二个进程 start 后仍 followup "Task #1 ... ended: done"
```

影响：dev-bot 的 `statePath` 和 `scripts/concierge-selftest.mjs` 都走 JSON
store；设计 §15.4 只承诺 “rare, benign duplicate”，实际是每次重启一批重复。
断路器 cut 过的 task 也会被重新唤醒。

测试为什么没抓到：store fixture 的 task 没有 `wokeAt`；concierge 重启用例走
memory store（内存里字段还在）。

建议方向：`wokeAt` 补进 `normalizeTasks` 和 domain 的 `taskSchema`；加
JSON store round-trip 用例（含 `wokeAt`）和用
`createJsonFileManagerStore` 的两进程重启用例。同时把“它到底是持久决策
状态还是 presentation cache”在文档里定死。

### P2（高/中）concierge 无法复活冷会话

位置：

- `packages/session-manager/src/manager.ts:524-527` — `dispatch` 要求 live
  agent，否则抛错。
- `packages/session-manager/src/concierge-tools.ts:240-281` —
  `dispatch_message` 只建议 `create_session first`，工具集里没有
  `adopt`/`resume`。
- `packages/session-manager/src/manager.ts:391-399` /
  `dsh-channel-design.md:1224` — 文档说 “a later dispatch resumes”，实际
  `dispatch` 不 resume。

场景：

- 进程重启后，concierge 之前 `create_session` 出来的 worker 没有 chat
  binding，bridge 的 `restore()` 不会 resume 它；
- `dispatch_message` 永远失败，模型只能新建一个 session，丢掉连续性；
- `dispose_session` 后同理：文档说之后 dispatch 会 resume，实际抛
  “no live agent”。

channel 自由文本路径没事，因为 bridge 的 `ensureAgentManaged` 先 `adopt`；
坏的是 concierge / CLI 这条“直接 dispatch”的路径。

建议方向：加一个 `resume_session`/`adopt_session` 工具（薄封装
`manager.adopt`），或让 `dispatch` 对 known-managed 冷会话自动 adopt。

### P3（中）workspace 面只接了一半

1. `packages/session-manager/src/manager.ts:278-303` — `list` 的签名有
   `workspaceId`，方法体从未读取。复现：两个 session 分属 w1/w2，
   `list({ workspaceId: 'w1' })` 仍返回两个。
2. `packages/session-manager/src/manager.ts:457-478` — `create({ workspaceId })`
   不把 workspace 的 path 变成 cwd（backlog 已记为 “decorative grouping”）。
3. `packages/session-manager/src/manager.ts:434-447` — `archiveSession` 只写
   registry；`list()`/`buildView` 不读归档状态，`/ls` 仍显示已归档会话，
   与 `archive_session` 工具描述 “hidden from every grouping” 不一致。

bridge 的 `/ls <ws>` 自己在 `execListSessions` 里过滤，所以人类命令看起来
正常；concierge 的 `list_sessions({ workspaceId })` 和外部消费者拿到全量。

### P4（中）多 chat focus 同一 session：只有一个 chat 收到流

位置：

- `packages/channel-kit/src/bridge/bridge.ts:156` — `sessionChatKeys` 是
  `Map<sessionId, chatKey>`（单值）。
- `bridge.ts:1162-1173` — `setFocus` 直接覆盖。
- `bridge.ts:1731-1733` — `onSessionEvent` 只取一个 chatKey。
- `packages/channel-kit/src/policy/focus-presentation.ts:37-42` — turn-end
  对 `isFocused` 返回 `silent`。

场景：chat A `/bind manager:concierge`，chat B 再 bind 同一个 id。之后流式
输出只到 B；A 的 `focusedSessionOf` 仍指向 concierge，turn-end 又被判定
`silent`，所以 A 既没有流、也没有徽标通知。

这与设计 §15.3 “multiple chats may focus it concurrently” 直接冲突。

建议方向：`sessionChatKeys` 改成 `Map<sessionId, Set<chatKey>>` 逐 chat
fan-out；或限制一个 session 同时只能被一个 chat focus；至少让没拿到流的
focus chat 在 turn-end 收到 badged 结果。

### P5（中）`disposeSession` 留下僵尸 task

位置：

- `packages/session-manager/src/manager.ts:400-408` — 先
  `tracking.delete(id)` 再 `handle.dispose()`。
- `packages/session-manager/src/manager.ts:1295-1312` — `rebuildOpenTasks`
  只在 `start()` 跑。

复现：

```
before dispose: [ 'running' ]
after  dispose: [ 'running' ]      // 本进程内不会折 crashed
```

即使 dispose 过程中产生 `turn/end`，`onSessionEvent` 也因为 tracking 已删
而 return。于是 `tasks()` 和 `/ls` 的 `activeTask` 一直显示 running，但
agent 已经没了。文档说 “open turn folds crashed”，实际要等下一次进程启动。

建议方向：`disposeSession` 里把该 session 的 `queued/running` task 直接
`transitionTask(..., crashed)`。

### P6（中低）断路器把“唤醒投递失败”算成 task 失败

位置：`packages/session-manager/src/manager.ts:1146-1167` — budget 在
`await this.dispatch(...)` 之前推进。

如果 `dispatch` 抛错（agent 被释放、followup 抛异常等），task 没被 stamp，
但 streak 已经 +1。下一次 idle-edge 重试同一 task 会再 +1；`wakeLimit=3`
时，同一个 task 的 3 次投递失败就能触发 cut + 一条假通知，然后 task 被
stamp，报告反而丢了。

断路器数的是“task 结果”，不是“wake 投递尝试”。建议 dispatch 成功后再提交
budget（失败时恢复旧值）。

### P7（中低）先 watch 后 adopt 的 tracking 不会 seed

位置：

- `packages/session-manager/src/manager.ts:1412-1432` — `trackingFor` 只在
  第一次创建时从日志 seed。
- `packages/session-manager/src/manager.ts:573-590` — `watch()` 可以在 agent
  还没 live 时先建出空 tracking；`notify(when:'done')` 同理。

之后 adopt/resume 到“日志里已有 open turn”的会话，`currentTurn` 仍是
undefined；`dispatch` 把 steer task 建成 `queued`，turn/end 又因为
`task.turn` 没绑定而关不掉，最后 idle 扫成 `failed/canceled`。

复现：

```
dispatch mode/state/turn: steer queued (none)
host turn closed:         [ { state: 'failed', reason: 'canceled' } ]
```

现有 “steer adopted mid-turn” 测试没覆盖“先 watch 再 adopt”的顺序。

### P8（低/设计）断路器只覆盖 `failed/crashed`

位置：

- `packages/session-manager/src/manager.ts:739-744` — 除 `interrupted`/`error`
  外的 reason 都折成 `done`（包括 `aborted`、`blocked`、`max-tokens`）。
- `packages/session-manager/src/concierge.ts:95` — `UNSUCCESSFUL` 只有
  `failed`/`crashed`。

一个每次都被 `blocked`（例如审批一直被拒）或 `aborted` 的会话，仍会无限
ping-pong。断路器 “nothing bounded the loop” 的目标只覆盖了 crash/error
两类。要么把 `aborted`/`blocked` 也视为 non-progress，要么在文档里明确这是
有意的。

### P9（低）零碎问题

- `/watch <不存在的 id>` 会建悬空 subscription，后面 forever 计数
  （`bridge.ts:1684-1695`）；`/tail <不存在的 id>` 返回
  `(no assistant text yet)` 而不是 unknown session（`bridge.ts:1658-1666`）。
- `unwatch_session` 的 `removed` 实际是“考虑过的 key 数”，没订阅也会 +1
  （`concierge-tools.ts:328-349`）。
- 唤醒没有 in-flight `Set<taskId>`：启动扫描与 idle sweep 在极端时序下可能
  对同一 task 并发 `wakeConcierge`（`manager.ts:774-780`、
  `1099-1109`）。设计接受 rare duplicate，但 sweep 扩大了窗口。
- `resolveCwd` 的 `isAbsolute` 检查是死代码（`manager.ts:1246-1250`）。
- `wakeBudgets` 从不 prune（`manager.ts:129`）；`list()` 里
  `live.find`/`records.find` 是 O(n²)（`manager.ts:295-299`）。

## 3. 做得好的地方

- 依赖方向守得住：manager 不 import 任何 channel 包；kit 通过
  `ctx.get('sessionManager')` 可选接入；optional dsh seam 全部 duck-type
  degrade。
- R7 纪律：task 状态从日志折叠，store 只是关联表；restart rebuild 有明确
  的 honest reading。
- outbox 的 at-least-once、deferred notify、`notify_user` 的 preset fallback
  都设计得很完整。
- 未提交的闭环加固：`wakeBudgetReduce` 纯函数、per-target、cut 只通知一次、
  成功即 re-arm；`autoTurn` harness 精准钉住 listener 注册顺序；用 idle edge
  代替 timer 也符合这个包“没有 timer”的取舍。
- 文档同步意识好：设计 §15.4/§15.7、README 双语测试表、backlog 都跟着改了。

## 4. Backlog 已记录、本次确认的

- manager 配置重启会 dispose 所有 managed agent。
- `create({ workspaceId })` 没有匹配 cwd。
- idle edge 的 `queued → failed/canceled` 是启发式。
- `snapshotEvents()` 全量扫描的成本。
- provisional store copy-forward 对 subscription/outbox 的覆盖。
- steer watermark 不回收等 “small cleanups”。

## 5. 附录：两条产品场景的现状对照（讨论稿）

### 5.1 你描述的目标（2026-10-17 修正后）

1. Channel：抽象一套接口，让 DSH 在不同 channel 上做 message bridge。
2. SessionManager：manager **有自己的 session**（不是把某个 working session
   临时当 manager），但它可以管理其他 working session；manager 通过 channel
   与用户交互（绑定到某个 chat / channel 会话），管理工作会话，并在任务
   完成后回调通知。

两个场景：

- (a) 通过任意 IM（微信等）控制正在工作的 Agent、管理状态、注入“完成后
  回调通知我”的钩子。
- (b) 直接在这个 session 里，对任何没有开启的 session 下达任务。

### 5.2 现状：核心形态已实现，channel 绑定不完整

| 维度 | 你的设想（修正后） | 现在 |
|---|---|---|
| manager 身份 | manager 有自己的 session | ✅ 有：`manager:concierge` 是一个独立受管 session |
| manager 的工具 | manager session 拥有管理工具 | ✅ 有：15 个工具只挂 concierge 作用域 |
| 管理范围 | 管理非 channel 的 working session | ⚠️ 能管理，但**不区分** channel / non-channel，也无 owner scope |
| channel 绑定 | manager 绑定到某个 chat / channel，自动可达 | ⚠️ 手动 `/bind manager:concierge`；一个进程一个全局 manager；多 chat 共享 |
| 人类 IM 控制 | 支持 | ✅ `/ls /use /status /tail /stop /watch /to /new /bind` |
| 模型层控制 | 在 manager session 里说 | ✅ concierge 模型有工具 |
| 完成回调 | 任务完成 → 回调/通知 manager | ⚠️ 只对 concierge 派发的 task；固定 wake 文案；无通用 per-task hook |
| 冷/未开启 session | 可直接下任务 | ⚠️ `create_session` 可新建；`dispatch_message` 不能复活冷会话 |
| 多 chat 绑定 | 每个 chat 一个 manager（或明确的共享规则） | ❌ 多 chat 可 focus 同一个 concierge，且只有一个能收到流（P4） |

### 5.3 场景 (a)：IM 控制 working Agent + 完成回调

**已经有的：**

- 人类侧：`/ls` 列出全部 session；`/use` 切换 focus；`/status` 看运行状态、
  当前工具、todos、pending approval；`/tail` 看最后 assistant 文本；`/stop`
  取消；`/watch` 订阅 turn-end；`/to` 向指定 session 派发；`/new` 新建。
- 模型侧（仅 concierge）：`list_sessions` / `describe_session` /
  `dispatch_message` / `cancel_session` / `watch_session` / `list_tasks` /
  `tail_session` / `set_session_label` / `dispose_session`。
- 通知：manager 在 idle edge fan-out turn-end；`notify_user` 全局可用；
  C4 把 concierge 的订阅者复制到 worker，审批/追问能回到 IM。
- 回调：concierge 派发的 task 终止时，manager 会 re-awaken concierge；
  worker 自己在需要时也可以 `notify_user`。

**缺的：**

- **channel 绑定不完整**：manager 现在是一个全局单例，需要手动
  `/bind manager:concierge`；没有“每个 chat/channel 自动拥有一个 manager”
  的语义；多个 chat 绑同一个 manager 时，只有一个能收到流（P4）。
- 通用的“完成 hook”：没有给某个 worker 注入 “完成后执行这段回调/通知”
  的机制。`/watch` 是每次 turn-end 都推；`notify_user` 要求 worker 模型自己
  调用；concierge wake 是固定文案 + 固定目标 id，不能对任意 manager session
  生效。
- 权限/范围：concierge 能管理进程内所有 session（包括别的 chat 的 channel
  session），没有 “这个 manager 只管自己的 worker” 的 scope。

### 5.4 场景 (b)：在当前 session 里向未开启 session 下任务

**人类在 chat 里：**

- `/to <n> <text>` 可以派发到已有 session；`execTo` 会先 `manager.adopt`
  （`createIfMissing: false`），所以冷但已持久化的 session 可以复活。
- `/new [ws|path] [text]` 可以创建新 session 并立即派发。
- 不能对“完全不存在”的 id 直接 `/to`；需要先 `/new` 或 concierge 的
  `create_session`。

**模型在 manager session 里（concierge）：**

- `create_session` 可以创建新的 working session，并可带第一条指令；
  `dispatch_message` 可以对 live session 派发。
- 对已存在但 cold 的 session，`dispatch_message` 会失败（P2）：`dispatch`
  要求 live agent，concierge 没有 `adopt`/`resume` 工具。所以“对未开启的
  session 下任务”在模型层只覆盖“新建”和“已 live”，不覆盖“已存在但冷”。
- 在真正的 working session 里（非 manager）没有这些工具。

### 5.5 真正的差距：不是“有没有 manager session”，而是“绑定/作用域”

当前架构（核心形态已经对了）：

```
chat ──/bind + focus──> manager:concierge（自己的 session + 15 tools）
                              │  dispatch / wake
                              ▼
                    任意 session（live 或 cold）
                    （包括 channel session 和其他 chat 的会话）
```

目标形态（主要是把绑定收窄）：

```
chat <──绑定/订阅──> manager session（自己的 session，每个 chat/channel 一个）
                        │  tools: list/create/dispatch/cancel/watch/tail
                        │  per-task onComplete hook
                        ▼
              非 channel 的 working session
                        │ terminal task
                        └──> 唤醒/通知该 manager
```

所以差距不是“manager 没有自己的 session”，而是：

1. manager 目前是**全局单例 + 手动绑定**，不是“每个 channel/chat 绑定一个”；
2. manager 目前**不区分** channel / non-channel，也没有“只管自己的 worker”的 scope；
3. wake 回调硬编码 `CONCIERGE_SESSION_ID`，不能泛化到任意 manager；
4. 冷会话不能由 manager 直接 dispatch 复活；
5. 多 chat 绑同一个 manager 时，流/通知没有定义（P4）。

要落地，至少需要先定：

1. **manager 实例的粒度**：一个进程一个全局 manager，还是每个 chat/channel
   一个？如果是后者，id 怎么定、谁来创建、restart 后是否自动 live？
2. **绑定关系**：chat 的默认 focus 是 manager 吗？`/use` 切到 worker 后，
   manager 还在不在？谁负责把 chat 的订阅复制到 worker？
3. **通用唤醒**：把 `task.by`（现在是 subscriberKey）解析成 manager session；
   manager 必须 live；wake 的文案/目标要可配置。
4. **scope**：manager 只能管理自己 create/adopt 的 worker，还是整个进程？
5. **hook 语义**：`/watch` 式观察，还是 per-task 的 “完成 → 唤醒 manager
   执行回调”？

### 5.6 一句话结论（按修正后的目标）

- Channel 抽象：**已实现**，质量不错。
- “manager 有自己的 session，并能管理其他 working session”：**已实现**。
  `manager:concierge` 就是这个形态：独立 session、15 个工具、task 折叠、
  完成后 wake、回报到订阅它的 chat。
- “manager 绑定 channel”：**部分实现**。现在是一个全局 manager + 手动
  `/bind`，不是每个 chat/channel 自动绑定；多 chat 共享时流和通知没有定义
  （P4）。
- 场景 (a)：主流程（IM 里控制、看状态、派发、完成后 wake/report、审批回到
  chat）已经跑通；缺的是**通用 per-task hook**、**owner scope**、**多 chat
  绑定**。
- 场景 (b)：在 manager session 里 `create_session` + `dispatch_message`
  可用；缺的是**冷会话 resume/adopt**（P2），所以“对未开启的旧会话下任务”
  还不完整。
