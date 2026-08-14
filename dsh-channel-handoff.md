# Handoff：DSH 消息渠道公共层 + Telegram 验证

> 状态：调研待启动 · 目标框架：DeepSeek Harness (`dsh`) / Cordis 4.x
> 快照日期：2026-08-14（dsh 处于 developer preview，API 会破坏性变更）

---

## 0. 目标与边界

**做什么**

1. `dsh-channel` —— 定义包。声明 `ctx.channels` 注册表、`Channel` 抽象基类、`channel/*` 事件词汇表。**零实现。**
2. `dsh-channel-kit` —— 公共脏活层。chunk / merge / router / approval-render / store / format 六件事，**尽量写成不依赖 cordis 的纯函数**，便于独立测试和被他人采纳。
3. `dsh-channel-telegram` —— provider 实现，用于验证前两个包的抽象成立。

**不做什么**

- 不改 dsh 任何一行代码（改了就说明抽象错了）
- 不迁移已有的三个渠道插件（它们不会来适配，采纳路径是"新平台作者用"）
- 第一版不做群聊多人语义、不做语音/视频

**成功的定义**：第二个平台（Slack / 飞书 / Discord 任选）的骨架能在**不修改公共层**的前提下接上。

---

## 1. Cordis 开发范式硬约束

> 这一节是防跑偏的核心。每条都有验收动作，实现完逐条过。

### R1 一切副作用必须可逆

`apply()` 里建立的任何东西——事件监听、长轮询循环、HTTP 连接、定时器、注册项——都必须在插件卸载时归零。

```ts
export function apply(ctx: Context, config: Config) {
  const client = createClient(config)
  ctx.on('ready', () => client.start())
  ctx.on('dispose', () => client.stop())        // 副作用创建与销毁写在一起
  const dispose = ctx.channels.register(channel) // register 返回 disposer，会随 fiber 自动回收
}
```

**验收**：装载 → 卸载 → 再装载三轮，无残留连接、无重复监听、无重复消息投递。

### R2 依赖用 `inject` 声明，不要自己 new

```ts
export const inject = ['agents', 'sessions']
```

可选依赖不进 `inject`，用 `ctx.get('x')` + type-only import，并且**缺失时必须优雅降级**：

```ts
// Type-only：只为拿类型，运行期不依赖
import type {} from '@deepseek-ai/dsh-user-approval'
const approval = ctx.get('approval')   // 没有就降级
```

参照 `dsh-tools` 对 approval 的处理：没装审批插件时保持 `ask → deny` 降级，注册表照常工作。

**验收**：不装 approval 插件时插件仍能启动并正常收发，审批请求一律拒绝而不是崩溃或放行。

### R3 接口与实现分包，依赖只指向接口

| 包 | 内容 | 允许依赖 |
|---|---|---|
| `dsh-channel` | `declare module` + `abstract class Channel` + 事件词汇表 | cordis、dsh 契约包 |
| `dsh-channel-telegram` | `extends Channel` | `dsh-channel` |
| 消费方 | 只写 `ctx.channels` | **只依赖 `dsh-channel`** |

跨包依赖一律放 `peerDependencies`（+ `devDependencies` 用于测试），不要放 `dependencies`；`dependencies` 只留第三方库。

**验收**：`grep dsh-channel-telegram` 不应出现在定义包或任何消费方的 `dependencies` / `peerDependencies` 里，只能出现在 devDependencies。

### R4 契约 = 方法签名 + 事件词汇表

