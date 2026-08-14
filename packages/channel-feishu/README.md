# dsh-channel-feishu

`dsh-channel` 的飞书 / Lark provider，走 Open API 发送 + **长连接（WebSocket）模式**入站
（openclaw / mimiclaw / ironclaw 同款），无需公网地址、无需 webhook。

> 与 Telegram/WeChat 的差异只有 transport 与能力事实：`formatTier: 'plain'`（飞书 text 消息
> 是纯文本）、`supportsChoices: false`（v1 不做交互式卡片）、`supportsTyping: false`（bot 无
> typing）、`supportsEdit: false`（v1 不做草稿流式）。merge / route / approval / prompt / ledger
> 全部复用 `dsh-channel-kit`，`dsh-channel` 与 `dsh-channel-kit` **零改动**（A5）。

## 插件入口

```ts
export const name = 'dsh-channel-feishu'
export const inject = ['channels', 'agents', 'credentials']
export const Config = Schema.object({ ... })
export function apply(ctx, config) { ... }
```

## 配置

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `allowedUserIds` | ✅ | 无 | 允许使用机器人的飞书用户 `open_id`（`ou_` 开头） |
| `domain` | 否 | `feishu` | `feishu`（飞书）或 `lark`（Lark 国际版） |
| `provider` | 否 | `deepseek-official` | agent 模型 provider |
| `model` | 否 | 无 | agent 模型 id |
| `cwd` | 否 | 宿主 `process.cwd()` | agent 工作目录 |
| `agentPreset` | 否 | 宿主默认 preset | agent preset id |
| `mergeWindowSec` | 否 | `5` | 连发合并窗口 |
| `approvalTimeoutSec` | 否 | `120` | 审批超时 |
| `statePath` | 否 | `$DSH_HOME/channel-feishu/state.json` | 状态文件路径 |

## 凭据与开通

1. 在[飞书开放平台](https://open.feishu.cn/)创建自建应用，拿 **App ID / App Secret**。
2. 开通权限：`im:message`、`im:message:send_as_bot`（收发消息）。
3. 事件订阅选**长连接模式**，订阅 `im.message.receive_v1`。
4. 凭据只走 `ctx.credentials`，不落配置文件：

```bash
dsh credentials set FEISHU_APP_ID 'cli_xxx'
dsh credentials set FEISHU_APP_SECRET 'xxx'
```

## 能力事实（三平台对照）

| 事实 | Telegram | WeChat | Feishu |
|---|---|---|---|
| `formatTier` | `html` | `markdown` | `plain` |
| `maxMessageChars` | `4096` | `2000` | `4096` |
| `supportsChoices` | `true` | `false` | `false` |
| `supportsEdit` | `true` | `false` | `false` |
| `supportsTyping` | `true` | `true` | `false` |
| `streamingMode` | `progress` | `off` | `off` |

## 长连接 vs webhook

本包默认**长连接模式**（`POST /callback/ws/endpoint` 拿 wss 地址 + protobuf 信封收发），
进程直接与飞书建立持久连接。若宿主已经有 HTTP 服务想走 webhook，可复用本包的
`bridge.handleEvent(event)` 作为事件入口（它同时是长连接 client 的内部回调），
`dsh-channel` / `dsh-channel-kit` 不动。

## 工具供给

与 Telegram 一致：渠道是 seam、不注册工具，创建 agent 时**自动 join 宿主默认 preset**。

## 安全

- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 只走 `ctx.credentials.resolve`，不落配置文件。
- allowlist 必填、无宽松默认（open_id 是提示注入前门）。
- 审批 answerer 只答自己 agent；超时/非自己 agent 一律 `next()`，绝不默认放行。
- v1 只处理 `text` 消息，非文本只保留 `hasMedia` 事实；群聊（`chat_type=group`）drop。
