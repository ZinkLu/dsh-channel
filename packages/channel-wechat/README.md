# dsh-channel-wechat

`dsh-channel` 的微信（WeChat / 微信 / weixin）provider，走腾讯 **iLink Bot API**
（hermes `weixin` adapter 同款）：长轮询入站、markdown 透传、编号文本审批、delivery ledger。

> 与 Telegram provider 的区别只有两点：**transport**（`getupdates` 长轮询，无 webhook/公网地址）
> 与**能力事实**（`formatTier: 'markdown'`、`supportsEdit: false`、`supportsChoices: false`、
> `supportsTyping: true`）。merge / route / approval / prompt / ledger 全部复用 `dsh-channel-kit`，
> `dsh-channel` 与 `dsh-channel-kit` **零改动**——这正是 A5「第二平台骨架」要证明的。

## 插件入口

```ts
export const name = 'dsh-channel-wechat'
export const inject = ['channels', 'agents', 'credentials']
export const Config = Schema.object({ ... })
export function apply(ctx, config) { ... }
```

## 配置

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `allowedUserIds` | ✅ | 无 | 允许使用机器人的微信 user id（iLink 侧 `from_user_id`） |
| `accountId` | 否 | 凭据 `WECHAT_ACCOUNT_ID` | iLink bot 账号 id（自消息回环过滤用） |
| `provider` | 否 | `deepseek-official` | agent 模型 provider |
| `model` | 否 | 无 | agent 模型 id |
| `cwd` | 否 | 宿主 `process.cwd()` | agent 工作目录 |
| `agentPreset` | 否 | 宿主默认 preset | agent preset id |
| `pollingTimeoutSec` | 否 | `30` | iLink 长轮询超时 |
| `mergeWindowSec` | 否 | `5` | 连发合并窗口 |
| `approvalTimeoutSec` | 否 | `120` | 审批超时 |
| `statePath` | 否 | `$DSH_HOME/channel-wechat/state.json` | 状态文件路径 |

## 装配示例

见 `cordis.patch.yml`。凭据不落配置文件：

```bash
dsh credentials set WECHAT_TOKEN '...'        # iLink bot token
dsh credentials set WECHAT_ACCOUNT_ID '...'   # 可选：iLink bot 账号 id
```

## 能力事实（与 Telegram 的对照）

| 事实 | Telegram | WeChat |
|---|---|---|
| `formatTier` | `html` | `markdown`（微信客户端渲染 markdown，原样透传） |
| `maxMessageChars` | `4096` | `2000` |
| `supportsChoices` | `true`（inline keyboard） | `false`（审批/提问降级编号文本） |
| `supportsEdit` | `true` | `false`（微信不能编辑已发消息） |
| `supportsTyping` | `true` | `true`（iLink `sendtyping`，拿不到 ticket 时静默 no-op） |
| `streamingMode` | `progress` | `off`（无编辑能力 → 只终态投递） |

## 工具供给

与 Telegram 一致：渠道是 seam、不注册工具，创建 agent 时**自动 join 宿主默认 preset**
（`dsh-agent-presets`），`agentPreset` 可显式覆盖。详见 `dsh-channel-telegram` README。

## 安全

- `WECHAT_TOKEN` / `WECHAT_ACCOUNT_ID` 只走 `ctx.credentials.resolve`，不落配置文件。
- allowlist 必填、无宽松默认。
- 审批 answerer 只答自己 agent；超时/非自己 agent 一律 `next()`，绝不默认放行。
- 自消息回环过滤：`from_user_id === accountId` 或 `msg_type === 2`（bot 消息）直接丢弃。
- v1 不处理媒体：带媒体的消息只保留 `hasMedia` 事实（不下载、不解密 CDN），群聊 drop。