两者在同一个 `declare module` 块里，由定义包独占：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    channels: ChannelRegistry
  }
  interface Events {
    'channel/message': (msg: InboundMessage) => void
    'channel/deliver': (out: OutboundMessage, next: () => Promise<void>) => Promise<void>
  }
}
```

策略类扩展（限流、脱敏、审计）应该能**只监听事件**就完成，不需要实现 `Channel`。参照 `dsh-fs-observation-policy`：它不提供任何服务，纯靠 `fs/*` 事件贡献策略。

### R5 服务形态：注册表是 core，单个 channel 是 seam

渠道是**一对多**（同时接 Telegram 和飞书），所以不能用 `ctx.fs` 那种"一个 key 一个实现"：

```
ctx.channels           具体类，注册表，只有一个   → core
abstract class Channel 抽象基类，每平台一个实现   → seam
```

对照 dsh 的 `LlmRuntime`（具体类）+ 多个 adapter，形状一致。

### R6 能力差异用"能力事实"表达，不要接口分叉

平台能力天差地别（按钮、thread、富文本、长度上限）。**基类给保守默认值，实现覆盖**，消费方读这个事实决定呈现方式：

```ts
abstract class Channel extends Service {
  /** 单条消息最大字符数；undefined 表示无已知上限 */
  get maxMessageChars(): number | undefined { return undefined }
  /** 是否支持结构化选项（按钮/卡片）；false 时审批降级为编号回复 */
  get supportsChoices(): boolean { return false }
}
```

直接抄 `FileSystem.sandboxMode` 的写法。**禁止**为了某个平台的特性往接口上加只有它能实现的方法。

### R7 模型可见 = 必须入日志

渠道消息进入系统后，走 dsh 的 session 事件成为持久事实，**不要自己维护影子会话状态**。幂等靠回读日志实现，不要靠内存变量（进程重启会丢）。

参照 `nowledge-mem` 的 `hasContextBundle(agent.session)`：从会话日志倒查自己有没有注入过。

**验收**：杀进程重启后，会话能从日志完整重建；已投递的消息不重复投递。

### R8 waterfall 事件必须调 `next()`，不要夺权

拦截 `agent/pre-step`、`approval/request` 这类 waterfall 时，先把控制权交下去，拿到下游决定再在其上追加：

```ts
ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
  const decision = await next()
  if (decision.kind === 'reject' || signal.aborted) return decision
  return { kind: 'enter', messages: [...decision.messages, ...additions] }
}, { prepend: true })
```

### R9 装配点在 YAML，不在代码

配置用 schemastery 声明；`cordis.patch.yml` 用 `insert:` 插入行；`package.json` 里 `dsh.bundle.patch` 指向它。

```yaml
- insert:
    - id: channel-telegram
      name: dsh-channel-telegram
      config:
        token: !!js process.env.TELEGRAM_BOT_TOKEN
