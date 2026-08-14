# dsh-channel-telegram

第一个 `dsh-channel` provider：Telegram 长轮询、HTML 渲染、inline-keyboard 审批、delivery ledger、媒体收发。

> 媒体能力（design §10）：`supportsMedia = true`。入站图片经 `getFile` 下载 →
> `ctx.attachments.saveImage` → 模型可见 image 块（随 `user/message` 落日志）；其余媒体只带
> `fileRef` 事实。出站走 `sendMedia` → `sendPhoto`/`sendDocument`（`attachment` 引用或
> `cwd` 相对路径，越界拒绝）。

## 插件入口

```ts
export const name = 'dsh-channel-telegram'
export const inject = ['channels', 'agents', 'credentials']
export const Config = Schema.object({ ... })
export function apply(ctx, config) { ... }
```

dsh loader 会按模块命名导出识别 `apply` / `inject` / `Config`（本包**没有** default export）。

## 配置

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `allowedUserIds` | ✅ | 无 | 允许使用 bot 的 Telegram user id |
| `provider` | 否 | `deepseek-official` | agent 模型 provider |
| `model` | 否 | 无 | agent 模型 id |
| `cwd` | 否 | 宿主 `process.cwd()` | agent 工作目录（不设则与 Web 会话同工作区） |
| `agentPreset` | 否 | 宿主默认 preset | agent preset id；不设则 join `dsh-agent-presets` 的默认 preset（标准部署为 `standard`） |
| `pollingTimeoutSec` | 否 | `30` | Telegram 长轮询超时 |
| `mergeWindowSec` | 否 | `5` | 连发合并窗口 |
| `approvalTimeoutSec` | 否 | `120` | 审批超时 |
| `statePath` | 否 | `$DSH_HOME/channel-telegram/state.json` | 状态文件路径 |

## 装配示例

见 `cordis.patch.yml`。

## 工具供给（重要）

渠道是 seam，不是工具提供者，**自己不注册工具**；但它会在创建 agent 的 `setup` 里
**自动 join 宿主的 agent preset**（`dsh-agent-presets`）：

- 未设 `agentPreset` → join 宿主默认 preset（标准 web 部署是 `standard`），
  agent 得到与 Web 会话**完全一致**的工具/人设/技能全套能力。
- 设了 `agentPreset` → join 指定的 preset（例如 `minimal` / `code` / 你自己写的）。

因此**不要再为了"给工具"而手写 tool 插件或空掉 preset**：那会让 agent 的请求里没有
`tools`，DeepSeek 模型会把它想调用的工具写成 `<tool_calls>` XML 纯文本吐出来。出站链路
另有一道防线 `stripToolCallMarkup` 会把漏出的标记剥掉，但正确姿势是让 preset join 生效。

## 安全

- Bot token 只通过 `ctx.credentials.resolve(credentialRef('TELEGRAM_BOT_TOKEN'))` 读取，不落配置文件。
- allowlist 必填、无宽松默认。
- 审批 answerer 只答自己 agent；超时/非自己 agent 一律 `next()`，绝不默认放行。
