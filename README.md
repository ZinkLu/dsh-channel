# dsh-channel

[English](#english) · [中文](#中文)

---

<a name="english"></a>
## English

The message-channel common layer for DeepSeek Harness (dsh) plus multiple provider implementations (Telegram / WeChat / Feishu / …, with more added continuously in this repo).

Split into six packages per [dsh-channel-design.md](./dsh-channel-design.md).

For the alignment baseline against dsh's own core/seam, see [docs/dsh-core-reference.md](./docs/dsh-core-reference.md)
(full ctx seam/core table + core packages + lifecycle + tool pipeline + session log, checked line-by-line
against the rc.6 source), and [docs/dsh-core-alignment-audit.md](./docs/dsh-core-alignment-audit.md)
(point-by-point verification of the design doc against the dsh API).

| Package | Directory | Description |
|---|---|---|
| `dsh-channel` | `packages/channel` | Contract package: `ctx.channels` registry (multi-account via `accountId`), `Channel` abstract base class, `channel/*` event vocabulary, `MessageSourceMap.channel` merging, proactive-push binding (`chatKeyOf`) |
| `dsh-channel-kit` | `packages/channel-kit` | Pure-function library: chunk / merge / router / approval-render / store / format / prompt-render / stream / deliver-queue (retry + backpressure) / media-limit / http-proxy (outbound proxy transport) |
| `dsh-channel-config` | `packages/channel-config` | Shared channel configuration: agent-routing/behavior/allowlist schema constructors, credential refs, and settings namespaces |
| `dsh-channel-telegram` | `packages/channel-telegram` | First provider: Telegram long polling, HTML rendering, inline-keyboard approval, delivery ledger, reactions, inbound media size cap, reply/thread/silent delivery |
| `dsh-channel-wechat` | `packages/channel-wechat` | WeChat (iLink Bot API): long polling, markdown pass-through, numbered-text approval |
| `dsh-channel-feishu` | `packages/channel-feishu` | Feishu / Lark: long-lived (WebSocket) inbound, plain-text rendering, numbered-text approval, reply (thread) delivery |

---

### Quick start

```bash
npm install          # install workspace dependencies
npm run build -ws    # build all six packages into each package's lib/
npm run test -ws     # run all tests
npm run typecheck -ws
```

You can also operate on a single package:

```bash
npm run build -w dsh-channel-kit
npm run test -w dsh-channel-telegram
npm run test -w dsh-channel-wechat
npm run test -w dsh-channel-feishu
```

---

### Wiring the Telegram channel into dsh

1. Make sure the dsh host is configured (the standard `web` profile has everything out of the box, no extra action needed):

   - `ctx.agents` / agent loop (`@deepseek-ai/dsh-agent-loop`)
   - `ctx.credentials` (`@deepseek-ai/dsh-credentials-local`)
   - `ctx.llm` and the corresponding model adapter
   - agent preset (`@deepseek-ai/dsh-agent-presets`): standard web deployments default to `standard`.
     When the Telegram channel creates an agent it **automatically joins the host's default preset**, so the
     full tool/persona/skill capability set matches a Web session — no need to configure tools by hand, and
     don't hand-write a tool plugin just to "give it tools".

2. Install this repo's packages (or use the npm names after publishing; WeChat/Feishu follow the same pattern with
   `dsh-channel-wechat` / `dsh-channel-feishu` respectively — see each package's `cordis.patch.yml` for wiring):

   ```bash
   # in your dsh profile
   pnpm add dsh-channel dsh-channel-kit dsh-channel-telegram
   ```

3. Merge the contents of `packages/channel-telegram/cordis.patch.yml` into your profile's
   `cordis.patch.yml` (or use `dsh --patch ./packages/channel-telegram/cordis.patch.yml`):

   ```yaml
   - insert:
       - id: channel
         name: dsh-channel
   - insert:
       - id: channel-telegram
         name: dsh-channel-telegram
         config:
           allowedUserIds: [5002186681]   # replace with your Telegram user id
           provider: deepseek-official
           model: deepseek-v4-flash
           # cwd / agentPreset unset: use process.cwd() workspace + host default preset
   ```

4. Configure the Telegram Bot Token (**don't put it in the config file**):

   ```bash
   export TELEGRAM_BOT_TOKEN='...'          # process env, takes effect on start
   # or hot-swap at runtime:
   dsh credentials set TELEGRAM_BOT_TOKEN '...'
   ```

   The plugin re-resolves `ctx.credentials.resolve('TELEGRAM_BOT_TOKEN')` before every API call;
   `dsh-credentials-local` hot-publishes `.credentials.yaml` changes, so swapping the token at runtime
   needs no restart.

5. Start dsh and send a message to your bot. By default only `direct` private chats are allowed; group chats are dropped in v1.

---

### Local debugging (echo bot, no model)

The repo ships a dev echo bot for verifying the Telegram send/receive path without a full dsh host:

```bash
npm run build -ws
TELEGRAM_BOT_TOKEN='...' node scripts/run-echo-bot.mjs
```

It loads `dsh-channel` + `dsh-agent` + `dsh-credentials-local` + `dsh-channel-telegram`, and substitutes an echo factory for the real agent loop. Ordinary messages are replied with `[echo mode] You said: ...`; local commands (`/help`, `/start`, etc.) work.

---

### Test coverage

| Package | Tests | Coverage |
|---|---|---|
| `dsh-channel` | 14 | register/unregister, duplicate-registration rejection (incl. `(id, accountId)`), deliver default, waterfall observation and short-circuit, event broadcast, `supportsReactions`/`react`, multi-account registry + `chatKeyOf`/`bindChatKey`, capability-fact defaults (`supportsReply`/`supportsThreads`/`supportsSilent`/`supportsReconciliation`) |
| `dsh-channel-config` | 6 | shared schema defaults/required/union across telegram/wechat/feishu, numeric vs string allowlist element types, `maxInboundMediaBytes` default/override, `accountId`/`proxyUrl` shared behavior fields, `platformAccountId` (WeChat) |
| `dsh-channel-kit` | 84 | chunk fence padding/prefix convergence, merge three iron rules and `..`/`!!`, router decision table (incl. multi-account session ids), approval numbering/timeout, store state machine and JSON file, format three-tier degradation and `<tool_calls>`/reasoning sanitization, prompt-render options/multi-select/free-text, tool-display, stream reducer, deliver-queue retry/backoff/spacing/backpressure, media size guard, http-proxy (CONNECT tunnel + absolute-form + multipart) |
| `dsh-channel-telegram` | 27 | Telegram API calls and redaction, HTML-failure fallback to plain text, inbound routing/merge/delivery, allowlist, approval answerer timeout `next()`, `<tool_calls>` leak interception, agent preset join, progress draft, user-questions provider, settings namespace registration, inbound media size cap (streaming + Content-Length), `getMe`/`setMessageReaction`, group `mentionsBot` observation, ack-long reaction, reply/thread/silent send options, inbound `replyToMessageId`, recovery reconciliation |
| `dsh-channel-wechat` | 5 | iLink getupdates/sendmessage calls and redaction, context_token echo, inbound routing/merge/delivery, allowlist |
| `dsh-channel-feishu` | 15 | tenant_access_token cache, sendMessage receive_id_type parsing, protobuf frame encode/decode, inbound event routing/delivery, allowlist, `createReaction`/`react`, `replyMessage`/`supportsReply`, inbound `replyToMessageId` (`parent_id`) |

---

### Directory structure

```
.
├── packages/
│   ├── channel/          # dsh-channel (contract)
│   ├── channel-kit/      # dsh-channel-kit (pure-function library)
│   ├── channel-config/   # dsh-channel-config (shared config schemas)
│   ├── channel-telegram/ # dsh-channel-telegram
│   ├── channel-wechat/   # dsh-channel-wechat (WeChat iLink Bot API)
│   └── channel-feishu/   # dsh-channel-feishu (Feishu / Lark long-lived connection)
├── scripts/
│   └── run-echo-bot.mjs  # local debug echo bot
├── dsh-channel-design.md
├── tsconfig.base.json
└── package.json
```

---

### Notes

- Media capability (design §10) is implemented in the contract: `InboundMedia`/`OutboundMedia`/`supportsMedia`/`sendMedia`. Telegram `supportsMedia=true` (inbound images `getFile`→`ctx.attachments.saveImage`→model-visible image block; outbound `sendPhoto`/`sendDocument`); WeChat/Feishu `supportsMedia=false`, inbound only carries the `fileRef` fact (no byte download).
- Inbound media size cap: `maxInboundMediaBytes` (shared config, default 20 MiB) is enforced by Telegram's `getFile` — it checks `Content-Length` then the running byte count and aborts *before* an oversized body is fully buffered (kit `assertMediaWithinLimit`).
- Outbound resilience: every provider routes ledger-tracked sends through a per-chatKey `deliver-queue` (kit reducer) — one serial worker, generic retry with exponential backoff (3 retries, 1/2/4s), and queue-full backpressure. The queue decides *when* to call `deliver()`; the `channel/deliver` waterfall still decides *what happens*.
- Reactions (cheap ack): `Channel.supportsReactions`/`react()`. Telegram (via `setMessageReaction`) and Feishu (via `message_reaction.create`) support it; a long-message `ack-long` now reacts instead of sending a `Received, working on it…` text (falling back to text when unsupported or on failure). WeChat has no reaction API.
- `mentionsBot` is now observed: Telegram inspects `entities` (`text_mention`/`mention`) against its own `getMe` identity; Feishu reads `mentions`. WeChat's iLink payload carries no mention metadata, so it stays `false`. Still observational — v1 does not route group chats.
- Multi-account (M8): `Channel.accountId` (default `'default'`) + the registry keys entries by `(id, accountId)`, so two bots of the same platform can coexist. Session ids gain a `:<accountId>` segment only for non-default accounts (`channel:telegram:prod:<chatKey>`), keeping single-account ids byte-for-byte unchanged. Set `accountId` in a provider's config (shared behavior field).
- Proactive push (M8): `ctx.channels.bindChatKey()`/`chatKeyOf(sessionId)` expose the sessionId → `{ channel, accountId?, chatKey }` binding registry-wide, so a monitor/reminder plugin can `deliver()` with no preceding inbound message.
- Delivery reconciliation (M8): `Channel.supportsReconciliation`/`reconcile(chatKey, deliveryKey, textHash)` lets a provider confirm a prior send before a blind resend on recovery; the default returns `'unknown'` (graceful absence), preserving the existing "resumed resend" marker. No current provider implements a platform-side query (Telegram's Bot API has no sent-message lookup), so the seam is in place and recovery still falls back safely.
- Reply / thread / silent (M9): `InboundMessage.replyToMessageId`, `OutboundMessage.replyTo`/`threadId`/`silent`, and `supportsReply`/`supportsThreads`/`supportsSilent`. Telegram implements reply (`reply_parameters`) and silent (`disable_notification`); Feishu implements reply (`replyMessage`, inbound `parent_id`); threads stay capability-fact-only until a provider emits `chatType: 'thread'`. Status lines (`⏹ Turn ended: …`) send silently on platforms that support it.
- Interactive login + proxy (M10): the contract exports a sibling `ChannelLogin` interface (QR/OAuth device flow, CLI-only) — no current provider needs it (static tokens). `proxyUrl` (shared behavior field) threads into each provider client's `fetch` via the kit's `proxiedFetch` (CONNECT tunnel for HTTPS, absolute-form for HTTP), so the Telegram/Feishu APIs can be reached through an outbound proxy.
- v1 does not route group chats (`chatType !== 'direct'` is dropped directly).
- The outbound delivery ledger lives in `state.json`; the in-memory `ChannelStore` implementation is available for tests.
- Dependency direction: each provider (`dsh-channel-telegram` / `-wechat` / `-feishu`) depends only on `dsh-channel` + `dsh-channel-kit` + `dsh-channel-config`; policy plugins depend only on `dsh-channel`.
- Each provider registers its config as a dsh `settings` namespace (`channel-telegram` / `channel-wechat` / `channel-feishu`) via `installSettingsSection`; the resolved value layers schema defaults < composition config < user document, and bridges read config through a dynamic `source()` (live fields take effect without restart; `statePath` is restart-only). Secrets stay in `ctx.credentials` (never in the settings document). See [dsh-channel-design.md §11](./dsh-channel-design.md#11-configuration-and-settings-seam). Note: rc.6's apiproxy only exposes a hardcoded `WEB_SETTINGS_NAMESPACES` allowlist, so `channel-*` namespaces do not yet appear in the web UI — `settings-file` still persists the document and the CLI can read it; exposing plugin namespaces is deferred upstream (this repo does not patch dsh core).
- Capability differences only go through "capability facts + degradation": Telegram `html`+buttons+progress+reactions, WeChat `markdown`+typing+off, Feishu `plain`+off+reactions — `dsh-channel`/`dsh-channel-kit` hold the shared facts (`supportsReactions`/`react`), providers only fill them in (A5 verified).

---

<a name="中文"></a>
## 中文

DeepSeek Harness (dsh) 的消息渠道公共层与多个 provider 实现（Telegram / 微信 / 飞书 / …，本仓库持续新增）。

按照 [dsh-channel-design.md](./dsh-channel-design.md) 拆为六个包。

对 dsh 本身核心/seam 的对齐基线，见 [docs/dsh-core-reference.md](./docs/dsh-core-reference.md)
（ctx seam/core 全表 + 核心包 + 生命周期 + 工具流水线 + 会话日志，逐条对照 rc.6 源码），
以及 [docs/dsh-core-alignment-audit.md](./docs/dsh-core-alignment-audit.md)（设计文档对 dsh API
的逐条核对结果）。

| 包 | 目录 | 说明 |
|---|---|---|
| `dsh-channel` | `packages/channel` | 契约包：`ctx.channels` 注册表（`accountId` 多账号）、`Channel` 抽象基类、`channel/*` 事件词汇表、`MessageSourceMap.channel` 归并、主动推送绑定（`chatKeyOf`） |
| `dsh-channel-kit` | `packages/channel-kit` | 纯函数库：chunk / merge / router / approval-render / store / format / prompt-render / stream / deliver-queue（重试 + 背压）/ media-limit / http-proxy（出站代理传输） |
| `dsh-channel-config` | `packages/channel-config` | 共享渠道配置：agent 路由/行为/allowlist schema 构造器、凭证 ref、settings 命名空间 |
| `dsh-channel-telegram` | `packages/channel-telegram` | 第一个 provider：Telegram 长轮询、HTML 渲染、inline-keyboard 审批、delivery ledger、表情回应、入站媒体大小上限、回复/静默投递 |
| `dsh-channel-wechat` | `packages/channel-wechat` | 微信（iLink Bot API）：长轮询、markdown 透传、编号文本审批 |
| `dsh-channel-feishu` | `packages/channel-feishu` | 飞书 / Lark：长连接（WebSocket）入站、纯文本渲染、编号文本审批、回复（话题）投递 |

---

### 快速开始

```bash
npm install          # 安装 workspace 依赖
npm run build -ws    # 构建六个包到各包 lib/
npm run test -ws     # 运行全部测试
npm run typecheck -ws
```

也可以单独操作某个包：

```bash
npm run build -w dsh-channel-kit
npm run test -w dsh-channel-telegram
npm run test -w dsh-channel-wechat
npm run test -w dsh-channel-feishu
```

---

### 在 dsh 中装配 Telegram 渠道

1. 确保 dsh 宿主已配置（标准 `web` profile 天生齐备，无需额外动作）：

   - `ctx.agents` / agent loop（`@deepseek-ai/dsh-agent-loop`）
   - `ctx.credentials`（`@deepseek-ai/dsh-credentials-local`）
   - `ctx.llm` 及对应模型适配器
   - agent preset（`@deepseek-ai/dsh-agent-presets`）：标准 web 部署默认 `standard`。
     Telegram 渠道创建 agent 时会**自动 join 宿主默认 preset**，所以工具/人设/技能
     全套能力与 Web 会话一致——无需手动配工具，也不要为了"给工具"而手写 tool 插件。

2. 安装本仓库对应包（或发布后使用 npm 名；微信/飞书同理，分别用
   `dsh-channel-wechat` / `dsh-channel-feishu`，装配见各自包内 `cordis.patch.yml`）：

   ```bash
   # 在 dsh profile 中
   pnpm add dsh-channel dsh-channel-kit dsh-channel-telegram
   ```

3. 把 `packages/channel-telegram/cordis.patch.yml` 的内容合并到 profile 的
   `cordis.patch.yml`（或使用 `dsh --patch ./packages/channel-telegram/cordis.patch.yml`）：

   ```yaml
   - insert:
       - id: channel
         name: dsh-channel
   - insert:
       - id: channel-telegram
         name: dsh-channel-telegram
         config:
           allowedUserIds: [5002186681]   # 替换为你的 Telegram user id
           provider: deepseek-official
           model: deepseek-v4-flash
           # cwd / agentPreset 不设：沿用 process.cwd() 工作区 + 宿主默认 preset
   ```

4. 配置 Telegram Bot Token（**不要写进配置文件**）：

   ```bash
   export TELEGRAM_BOT_TOKEN='...'          # 进程环境，启动时生效
   # 或运行中热替换：
   dsh credentials set TELEGRAM_BOT_TOKEN '...'
   ```

   插件每次 API 调用前都会重新 `ctx.credentials.resolve('TELEGRAM_BOT_TOKEN')`，
   `dsh-credentials-local` 会热发布 `.credentials.yaml` 的变更，因此运行中换 token
   不需要重启进程。

5. 启动 dsh 后，向你的 bot 发消息即可。默认只允许 `direct` 私聊；群聊在 v1 直接 drop。

---

### 本地调试（echo bot，不接模型）

仓库自带一个开发用 echo bot，用于不依赖完整 dsh 宿主时验证 Telegram 收发链路：

```bash
npm run build -ws
TELEGRAM_BOT_TOKEN='...' node scripts/run-echo-bot.mjs
```

它会加载 `dsh-channel` + `dsh-agent` + `dsh-credentials-local` + `dsh-channel-telegram`，
并用一个 echo factory 代替真实 agent loop。普通消息会回复 `[echo mode] You said: ...`
（即"[echo 模式] 你说：…"），本地命令（`/help`、`/start` 等）可用。

---

### 测试覆盖

| 包 | 测试数 | 覆盖点 |
|---|---|---|
| `dsh-channel` | 14 | 注册/卸载、重复注册拒绝（含 `(id, accountId)`）、deliver 缺省、waterfall 观察与短路、事件广播、`supportsReactions`/`react`、多账号注册表 + `chatKeyOf`/`bindChatKey`、能力事实缺省（`supportsReply`/`supportsThreads`/`supportsSilent`/`supportsReconciliation`） |
| `dsh-channel-config` | 6 | telegram/wechat/feishu 共享 schema 的默认值/必填/枚举、数字 vs 字符串 allowlist 元素类型、`maxInboundMediaBytes` 默认/覆盖、`accountId`/`proxyUrl` 共享行为字段、`platformAccountId`（微信） |
| `dsh-channel-kit` | 84 | chunk 围栏补齐/前缀收敛、merge 三铁律与 `..`/`!!`、router 决策表（含多账号会话 id）、approval 编号/超时、store 状态机与 JSON 文件、format 三档降级与 `<tool_calls>`/reasoning 净化、prompt-render 选项/多选/自由文本、tool-display、stream reducer、deliver-queue 重试/退避/间隔/背压、媒体大小守卫、http-proxy（CONNECT 隧道 + absolute-form + multipart） |
| `dsh-channel-telegram` | 27 | Telegram API 调用与脱敏、HTML 失败降级纯文本、入站路由/merge/投递、allowlist、审批 answerer 超时 `next()`、`<tool_calls>` 泄漏拦截、agent preset join、progress 草稿、user-questions provider、settings 命名空间注册、入站媒体大小上限（流式 + Content-Length）、`getMe`/`setMessageReaction`、群聊 `mentionsBot` 观察、ack-long 表情回应、回复/话题/静默发送选项、入站 `replyToMessageId`、恢复对账 |
| `dsh-channel-wechat` | 5 | iLink getupdates/sendmessage 调用与脱敏、context_token 回显、入站路由/merge/投递、allowlist |
| `dsh-channel-feishu` | 15 | tenant_access_token 缓存、sendMessage receive_id_type 解析、protobuf 帧编解码、入站事件路由/投递、allowlist、`createReaction`/`react`、`replyMessage`/`supportsReply`、入站 `replyToMessageId`（`parent_id`） |

---

### 目录结构

```
.
├── packages/
│   ├── channel/          # dsh-channel（契约）
│   ├── channel-kit/      # dsh-channel-kit（纯函数库）
│   ├── channel-config/   # dsh-channel-config（共享配置 schema）
│   ├── channel-telegram/ # dsh-channel-telegram
│   ├── channel-wechat/   # dsh-channel-wechat（微信 iLink Bot API）
│   └── channel-feishu/   # dsh-channel-feishu（飞书 / Lark 长连接）
├── scripts/
│   └── run-echo-bot.mjs  # 本地调试 echo bot
├── dsh-channel-design.md
├── tsconfig.base.json
└── package.json
```

---

### 注意事项

- 媒体能力（design §10）已落地契约：`InboundMedia`/`OutboundMedia`/`supportsMedia`/`sendMedia`。Telegram `supportsMedia=true`（入站图片 `getFile`→`ctx.attachments.saveImage`→模型可见 image 块；出站 `sendPhoto`/`sendDocument`）；WeChat/Feishu `supportsMedia=false`，入站只带 `fileRef` 事实（不下载字节）。
- 入站媒体大小上限：`maxInboundMediaBytes`（共享配置，默认 20 MiB）由 Telegram 的 `getFile` 强制——先查 `Content-Length`，再累计读取字节数，在超大 payload 被完整缓冲**之前**中止（kit 的 `assertMediaWithinLimit`）。
- 出站韧性：每个 provider 把走 ledger 的发送都经由 per-chatKey 的 `deliver-queue`（kit reducer）——单串行 worker、通用重试（指数退避 3 次，1/2/4s）、队列满背压。队列决定**何时**调用 `deliver()`；`channel/deliver` waterfall 仍决定**这次尝试发生什么**。
- 表情回应（廉价 ack）：`Channel.supportsReactions`/`react()`。Telegram（`setMessageReaction`）与 Feishu（`message_reaction.create`）支持；长消息的 `ack-long` 现在改为回表情而非发 `Received, working on it…`（不支持或失败时降级回文本）。WeChat 无表情 API。
- `mentionsBot` 现为真实观察：Telegram 对照自身 `getMe` 身份扫描 `entities`（`text_mention`/`mention`）；Feishu 读 `mentions`。WeChat 的 iLink payload 无 @ 元数据，保持 `false`。仍是纯观察——v1 不路由群聊。
- 多账号（M8）：`Channel.accountId`（默认 `'default'`）+ 注册表按 `(id, accountId)` 建键，因此同一平台的两个 bot 可共存。会话 id 仅在非默认账号时追加 `:<accountId>` 段（`channel:telegram:prod:<chatKey>`），单账号会话 id 逐字节不变。在 provider 配置里设 `accountId`（共享行为字段）。
- 主动推送（M8）：`ctx.channels.bindChatKey()`/`chatKeyOf(sessionId)` 把 sessionId → `{ channel, accountId?, chatKey }` 绑定暴露为注册表级，监控/提醒插件无需前置入站消息即可 `deliver()`。
- 投递对账（M8）：`Channel.supportsReconciliation`/`reconcile(chatKey, deliveryKey, textHash)` 让 provider 在恢复重发前先向平台确认；默认返回 `'unknown'`（优雅缺省），保留现有 "resumed resend" 标记。当前没有 provider 实现平台侧查询（Telegram Bot API 无已发消息查询），seam 已就位、恢复仍安全回退。
- 回复 / 话题 / 静默（M9）：`InboundMessage.replyToMessageId`、`OutboundMessage.replyTo`/`threadId`/`silent`，及 `supportsReply`/`supportsThreads`/`supportsSilent`。Telegram 实现回复（`reply_parameters`）与静默（`disable_notification`）；Feishu 实现回复（`replyMessage`、入站 `parent_id`）；话题在 provider 真正发出 `chatType: 'thread'` 前保持能力事实级别。状态行（`⏹ Turn ended: …`）在支持的平台上静默发送。
- 交互式登录 + 代理（M10）：契约导出兄弟接口 `ChannelLogin`（QR/OAuth device flow，仅供 CLI）——三个 provider 均用静态 token，无需实现。`proxyUrl`（共享行为字段）经 kit 的 `proxiedFetch`（HTTPS 走 CONNECT 隧道、HTTP 走 absolute-form）接入各 provider client 的 `fetch`，使 Telegram/Feishu API 可经出站代理访问。
- v1 不路由群聊（`chatType !== 'direct'` 直接 drop）。
- 出站 delivery ledger 存在 `state.json` 中；进程内 `ChannelStore` 纯内存实现可用于测试。
- 依赖方向：每个 provider（`dsh-channel-telegram` / `-wechat` / `-feishu`）只依赖 `dsh-channel` + `dsh-channel-kit` + `dsh-channel-config`；策略插件只依赖 `dsh-channel`。
- 每个 provider 通过 `installSettingsSection` 把配置注册为 dsh 的 `settings` 命名空间（`channel-telegram` / `channel-wechat` / `channel-feishu`）；解析值 = schema 默认值 < 组合配置 < 用户文档，bridge 经动态 `source()` 读配置（可热生效的字段 getter 化，无需重启；`statePath` 需重启）。secret 仍走 `ctx.credentials`（永不进 settings 文档）。见 [dsh-channel-design.md §11](./dsh-channel-design.md#11-configuration-and-settings-seam)。注意：rc.6 的 apiproxy 只暴露写死的 `WEB_SETTINGS_NAMESPACES` 白名单，`channel-*` 命名空间目前**不会**出现在 web UI——`settings-file` 仍会落盘文档、CLI 可读；插件命名空间的暴露是上游 deferred，本仓库不 patch dsh core。
- 能力差异只走「能力事实 + 降级」：Telegram `html`+按钮+progress+表情、WeChat `markdown`+typing+off、Feishu `plain`+off+表情——`dsh-channel`/`dsh-channel-kit` 承载共享事实（`supportsReactions`/`react`），provider 只填充（A5 验证）。
