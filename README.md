# dsh-channel

[English](#english) · [中文](#中文)

---

<a name="english"></a>
## English

The message-channel common layer for DeepSeek Harness (dsh) plus a channel-agnostic session manager and multiple provider implementations (Telegram / WeChat / Feishu / …, with more added continuously in this repo).

Split into six packages per [dsh-channel-design.md](./dsh-channel-design.md).

For the alignment baseline against dsh's own core/seam, see [docs/dsh-core-reference.md](./docs/dsh-core-reference.md)
(full ctx seam/core table + core packages + lifecycle + tool pipeline + session log, checked line-by-line
against the 0.2.0-rc.2 source). What is deliberately *not* built — open questions, deferred work with its
trigger, and designs considered and rejected — is in
[docs/dsh-channel-backlog.md](./docs/dsh-channel-backlog.md).

Those three plus this file are the documentation set: our design, the implementation as shipped,
and the roadmap/backlog. Completed process documents are kept in git history, not in the tree.

| Package | Directory | Description |
|---|---|---|
| `dsh-channel` | `packages/channel` | Contract package: `ctx.channels` registry (multi-account via `accountId`), `Channel` abstract base class, `channel/*` event vocabulary, `MessageSourceMap.channel` merging, proactive-push binding (`chatKeyOf`) |
| `dsh-session-manager` | `packages/session-manager` | Channel-agnostic session layer (design §14): `ctx.sessionManager` service — managed-session registry over `ctx.agents`/`sessionQuery`/`workspaceRegistry`, dispatch tasks folded from the session log's `turn/start`/`turn/end`, subscriptions + a durable ack'd notification outbox, and the global `notify_user` tool. Depends on no channel package |
| `dsh-channel-kit` | `packages/channel-kit` | `ChannelBridge`, the shared handler (inbound pipeline, session-event → presentation frames, deliver queue, startup recovery, approval/prompt broker, optional `sessionManager` upstream with the focus pointer + `/ls` `/use` `/to` command table + notification pump) over a pure-function library: `format/` (chunk, format, prompt-hint, media-limit, http-proxy), `policy/` (merge, router resolver chain, stream, busy, deliver-queue, recovery, finalization, manager-commands, focus-presentation, approval/prompt render, …), `config/` (the agent-routing / behavior / allowlist schema fragments every provider composes its `Config` from), plus a `testing/` conformance suite each provider installs |
| `dsh-channel-telegram` | `packages/channel-telegram` | First provider: Telegram long polling, HTML rendering, inline-keyboard approval + `/ls` focus keyboard, delivery ledger, reactions, inbound media size cap, reply/thread/silent delivery |
| `dsh-channel-wechat` | `packages/channel-wechat` | WeChat (iLink Bot API): long polling, markdown pass-through, numbered-text approval |
| `dsh-channel-feishu` | `packages/channel-feishu` | Feishu / Lark: long-lived (WebSocket) inbound, plain-text rendering, numbered-text approval, reply (thread) delivery |

---

### Quick start

```bash
npm install          # install workspace dependencies
npm run build        # build all six packages into each package's lib/ (dependency order)
npm run test         # build, then run all tests
npm run typecheck
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
   - agent preset (`@deepseek-ai/dsh-agent-preset-registry`): standard web deployments default to `standard`.
     When the Telegram channel creates an agent it **automatically joins the host's default preset**, so the
     full tool/persona/skill capability set matches a Web session — no need to configure tools by hand, and
     don't hand-write a tool plugin just to "give it tools".

2. Install this repo's packages (or use the npm names after publishing; WeChat/Feishu follow the same pattern with
   `dsh-channel-wechat` / `dsh-channel-feishu` respectively — see each package's `cordis.patch.yml` for wiring):

   ```bash
   # in your dsh profile
   pnpm add dsh-channel dsh-channel-kit dsh-channel-telegram
   # optional, but recommended — the session layer (multi-session /ls /use /to, notify_user):
   pnpm add dsh-session-manager
   ```

3. Merge the contents of `packages/channel-telegram/cordis.patch.yml` into your profile's
   `cordis.patch.yml` (or use `dsh --patch ./packages/channel-telegram/cordis.patch.yml`):

   ```yaml
   - insert:
       - id: channel
         name: dsh-channel
   # optional: install BEFORE the channel rows; the bridge picks it up via
   # ctx.get('sessionManager') and switches to its upstream (design §14)
   - insert:
       - id: session-manager
         name: dsh-session-manager
         config:
           defaultSubscribers: []     # e.g. channel:telegram:<your chat id> for notify_user fallback
   - insert:
       - id: channel-telegram
         name: dsh-channel-telegram
         config:
           allowedUserIds: []   # ← your Telegram user id; empty = the bot answers no one
           provider: deepseek-official
           model: deepseek-flash
           # cwd / agentPreset unset: use process.cwd() workspace + host default preset
   ```

4. Configure the Telegram Bot Token (**don't put it in the config file**):

   ```bash
   export TELEGRAM_BOT_TOKEN='...'          # process env, takes effect on start
   # or set it in the web UI's credentials page (0.2 has no `dsh credentials set` subcommand)
   ```

   The plugin re-resolves `ctx.credentials.resolve('TELEGRAM_BOT_TOKEN')` before every API call;
   `dsh-credentials-local` hot-publishes `.credentials.yaml` changes, so swapping the token at runtime
   needs no restart.

5. Start dsh and send a message to your bot. By default only `direct` private chats are allowed; group chats are dropped in v1.

---

### Local debugging (echo bot, no model)

The repo ships a dev echo bot for verifying the Telegram send/receive path without a full dsh host:

```bash
npm run build
TELEGRAM_BOT_TOKEN='...' node scripts/run-echo-bot.mjs
```

It loads `dsh-channel` + `dsh-agent` + `dsh-credentials-local` + `dsh-channel-telegram`, and substitutes an echo factory for the real agent loop. Ordinary messages are replied with `[echo mode] You said: ...`; local commands (`/help`, `/start`, etc.) work.

For shared debugging with the **full agent** there is `run-dev-bot.sh` — the real `dsh` launcher plus a
patch YAML, the exact path a user takes (no hand-assembled Context). The script maintains a `dev-bot`
profile under `$DSH_HOME` (the web profile's bundle stack + this repo's packages as `file:` deps),
refreshes the installed copies from `packages/*/lib` on every launch, and boots with
[`scripts/dev-bot.yaml`](./scripts/dev-bot.yaml) as the patch layer — the same document shape as any
profile `cordis.patch.yml`; edit it (allowlist, model, `accountId`, `proxyUrl`, …) and restart. The
script stands in the gitignored `agent-workspace/` so the agent's cwd-derived workspace never touches
the repo tree. Credentials come from your `$DSH_HOME` as usual (the web UI's credentials page or env vars).

```bash
npm run build
scripts/run-dev-bot.sh               # web UI + Telegram bridge, full agent
scripts/run-dev-bot.sh --port 5299   # extra args go to the web app
DEV_BOT_LOG_LEVEL=2 scripts/run-dev-bot.sh   # runtime log threshold (0 error · 1 info · 2 warn · 3 debug; default 3)
```

Runtime logs: dsh itself ships no log sink — `ctx.logger` only fills an in-memory buffer, so a bare
host prints nothing beyond `dsh web: http://…`. The dev bot therefore inserts
[`scripts/dev-logger.mjs`](./scripts/dev-logger.mjs), a dev-only stderr exporter (the script copies it
into the profile directory; `dev-bot.yaml` references it as `./dev-logger.mjs`). Any other debugging
profile can take the same file plus that one patch row.

Note: two processes long-polling the same bot token fight over `getUpdates` (Telegram 409) — stop any
other instance using the token first.

---

### Test coverage

| Package | Tests | Coverage |
|---|---|---|
| `dsh-channel` | 15 | register/unregister, duplicate-registration rejection (incl. `(id, accountId)`), deliver default, waterfall observation and short-circuit, event broadcast, `ackInbound` default + override, multi-account registry + `chatKeyOf`/`bindChatKey`, capability-fact defaults (`supportsReply`/`supportsThreads`/`supportsSilent`/`supportsReconciliation`) |
| `dsh-session-manager` | 49 | create/adopt (random-id create, resume-before-create, verbatim resume failures, `createIfMissing`, sessionQuery-before-persistence), dispatch task fold (queued→running→done, steer joins the open turn, error/interrupted/canceled, steer-to-adopted-mid-turn folds done), the idle-edge single turn-end summary, subscriptions + `subscribersOf` kind filter + order-insensitive watch disposer, outbox now/done + `defaultSubscribers` + ack/pending, deferred notify crash-restart release, approval/question observation (pass-through `next()`), list/describe/workspaces (projections, foreign, queued, lazy log fold), restart task rebuild + outbox survival, memory/JSON-file/storage-domain stores (write-failure self-heal, domain id-counter crash window), `notify_user` tool, plugin entry + R1 teardown |
| `dsh-channel-kit` | 160 | shared config fragments (defaults, `maxInboundMediaBytes`/`sessionTurnTimeoutSec`/`accountId`/`proxyUrl` overrides, numeric vs string allowlist, interface ↔ schema key parity), chunk fence padding/prefix convergence, merge three iron rules and `..`/`!!`, router decision table + resolver-chain tri-state/provenance, manager-commands parse + list/status/workspace render, focus-presentation rules, approval numbering/timeout, store state machine and JSON file (write-failure self-heal), format three-tier degradation and `<tool_calls>`/reasoning sanitization, prompt-render options/multi-select/free-text, tool-display, stream reducer, deliver-queue retry/backoff/spacing/backpressure, media size guard, http-proxy (CONNECT tunnel + absolute-form + multipart), **bridge ⟷ manager integration** (conventional-id adopt, focus `/use`/`/new`, `/to` badged one-shot, `/status`/`/tail`/`/stop`, foreign-confirm `--take` + foreign focus-tap refusal, `/to --take`, `/unwatch` surviving free-text dispatch, command-dispatch message attribution, notify_user badged delivery + ack, crash→resumed-resend exactly-once, forbidden→unwatch, multi-chat approval, byte-identical no-manager commands) |
| `dsh-channel-telegram` | 47 | config schema (shared defaults + numeric allowlist), Telegram API calls and redaction, HTML-failure fallback to plain text, inbound routing/merge/delivery, allowlist, approval answerer timeout `next()`, real `callback_query` approval round-trip, `focus:` callback → `applyFocusChoice` (incl. foreign takeover warning), `<tool_calls>` leak interception, agent preset join, progress draft, user-questions waterfall answerer, inbound media size cap (streaming + Content-Length), `getMe`/`setMessageReaction`, group `mentionsBot` observation, ack-long reaction, reply/thread/silent send options, inbound `replyToMessageId`, recovery reconciliation + text-hash guard |
| `dsh-channel-wechat` | 10 | config schema (string allowlist, `platformAccountId`), iLink getupdates/sendmessage calls and redaction, context_token echo, inbound routing/merge/delivery, allowlist |
| `dsh-channel-feishu` | 20 | config schema (`domain` union), tenant_access_token cache, sendMessage receive_id_type parsing, protobuf frame encode/decode, inbound event routing/delivery, allowlist, `createReaction`/`react`, `replyMessage`/`supportsReply`, inbound `replyToMessageId` (`parent_id`) |

---

### Directory structure

```
.
├── packages/
│   ├── channel/           # dsh-channel (contract)
│   ├── session-manager/   # dsh-session-manager (ctx.sessionManager + notify_user)
│   ├── channel-kit/       # dsh-channel-kit (pure-function library + ChannelBridge)
│   ├── channel-telegram/  # dsh-channel-telegram
│   ├── channel-wechat/    # dsh-channel-wechat (WeChat iLink Bot API)
│   └── channel-feishu/    # dsh-channel-feishu (Feishu / Lark long-lived connection)
├── scripts/
│   ├── run-echo-bot.mjs  # local debug echo bot (no model, env-configured)
│   ├── run-dev-bot.sh    # full-agent debug bot: real dsh launcher + patch YAML
│   └── dev-bot.yaml      # its patch layer (standard cordis.patch.yml shape)
├── dsh-channel-design.md
├── tsconfig.base.json
└── package.json
```

---

### Notes

- Media capability (design §10) is implemented in the contract: `InboundMedia`/`OutboundMedia`/`supportsMedia`/`sendMedia`. Telegram `supportsMedia=true` (inbound images `getFile`→`ctx.attachments.saveImage`→model-visible image block; outbound `sendPhoto`/`sendDocument`); WeChat/Feishu `supportsMedia=false`, inbound only carries the `fileRef` fact (no byte download).
- Inbound media size cap: `maxInboundMediaBytes` (shared config, default 20 MiB) is enforced by Telegram's `getFile` — it checks `Content-Length` then the running byte count and aborts *before* an oversized body is fully buffered (kit `assertMediaWithinLimit`).
- Outbound resilience: every provider routes ledger-tracked sends through a per-chatKey `deliver-queue` (kit reducer) — one serial worker, generic retry with exponential backoff (3 retries, 1/2/4s), and queue-full backpressure. The queue decides *when* to call `deliver()`; the `channel/deliver` waterfall still decides *what happens*.
- Cheap inbound ack: `Channel.ackInbound(chatKey, messageId)` (default `false`). The bridge owns the timing (the merge `ack-long` effect), the provider owns the form: Telegram reacts 👀 via `setMessageReaction`, Feishu creates an `ONLOOKER` reaction via `message_reaction.create`, WeChat has no reaction API and keeps the default. `false` or a throw falls back to the `Received, working on it…` text.
- `mentionsBot` is now observed: Telegram inspects `entities` (`text_mention`/`mention`) against its own `getMe` identity; Feishu reads `mentions`. WeChat's iLink payload carries no mention metadata, so it stays `false`. Still observational — v1 does not route group chats.
- Multi-account (M8): `Channel.accountId` (default `'default'`) + the registry keys entries by `(id, accountId)`, so two bots of the same platform can coexist. Session ids gain a `:<accountId>` segment only for non-default accounts (`channel:telegram:prod:<chatKey>`), keeping single-account ids byte-for-byte unchanged. Set `accountId` in a provider's config (shared behavior field).
- Proactive push (M8): `ctx.channels.bindChatKey()`/`chatKeyOf(sessionId)` expose the sessionId → `{ channel, accountId?, chatKey }` binding registry-wide, so a monitor/reminder plugin can `deliver()` with no preceding inbound message.
- Delivery reconciliation (M8): `Channel.supportsReconciliation`/`reconcile(chatKey, deliveryKey, textHash)` lets a provider confirm a prior send before a blind resend on recovery; the default returns `'unknown'` (graceful absence), preserving the existing "resumed resend" marker. No current provider implements a platform-side query (Telegram's Bot API has no sent-message lookup), so the seam is in place and recovery still falls back safely.
- Reply / thread / silent (M9): `InboundMessage.replyToMessageId`, `OutboundMessage.replyTo`/`threadId`/`silent`, and `supportsReply`/`supportsThreads`/`supportsSilent`. Telegram implements reply (`reply_parameters`) and silent (`disable_notification`); Feishu implements reply (`replyMessage`, inbound `parent_id`); threads stay capability-fact-only until a provider emits `chatType: 'thread'`. Status lines (`⏹ Turn ended: …`) send silently on platforms that support it.
- Interactive login + proxy (M10): the contract exports a sibling `ChannelLogin` interface (QR/OAuth device flow, CLI-only) — no current provider needs it (static tokens). `proxyUrl` (shared behavior field) threads into each provider client's `fetch` via the kit's `proxiedFetch` (CONNECT tunnel for HTTPS, absolute-form for HTTP), so the Telegram/Feishu APIs can be reached through an outbound proxy.
- v1 does not route group chats (`chatType !== 'direct'` is dropped directly).
- The outbound delivery ledger lives in `state.json`; the in-memory `ChannelStore` implementation is available for tests.
- Dependency direction: each provider (`dsh-channel-telegram` / `-wechat` / `-feishu`) depends only on `dsh-channel` + `dsh-channel-kit`; policy plugins depend only on `dsh-channel`. Each provider owns its own config schema and credential-ref names in `src/config.ts`, composed from the kit's shared fragments — adding a platform touches no shared package.
- Provider config is the plugin entry's `config:` in the profile's `cordis.patch.yml` (the 0.2 settings model: no separate settings namespace, no live `source()` layering) — the schema still supplies defaults for unset fields, and any config change restarts the plugin with the new value. Secrets stay in `ctx.credentials` (set via the web UI's credentials page or env vars, never in the profile patch). See [dsh-channel-design.md §11](./dsh-channel-design.md#11-configuration-and-settings-seam).
- Capability differences only go through "capability facts + degradation": Telegram `html`+buttons+progress+reaction ack, WeChat `markdown`+typing+off, Feishu `plain`+off+reaction ack — `dsh-channel`/`dsh-channel-kit` hold the shared facts and hooks (`ackInbound`), providers only fill them in (A5 verified).
- Session manager (design §14, optional): with `dsh-session-manager` composed, each chat's binding becomes a **focus pointer** into `ctx.sessionManager` — `/ls` lists every session of the process (live + cold + foreign, grouped by workspace, numbered per chat), `/use n` moves the focus, `/to n <text>` dispatches one-shot, `/new [ws|path] [text]` creates a random-id managed session, `/status`/`/tail`/`/stop`/`/watch`/`/unwatch`/`/ws` round out the table. Only the focus session streams; watched sessions deliver badged result notifications (`[#2 docs sync] ✅ completed · …`) through the same serial deliver queue under the ledger-shaped key `notify:<id>` — the queue's connected-gating and retries apply, but no ledger rows are written: the manager's durable outbox is the durability layer, acked after a successful send (a crash between deliver and ack re-delivers once with the "(resumed resend)" marker). Every agent — including browser-opened ones — gets the `notify_user` tool (`when: 'now' | 'done'`); sessions with no watcher fall back to `defaultSubscribers`. Without the manager plugin the bridge is byte-for-byte the classic one-chat-one-session behavior.

---

<a name="中文"></a>
## 中文

DeepSeek Harness (dsh) 的消息渠道公共层、一个与渠道无关的会话管理器（session manager），以及多个 provider 实现（Telegram / 微信 / 飞书 / …，本仓库持续新增）。

按照 [dsh-channel-design.md](./dsh-channel-design.md) 拆为六个包。

对 dsh 本身核心/seam 的对齐基线，见 [docs/dsh-core-reference.md](./docs/dsh-core-reference.md)
（ctx seam/core 全表 + 核心包 + 生命周期 + 工具流水线 + 会话日志，逐条对照 0.2.0-rc.2 源码）。
刻意**没有**做的部分——待验证的开放问题、带触发条件的延后项、以及已论证并否决的设计——见
[docs/dsh-channel-backlog.md](./docs/dsh-channel-backlog.md)。

这三份加本文件即全部文档：只讲我们的设计、已交付的实现、以及计划（roadmap/backlog）。
已完成的过程文档保留在 git 历史里，不再保留在代码树中。

| 包 | 目录 | 说明 |
|---|---|---|
| `dsh-channel` | `packages/channel` | 契约包：`ctx.channels` 注册表（`accountId` 多账号）、`Channel` 抽象基类、`channel/*` 事件词汇表、`MessageSourceMap.channel` 归并、主动推送绑定（`chatKeyOf`） |
| `dsh-session-manager` | `packages/session-manager` | 与渠道无关的会话层（design §14）：`ctx.sessionManager` 服务——建立在 `ctx.agents`/`sessionQuery`/`workspaceRegistry` 之上的受管会话登记表、由会话日志 `turn/start`/`turn/end` 折叠出的派发 task、订阅 + 持久带 ack 的通知 outbox，以及全局 `notify_user` 工具。不依赖任何 channel 包 |
| `dsh-channel-kit` | `packages/channel-kit` | `ChannelBridge` 共享 handler（入站流水线、session 事件 → 展示帧、投递队列、启动恢复、审批/追问 broker、可选的 `sessionManager` 上游：focus 指针 + `/ls` `/use` `/to` 命令表 + 通知泵），其下是纯函数库：`format/`（chunk、format、prompt-hint、media-limit、http-proxy）、`policy/`（merge、router 解析器链、stream、busy、deliver-queue、recovery、finalization、manager-commands、focus-presentation、审批/追问渲染……）、`config/`（agent 路由 / 行为 / allowlist schema 片段，各 provider 由此拼出自己的 `Config`），以及各 provider 安装的 `testing/` 一致性测试套件 |
| `dsh-channel-telegram` | `packages/channel-telegram` | 第一个 provider：Telegram 长轮询、HTML 渲染、inline-keyboard 审批 + `/ls` focus 键盘、delivery ledger、表情回应、入站媒体大小上限、回复/静默投递 |
| `dsh-channel-wechat` | `packages/channel-wechat` | 微信（iLink Bot API）：长轮询、markdown 透传、编号文本审批 |
| `dsh-channel-feishu` | `packages/channel-feishu` | 飞书 / Lark：长连接（WebSocket）入站、纯文本渲染、编号文本审批、回复（话题）投递 |

---

### 快速开始

```bash
npm install          # 安装 workspace 依赖
npm run build        # 按依赖顺序构建六个包到各包 lib/
npm run test         # 先构建，再运行全部测试
npm run typecheck
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
   - agent preset（`@deepseek-ai/dsh-agent-preset-registry`）：标准 web 部署默认 `standard`。
     Telegram 渠道创建 agent 时会**自动 join 宿主默认 preset**，所以工具/人设/技能
     全套能力与 Web 会话一致——无需手动配工具，也不要为了"给工具"而手写 tool 插件。

2. 安装本仓库对应包（或发布后使用 npm 名；微信/飞书同理，分别用
   `dsh-channel-wechat` / `dsh-channel-feishu`，装配见各自包内 `cordis.patch.yml`）：

   ```bash
   # 在 dsh profile 中
   pnpm add dsh-channel dsh-channel-kit dsh-channel-telegram
   # 可选，但推荐——会话层（多会话 /ls /use /to、notify_user）：
   pnpm add dsh-session-manager
   ```

3. 把 `packages/channel-telegram/cordis.patch.yml` 的内容合并到 profile 的
   `cordis.patch.yml`（或使用 `dsh --patch ./packages/channel-telegram/cordis.patch.yml`）：

   ```yaml
   - insert:
       - id: channel
         name: dsh-channel
   # 可选：在 channel 各行之前安装；bridge 经 ctx.get('sessionManager')
   # 自动切换到 manager 上游（design §14）
   - insert:
       - id: session-manager
         name: dsh-session-manager
         config:
           defaultSubscribers: []     # 例如 channel:telegram:<你的 chat id>，作 notify_user 兜底
   - insert:
       - id: channel-telegram
         name: dsh-channel-telegram
         config:
           allowedUserIds: []   # ← 填你的 Telegram user id；留空则 bot 不应答任何人
           provider: deepseek-official
           model: deepseek-flash
           # cwd / agentPreset 不设：沿用 process.cwd() 工作区 + 宿主默认 preset
   ```

4. 配置 Telegram Bot Token（**不要写进配置文件**）：

   ```bash
   export TELEGRAM_BOT_TOKEN='...'          # 进程环境，启动时生效
   # 或在 web UI 的 credentials 页设置（0.2 没有 `dsh credentials set` 子命令）
   ```

   插件每次 API 调用前都会重新 `ctx.credentials.resolve('TELEGRAM_BOT_TOKEN')`，
   `dsh-credentials-local` 会热发布 `.credentials.yaml` 的变更，因此运行中换 token
   不需要重启进程。

5. 启动 dsh 后，向你的 bot 发消息即可。默认只允许 `direct` 私聊；群聊在 v1 直接 drop。

---

### 本地调试（echo bot，不接模型）

仓库自带一个开发用 echo bot，用于不依赖完整 dsh 宿主时验证 Telegram 收发链路：

```bash
npm run build
TELEGRAM_BOT_TOKEN='...' node scripts/run-echo-bot.mjs
```

它会加载 `dsh-channel` + `dsh-agent` + `dsh-credentials-local` + `dsh-channel-telegram`，
并用一个 echo factory 代替真实 agent loop。普通消息会回复 `[echo mode] You said: ...`
（即"[echo 模式] 你说：…"），本地命令（`/help`、`/start` 等）可用。

面向多人协作、带**完整 agent** 的调试用 `run-dev-bot.sh`——真实 `dsh` 启动器 + patch YAML，
和用户使用的完全是同一条路（不手工拼 Context）。脚本会在 `$DSH_HOME` 下维护一个 `dev-bot`
profile（web profile 同款 bundle 栈 + 本仓库四个包的 `file:` 依赖），每次启动前从
`packages/*/lib` 刷新安装拷贝，然后以 [`scripts/dev-bot.yaml`](./scripts/dev-bot.yaml)
作为补丁层启动——它就是标准的 profile `cordis.patch.yml` 文档形状；改它（allowlist、模型、
`accountId`、`proxyUrl`……）再重启即可。脚本会站在 gitignored 的 `agent-workspace/` 里启动，
因此 agent 按 cwd 推导的工作区永远不会碰到仓库树。凭证照常走你的 `$DSH_HOME`
（web UI 的 credentials 页或环境变量）。

```bash
npm run build
scripts/run-dev-bot.sh               # web UI + Telegram bridge，完整 agent
scripts/run-dev-bot.sh --port 5299   # 额外参数透传给 web app
DEV_BOT_LOG_LEVEL=2 scripts/run-dev-bot.sh   # 运行时日志阈值（0 error · 1 info · 2 warn · 3 debug；默认 3）
```

运行时日志：dsh 自身没有日志 sink——`ctx.logger` 只写一个内存 buffer，裸宿主除了 `dsh web: http://…`
什么都不打印。因此 dev bot 插入了 [`scripts/dev-logger.mjs`](./scripts/dev-logger.mjs)，一个仅供调试的
stderr 导出器（脚本会把它拷进 profile 目录，`dev-bot.yaml` 以 `./dev-logger.mjs` 引用）。其他调试
profile 拿同一个文件加同一行 patch 即可。

注意：两个进程用同一个 bot token 长轮询会互抢 `getUpdates`（Telegram 409）——先停掉占用
该 token 的其他实例。

---

### 测试覆盖

| 包 | 测试数 | 覆盖点 |
|---|---|---|
| `dsh-channel` | 15 | 注册/卸载、重复注册拒绝（含 `(id, accountId)`）、deliver 缺省、waterfall 观察与短路、事件广播、`ackInbound` 缺省与覆盖、多账号注册表 + `chatKeyOf`/`bindChatKey`、能力事实缺省（`supportsReply`/`supportsThreads`/`supportsSilent`/`supportsReconciliation`） |
| `dsh-session-manager` | 49 | create/adopt（随机 id 创建、resume-before-create、resume 失败如实上报、`createIfMissing`、sessionQuery 先于 persistence）、派发 task 折叠（queued→running→done、steer 并入开放 turn、error/interrupted/canceled、adopt 运行中 session 的 steer 折叠为 done）、idle 边沿单条 turn-end 摘要、订阅 + `subscribersOf` 按 kind 过滤 + 顺序无关的 watch disposer、outbox now/done + `defaultSubscribers` + ack/pending、deferred 通知崩溃-重启释放、审批/追问观察（透传 `next()`）、list/describe/workspaces（投影、foreign、queued、冷日志惰性折叠）、重启 task 重建 + outbox 跨重启存活、内存/JSON 文件/storage-domain 三种存储（写失败自愈、domain id 计数器崩溃窗口）、`notify_user` 工具、插件入口 + R1 卸载 |
| `dsh-channel-kit` | 160 | 共享配置片段（默认值、`maxInboundMediaBytes`/`sessionTurnTimeoutSec`/`accountId`/`proxyUrl` 覆盖、数字 vs 字符串 allowlist、接口与 schema 字段一致性）、chunk 围栏补齐/前缀收敛、merge 三铁律与 `..`/`!!`、router 决策表 + 解析器链三态/provenance、manager-commands 解析 + 列表/状态/工作区渲染、focus-presentation 规则、approval 编号/超时、store 状态机与 JSON 文件（写失败自愈）、format 三档降级与 `<tool_calls>`/reasoning 净化、prompt-render 选项/多选/自由文本、tool-display、stream reducer、deliver-queue 重试/退避/间隔/背压、媒体大小守卫、http-proxy（CONNECT 隧道 + absolute-form + multipart）、**bridge ⟷ manager 集成**（约定 id adopt、focus `/use`/`/new`、`/to` 带徽标一次性派发、`/status`/`/tail`/`/stop`、foreign 确认 `--take` + foreign 按钮拒接管、`/to --take`、`/unwatch` 不被自由文本撤销、命令派发消息归因、notify_user 带徽标投递 + ack、崩溃→resumed-resend 恰好一次、forbidden→unwatch、多聊天审批、无 manager 时命令逐字节不变） |
| `dsh-channel-telegram` | 47 | 配置 schema（共享默认值 + 数字 allowlist）、Telegram API 调用与脱敏、HTML 失败降级纯文本、入站路由/merge/投递、allowlist、审批 answerer 超时 `next()`、真实 `callback_query` 审批闭环、`focus:` 回调 → `applyFocusChoice`（含 foreign 接管确认）、`<tool_calls>` 泄漏拦截、agent preset join、progress 草稿、user-questions waterfall answerer、入站媒体大小上限（流式 + Content-Length）、`getMe`/`setMessageReaction`、群聊 `mentionsBot` 观察、ack-long 表情回应、回复/话题/静默发送选项、入站 `replyToMessageId`、恢复对账 + textHash 守卫 |
| `dsh-channel-wechat` | 10 | 配置 schema（字符串 allowlist、`platformAccountId`）、iLink getupdates/sendmessage 调用与脱敏、context_token 回显、入站路由/merge/投递、allowlist |
| `dsh-channel-feishu` | 20 | 配置 schema（`domain` 枚举）、tenant_access_token 缓存、sendMessage receive_id_type 解析、protobuf 帧编解码、入站事件路由/投递、allowlist、`createReaction`/`react`、`replyMessage`/`supportsReply`、入站 `replyToMessageId`（`parent_id`） |

---

### 目录结构

```
.
├── packages/
│   ├── channel/           # dsh-channel（契约）
│   ├── session-manager/   # dsh-session-manager（ctx.sessionManager + notify_user）
│   ├── channel-kit/       # dsh-channel-kit（纯函数库 + ChannelBridge）
│   ├── channel-telegram/  # dsh-channel-telegram
│   ├── channel-wechat/    # dsh-channel-wechat（微信 iLink Bot API）
│   └── channel-feishu/    # dsh-channel-feishu（飞书 / Lark 长连接）
├── scripts/
│   ├── run-echo-bot.mjs  # 本地调试 echo bot（不接模型，环境变量配置）
│   ├── run-dev-bot.sh    # 完整 agent 调试 bot：真实 dsh 启动器 + patch YAML
│   └── dev-bot.yaml      # 它的补丁层（标准 cordis.patch.yml 形状）
├── dsh-channel-design.md
├── tsconfig.base.json
└── package.json
```

---

### 注意事项

- 媒体能力（design §10）已落地契约：`InboundMedia`/`OutboundMedia`/`supportsMedia`/`sendMedia`。Telegram `supportsMedia=true`（入站图片 `getFile`→`ctx.attachments.saveImage`→模型可见 image 块；出站 `sendPhoto`/`sendDocument`）；WeChat/Feishu `supportsMedia=false`，入站只带 `fileRef` 事实（不下载字节）。
- 入站媒体大小上限：`maxInboundMediaBytes`（共享配置，默认 20 MiB）由 Telegram 的 `getFile` 强制——先查 `Content-Length`，再累计读取字节数，在超大 payload 被完整缓冲**之前**中止（kit 的 `assertMediaWithinLimit`）。
- 出站韧性：每个 provider 把走 ledger 的发送都经由 per-chatKey 的 `deliver-queue`（kit reducer）——单串行 worker、通用重试（指数退避 3 次，1/2/4s）、队列满背压。队列决定**何时**调用 `deliver()`；`channel/deliver` waterfall 仍决定**这次尝试发生什么**。
- 廉价入站确认：`Channel.ackInbound(chatKey, messageId)`（默认 `false`）。时机归 bridge（merge 的 `ack-long` 效应），形式归 provider：Telegram 经 `setMessageReaction` 回 👀，Feishu 经 `message_reaction.create` 创建 `ONLOOKER` 表情，WeChat 无表情 API、保持默认。返回 `false` 或抛错时降级为 `Received, working on it…` 文本。
- `mentionsBot` 现为真实观察：Telegram 对照自身 `getMe` 身份扫描 `entities`（`text_mention`/`mention`）；Feishu 读 `mentions`。WeChat 的 iLink payload 无 @ 元数据，保持 `false`。仍是纯观察——v1 不路由群聊。
- 多账号（M8）：`Channel.accountId`（默认 `'default'`）+ 注册表按 `(id, accountId)` 建键，因此同一平台的两个 bot 可共存。会话 id 仅在非默认账号时追加 `:<accountId>` 段（`channel:telegram:prod:<chatKey>`），单账号会话 id 逐字节不变。在 provider 配置里设 `accountId`（共享行为字段）。
- 主动推送（M8）：`ctx.channels.bindChatKey()`/`chatKeyOf(sessionId)` 把 sessionId → `{ channel, accountId?, chatKey }` 绑定暴露为注册表级，监控/提醒插件无需前置入站消息即可 `deliver()`。
- 投递对账（M8）：`Channel.supportsReconciliation`/`reconcile(chatKey, deliveryKey, textHash)` 让 provider 在恢复重发前先向平台确认；默认返回 `'unknown'`（优雅缺省），保留现有 "resumed resend" 标记。当前没有 provider 实现平台侧查询（Telegram Bot API 无已发消息查询），seam 已就位、恢复仍安全回退。
- 回复 / 话题 / 静默（M9）：`InboundMessage.replyToMessageId`、`OutboundMessage.replyTo`/`threadId`/`silent`，及 `supportsReply`/`supportsThreads`/`supportsSilent`。Telegram 实现回复（`reply_parameters`）与静默（`disable_notification`）；Feishu 实现回复（`replyMessage`、入站 `parent_id`）；话题在 provider 真正发出 `chatType: 'thread'` 前保持能力事实级别。状态行（`⏹ Turn ended: …`）在支持的平台上静默发送。
- 交互式登录 + 代理（M10）：契约导出兄弟接口 `ChannelLogin`（QR/OAuth device flow，仅供 CLI）——三个 provider 均用静态 token，无需实现。`proxyUrl`（共享行为字段）经 kit 的 `proxiedFetch`（HTTPS 走 CONNECT 隧道、HTTP 走 absolute-form）接入各 provider client 的 `fetch`，使 Telegram/Feishu API 可经出站代理访问。
- v1 不路由群聊（`chatType !== 'direct'` 直接 drop）。
- 出站 delivery ledger 存在 `state.json` 中；进程内 `ChannelStore` 纯内存实现可用于测试。
- 依赖方向：每个 provider（`dsh-channel-telegram` / `-wechat` / `-feishu`）只依赖 `dsh-channel` + `dsh-channel-kit`；策略插件只依赖 `dsh-channel`。每个 provider 在自己的 `src/config.ts` 里用 kit 的共享片段拼出配置 schema 与凭证 ref 名——新增平台不碰任何公共包。
- provider 的配置就是 profile `cordis.patch.yml` 里该插件条目的 `config:`（0.2 的 settings 模型：没有独立 settings 命名空间，也没有 `source()` 热更新分层）——schema 仍为未设字段提供默认值，任何配置改动都会以新值重启插件。secret 仍走 `ctx.credentials`（web UI 的 credentials 页或环境变量设置，永不进 profile patch）。见 [dsh-channel-design.md §11](./dsh-channel-design.md#11-configuration-and-settings-seam)。
- 能力差异只走「能力事实 + 降级」：Telegram `html`+按钮+progress+表情确认、WeChat `markdown`+typing+off、Feishu `plain`+off+表情确认——`dsh-channel`/`dsh-channel-kit` 承载共享事实与钩子（`ackInbound`），provider 只填充（A5 验证）。
- 会话管理器（design §14，可选）：装配 `dsh-session-manager` 后，每个 chat 的 binding 变成指向 `ctx.sessionManager` 的 **focus 指针**——`/ls` 列出本进程全部会话（live + 冷 + foreign，按 workspace 分组、chat 内编号），`/use n` 移动 focus，`/to n <text>` 一次性派发，`/new [ws|path] [text]` 创建随机 id 的受管会话，`/status`/`/tail`/`/stop`/`/watch`/`/unwatch`/`/ws` 补齐命令表。只有 focus 会话流式投递；被 watch 的会话经同一条串行投递队列、在 `notify:<id>` 这个 ledger 形 key 下送达带徽标的结果通知（`[#2 docs sync] ✅ completed · …`）——只用队列的 connected 门控与重试，不写任何 ledger 行：manager 的持久 outbox 才是持久层，发送成功后对它 ack（deliver 与 ack 之间崩溃 → 重启后带 "(resumed resend)" 标记重投一次）。每个 agent——包括浏览器里开的——都获得 `notify_user` 工具（`when: 'now' | 'done'`）；无 watcher 的会话回落到 `defaultSubscribers`。不装 manager 插件时，bridge 行为与经典的「一 chat 一 session」逐字节一致。
