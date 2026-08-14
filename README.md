# dsh-channel

[English](#english) · [中文](#中文)

---

<a name="english"></a>
## English

The message-channel common layer for DeepSeek Harness (dsh) plus multiple provider implementations (Telegram / WeChat / Feishu / …, with more added continuously in this repo).

Split into five packages per [dsh-channel-design.md](./dsh-channel-design.md).

For the alignment baseline against dsh's own core/seam, see [docs/dsh-core-reference.md](./docs/dsh-core-reference.md)
(full ctx seam/core table + core packages + lifecycle + tool pipeline + session log, checked line-by-line
against the rc.6 source), and [docs/dsh-core-alignment-audit.md](./docs/dsh-core-alignment-audit.md)
(point-by-point verification of the design doc against the dsh API).

| Package | Directory | Description |
|---|---|---|
| `dsh-channel` | `packages/channel` | Contract package: `ctx.channels` registry, `Channel` abstract base class, `channel/*` event vocabulary, `MessageSourceMap.channel` merging |
| `dsh-channel-kit` | `packages/channel-kit` | Pure-function library for the six grunt-work tasks: chunk / merge / router / approval-render / store / format / promptHint |
| `dsh-channel-telegram` | `packages/channel-telegram` | First provider: Telegram long polling, HTML rendering, inline-keyboard approval, delivery ledger |
| `dsh-channel-wechat` | `packages/channel-wechat` | WeChat (iLink Bot API): long polling, markdown pass-through, numbered-text approval |
| `dsh-channel-feishu` | `packages/channel-feishu` | Feishu / Lark: long-lived (WebSocket) inbound, plain-text rendering, numbered-text approval |

---

### Quick start

```bash
npm install          # install workspace dependencies
npm run build -ws    # build all five packages into each package's lib/
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
| `dsh-channel` | 6 | register/unregister, duplicate-registration rejection, deliver default, waterfall observation and short-circuit, event broadcast |
| `dsh-channel-kit` | 65 | chunk fence padding/prefix convergence, merge three iron rules and `..`/`!!`, router decision table, approval numbering/timeout, store state machine and JSON file, format three-tier degradation and `<tool_calls>`/reasoning sanitization, prompt-render options/multi-select/free-text, tool-display, stream reducer |
| `dsh-channel-telegram` | 10 | Telegram API calls and redaction, HTML-failure fallback to plain text, inbound routing/merge/delivery, allowlist, approval answerer timeout `next()`, `<tool_calls>` leak interception, agent preset join, progress draft, user-questions provider |
| `dsh-channel-wechat` | 5 | iLink getupdates/sendmessage calls and redaction, context_token echo, inbound routing/merge/delivery, allowlist |
| `dsh-channel-feishu` | 11 | tenant_access_token cache, sendMessage receive_id_type parsing, protobuf frame encode/decode, inbound event routing/delivery, allowlist |

---

### Directory structure

```
.
├── packages/
│   ├── channel/          # dsh-channel (contract)
│   ├── channel-kit/      # dsh-channel-kit (pure-function library)
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
- v1 does not route group chats (`chatType !== 'direct'` is dropped directly).
- The outbound delivery ledger lives in `state.json`; the in-memory `ChannelStore` implementation is available for tests.
- Dependency direction: each provider (`dsh-channel-telegram` / `-wechat` / `-feishu`) depends only on `dsh-channel` + `dsh-channel-kit`; policy plugins depend only on `dsh-channel`.
- Capability differences only go through "capability facts + degradation": Telegram `html`+buttons+progress, WeChat `markdown`+typing+off, Feishu `plain`+off — `dsh-channel`/`dsh-channel-kit` are unchanged (A5 verified).

---

<a name="中文"></a>
## 中文

DeepSeek Harness (dsh) 的消息渠道公共层与多个 provider 实现（Telegram / 微信 / 飞书 / …，本仓库持续新增）。

按照 [dsh-channel-design.md](./dsh-channel-design.md) 拆为五个包。

对 dsh 本身核心/seam 的对齐基线，见 [docs/dsh-core-reference.md](./docs/dsh-core-reference.md)
（ctx seam/core 全表 + 核心包 + 生命周期 + 工具流水线 + 会话日志，逐条对照 rc.6 源码），
以及 [docs/dsh-core-alignment-audit.md](./docs/dsh-core-alignment-audit.md)（设计文档对 dsh API
的逐条核对结果）。

| 包 | 目录 | 说明 |
|---|---|---|
| `dsh-channel` | `packages/channel` | 契约包：`ctx.channels` 注册表、`Channel` 抽象基类、`channel/*` 事件词汇表、`MessageSourceMap.channel` 归并 |
| `dsh-channel-kit` | `packages/channel-kit` | 六件脏活的纯函数库：chunk / merge / router / approval-render / store / format / promptHint |
| `dsh-channel-telegram` | `packages/channel-telegram` | 第一个 provider：Telegram 长轮询、HTML 渲染、inline-keyboard 审批、delivery ledger |
| `dsh-channel-wechat` | `packages/channel-wechat` | 微信（iLink Bot API）：长轮询、markdown 透传、编号文本审批 |
| `dsh-channel-feishu` | `packages/channel-feishu` | 飞书 / Lark：长连接（WebSocket）入站、纯文本渲染、编号文本审批 |

---

### 快速开始

```bash
npm install          # 安装 workspace 依赖
npm run build -ws    # 构建五个包到各包 lib/
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
| `dsh-channel` | 6 | 注册/卸载、重复注册拒绝、deliver 缺省、waterfall 观察与短路、事件广播 |
| `dsh-channel-kit` | 65 | chunk 围栏补齐/前缀收敛、merge 三铁律与 `..`/`!!`、router 决策表、approval 编号/超时、store 状态机与 JSON 文件、format 三档降级与 `<tool_calls>`/reasoning 净化、prompt-render 选项/多选/自由文本、tool-display、stream reducer |
| `dsh-channel-telegram` | 10 | Telegram API 调用与脱敏、HTML 失败降级纯文本、入站路由/merge/投递、allowlist、审批 answerer 超时 `next()`、`<tool_calls>` 泄漏拦截、agent preset join、progress 草稿、user-questions provider |
| `dsh-channel-wechat` | 5 | iLink getupdates/sendmessage 调用与脱敏、context_token 回显、入站路由/merge/投递、allowlist |
| `dsh-channel-feishu` | 11 | tenant_access_token 缓存、sendMessage receive_id_type 解析、protobuf 帧编解码、入站事件路由/投递、allowlist |

---

### 目录结构

```
.
├── packages/
│   ├── channel/          # dsh-channel（契约）
│   ├── channel-kit/      # dsh-channel-kit（纯函数库）
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
- v1 不路由群聊（`chatType !== 'direct'` 直接 drop）。
- 出站 delivery ledger 存在 `state.json` 中；进程内 `ChannelStore` 纯内存实现可用于测试。
- 依赖方向：每个 provider（`dsh-channel-telegram` / `-wechat` / `-feishu`）只依赖 `dsh-channel` + `dsh-channel-kit`；策略插件只依赖 `dsh-channel`。
- 能力差异只走「能力事实 + 降级」：Telegram `html`+按钮+progress、WeChat `markdown`+typing+off、Feishu `plain`+off——`dsh-channel`/`dsh-channel-kit` 零改动（A5 验证）。