```

**凭据走 `ctx.credentials`，不要落配置文件。**

### R10 作用域

注册落在调用方 ctx 的层里，不往全局塞。这一版大概率都是全局层，但**不要写死假设**——将来某个 agent preset 可能只想开某一个渠道。

---

## 2. 调研清单

### 必读源码（照抄形状，不要自创）

| 目标 | 位置 |
|---|---|
| 定义包的标准形状 | `packages/fs/fs/src/index.ts`（abstract class + declare module + 事件） |
| provider 的标准形状 | `packages/fs/fs-local/src/index.ts` |
| 注册表 + 条目 seam | `packages/llm/llm/src/index.ts`（`LlmRuntime`）+ `llm-deepseek` |
| 纯事件旁路的最小插件 | `nowledge-co/nowledge-mem-deepseek-harness`（452 行 JS） |
| 分包依赖规矩 | `packages/fs/tool-fs/package.json` 的 peerDeps |
| 可选依赖降级 | `packages/core/tools/src/index.ts` 里 `ctx.get('approval')` 那段注释 |

### 三个既有渠道实现（重点看那六个文件，不要看整体架构）

| 仓库 | 看什么 |
|---|---|
| `LoserFox/telegram` | 最薄最干净（2078 行、零运行时依赖）。`src/client.ts` `src/bridge.ts` `src/format.ts` |
| `BiBoyang/dsh-im-bridge` | `chunk.ts` `merge.ts` `router.ts` `approval.ts` `store.ts` —— 六件脏活最全的一份 |
| `Jesse-njx/dsh-chatnode-wechat` | gateway/node 两层拆分是唯一做了服务抽象的（`ctx.wechat`），看它怎么划边界 |

### 官方文档

- `docs/cordis-tutorial/` 共 7 篇（01 first-plugin → 07 into-the-harness），**先全读完再动手**
- `docs/user/develop/framework/service.md` —— 第三方声明服务的官方范例
- `docs/cookbook/adding-a-package.md`
- `docs/architecture.md` 的 "Capability seams" 与 "Where new behavior goes" 两节

### 待核实的 API（我没逐一验证，动手前先确认）

- `ctx.agents` 的确切接口：怎么创建 agent、怎么投递输入、怎么拿到流式输出
- `session/event` 的事件 schema 与 `SessionEventMap` 的扩展方式
- `approval/request` 的完整签名与超时语义
- `ctx.sessions.fork(source, boundary?, childSessionId?)` 的适用场景
- `ctx.credentials` 的读取方式
- Telegram Bot API：单条消息长度上限、MarkdownV2 转义规则、长轮询与 webhook 的取舍、inline keyboard 用于审批的可行性

---

## 3. 六件脏活的设计要点

这是公共层的全部价值所在。三个独立实现收敛到同一组文件名，说明这是问题的固有形状。

| 模块 | 要解决的问题 | 关键取舍 |
|---|---|---|
| **chunk** | 一条 8000 字回复怎么切 | 不能切断代码块和链接；要不要加"(1/3)"序号；流式边出边发 vs 等终态一次发 |
| **merge** | 用户连发三条怎么办 | 去抖窗口时长；合并成一次输入 vs 分别唤醒 agent；用户在 agent 思考中途插话怎么处理 |
| **router** | 平台的 chat/user → 哪个 session | 新建还是续接；会话生命周期与过期；群聊里 @机器人 的语义；一个用户多设备 |
| **approval** | 无按钮渠道怎么表达审批 | 降级为编号回复（"回复 1 批准 / 2 拒绝"）；超时策略；**默认必须是 deny，绝不能默认放行** |
| **store** | 去重与断点 | 平台会重发消息 → 需要幂等键；已投递水位；崩溃恢复。**优先从 session log 推导，不要另建状态** |
| **format** | Markdown → 平台富文本 | 代码块、表格、链接的降级；转义；不支持的元素怎么退化成纯文本 |

**设计原则**：这六个尽量做成纯函数（输入 → 输出，无 IO），`Channel` 实现只负责"收一条""发一条"和报告能力事实。这样公共层可测试、可被不用 cordis 的人复用。

---

## 4. 验收标准

| # | 检查 | 通过条件 |
|---|---|---|
| A1 | 装-卸-装三轮 | 无残留连接、无重复监听、无重复投递 |
| A2 | 依赖方向 | provider 包名不出现在定义包/消费方的 deps 与 peerDeps |
| A3 | 可选依赖降级 | 不装 approval 插件仍能跑，审批全部拒绝 |
| A4 | 持久化 | 杀进程重启后会话可从日志重建，消息不重复 |
| A5 | **抽象成立性** | 第二平台骨架接入时，`dsh-channel` 与 `dsh-channel-kit` 零改动 |
| A6 | 纯函数覆盖 | 六件脏活各有单测，不需要起 dsh 就能跑 |

A5 是最重要的一条。**在写 Telegram 的同时，就把第二个平台的接口调用列一遍**，别等做完才发现抽象漏了。

---

## 5. 里程碑

| 阶段 | 产出 | 出口判据 |
|---|---|---|
| M0 调研 | 读完 cordis-tutorial 7 篇 + 三个既有实现的六个文件；补齐"待核实 API" | 能口述 fs seam 的三包关系 |
| M1 定义包 | `dsh-channel`：抽象类 + 事件 + 能力事实 | 空实现能装载、能卸载干净 |
| M2 kit | 六件脏活的纯函数 + 单测 | A6 |
| M3 provider | `dsh-channel-telegram` 端到端跑通 | A1 A3 A4 |
| M4 抽象验证 | 第二平台骨架 | A5 |
| M5 发布 | npm + `dsh-plugin` topic + 提 PR 进 awesome 列表 | —— |

---

## 6. 风险

| 风险 | 应对 |
|---|---|
| dsh 是 developer preview，API 会破坏性变更 | peerDeps 用收窄的版本范围；关注 Discussions（**该仓库 issue 是关闭的**） |
| 生态窗口极短（两天 129 个插件） | M1–M3 尽快出可用版本，别在抽象上过度打磨 |
| 存量三家不会来适配 | 采纳路径是"新平台作者用"，所以文档和模板比功能更重要 |
| 抽象错了 = 需要改 dsh | 一旦发现必须改 dsh 才能实现，停下来重新设计 |
| 凭据泄漏 | token 只走 `ctx.credentials` 与环境变量，不进配置文件、不进日志 |

---

## 7. 参考链接

- dsh 主仓库：https://github.com/deepseek-ai/deepseek-harness
- Cordis：https://github.com/cordiverse/cordis
- Cordis 论文：https://github.com/cordiverse/paper （88 页，第 1.2 节与第 3 章足够）
- 插件索引：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
- 参考实现：
  - https://github.com/LoserFox/telegram
  - https://github.com/BiBoyang/dsh-im-bridge
  - https://github.com/Jesse-njx/dsh-chatnode-wechat
  - https://github.com/nowledge-co/nowledge-mem-deepseek-harness

---

## 附：跑偏的五个信号

出现任何一个，停下来重新看第 1 节。

1. 为了实现某个功能，需要改 dsh 的代码
2. 消费方的 `package.json` 里出现了某个具体平台的包名
3. `Channel` 抽象类上出现了只有一个平台能实现的方法
4. 插件卸载后还有连接活着，或者重新装载会重复投递
5. 用内存变量而不是 session log 判断"这条消息处理过没有"

