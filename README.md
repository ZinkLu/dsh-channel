# dsh-channel

DeepSeek Harness (dsh) 的消息渠道公共层与 Telegram 验证实现。

按照 [dsh-channel-design.md](./dsh-channel-design.md) 与 [dsh-channel-handoff.md](./dsh-channel-handoff.md) 拆为三个包：

| 包 | 目录 | 说明 |
|---|---|---|
| `dsh-channel` | `packages/channel` | 契约包：`ctx.channels` 注册表、`Channel` 抽象基类、`channel/*` 事件词汇表、`MessageSourceMap.channel` 归并 |
| `dsh-channel-kit` | `packages/channel-kit` | 六件脏活的纯函数库：chunk / merge / router / approval-render / store / format / promptHint |
| `dsh-channel-telegram` | `packages/channel-telegram` | 第一个 provider：Telegram 长轮询、HTML 渲染、inline-keyboard 审批、delivery ledger |

---

## 快速开始

```bash
npm install          # 安装 workspace 依赖
npm run build -ws    # 构建三个包到各包 lib/
npm run test -ws     # 运行全部测试
npm run typecheck -ws
```

也可以单独操作某个包：

```bash
npm run build -w dsh-channel-kit
npm run test -w dsh-channel-telegram
```

---

## 在 dsh 中装配 Telegram 渠道

1. 确保 dsh 宿主已配置：

   - `ctx.agents` / agent loop（`@deepseek-ai/dsh-agent-loop`）
   - `ctx.credentials`（`@deepseek-ai/dsh-credentials-local`）
   - `ctx.llm` 及对应模型适配器

2. 安装本仓库三个包（或发布后使用 npm 名）：

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
           cwd: !!js process.env.HOME + '/agent-workspace'
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

## 本地调试（echo bot，不接模型）

仓库自带一个开发用 echo bot，用于不依赖完整 dsh 宿主时验证 Telegram 收发链路：

```bash
npm run build -ws
TELEGRAM_BOT_TOKEN='...' node scripts/run-echo-bot.mjs
```

它会加载 `dsh-channel` + `dsh-agent` + `dsh-credentials-local` + `dsh-channel-telegram`，
并用一个 echo factory 代替真实 agent loop。普通消息会回复 `[echo 模式] 你说：...`，
本地命令（`/help`、`/start` 等）可用。

---

## 测试覆盖

| 包 | 测试数 | 覆盖点 |
|---|---|---|
| `dsh-channel` | 6 | 注册/卸载、重复注册拒绝、deliver 缺省、waterfall 观察与短路、事件广播 |
| `dsh-channel-kit` | 34 | chunk 围栏补齐/前缀收敛、merge 三铁律与 `..`/`!!`、router 决策表、approval 编号/超时、store 状态机与 JSON 文件、format 三档降级 |
| `dsh-channel-telegram` | 6 | Telegram API 调用与脱敏、HTML 失败降级纯文本、入站路由/merge/投递、allowlist、审批 answerer 超时 `next()` |

---

## 目录结构

```
.
├── packages/
│   ├── channel/          # dsh-channel
│   ├── channel-kit/      # dsh-channel-kit
│   └── channel-telegram/ # dsh-channel-telegram
├── scripts/
│   └── run-echo-bot.mjs  # 本地调试 echo bot
├── dsh-channel-design.md
├── dsh-channel-handoff.md
├── tsconfig.base.json
└── package.json
```

---

## 注意事项

- v1 不处理媒体内容，只保留 `hasMedia` 事实供 merge 决策。
- v1 不路由群聊（`chatType !== 'direct'` 直接 drop）。
- 出站 delivery ledger 存在 `state.json` 中；进程内 `ChannelStore` 纯内存实现可用于测试。
- 依赖方向：`dsh-channel-telegram` 只依赖 `dsh-channel` + `dsh-channel-kit`；策略插件只依赖 `dsh-channel`。
