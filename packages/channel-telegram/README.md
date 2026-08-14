# dsh-channel-telegram

第一个 `dsh-channel` provider：Telegram 长轮询、HTML 渲染、inline-keyboard 审批、delivery ledger。

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
| `cwd` | 否 | 无 | agent 工作目录 |
| `agentPreset` | 否 | 无 | agent preset |
| `pollingTimeoutSec` | 否 | `30` | Telegram 长轮询超时 |
| `mergeWindowSec` | 否 | `5` | 连发合并窗口 |
| `approvalTimeoutSec` | 否 | `120` | 审批超时 |
| `statePath` | 否 | `$DSH_HOME/channel-telegram/state.json` | 状态文件路径 |

## 装配示例

见 `cordis.patch.yml`。

## 安全

- Bot token 只通过 `ctx.credentials.resolve(credentialRef('TELEGRAM_BOT_TOKEN'))` 读取，不落配置文件。
- allowlist 必填、无宽松默认。
- 审批 answerer 只答自己 agent；超时/非自己 agent 一律 `next()`，绝不默认放行。
