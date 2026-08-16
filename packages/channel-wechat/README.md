# dsh-channel-wechat

WeChat (WeChat / weixin) provider for `dsh-channel`, using Tencent's **iLink Bot API**
(same as the hermes `weixin` adapter): long-polling inbound, markdown pass-through, numbered-text
approval, and delivery ledger.

> It differs from the Telegram provider in only two ways: **transport** (`getupdates` long polling,
> no webhook/public address) and **capability facts** (`formatTier: 'markdown'`,
> `supportsEdit: false`, `supportsChoices: false`, `supportsTyping: true`).
> merge / route / approval / prompt / ledger all reuse `dsh-channel-kit`; `dsh-channel` and
> `dsh-channel-kit` need **zero changes** — exactly what A5 "the second-platform skeleton" sets out to prove.

## Plugin entry point

```ts
export const name = 'dsh-channel-wechat'
export const inject = ['channels', 'agents', 'credentials']
export const Config = Schema.object({ ... })
export function apply(ctx, config) { ... }
```

## Configuration

| Field | Required | Default | Description |
|---|---|---|---|
| `allowedUserIds` | ✅ | None | WeChat user ids allowed to use the bot (iLink-side `from_user_id`) |
| `platformAccountId` | No | credential `WECHAT_ACCOUNT_ID` | iLink bot account id (used for self-message loopback filtering) |
| `accountId` | No | `default` | dsh instance discriminator for multi-account deployments |
| `provider` | No | `deepseek-official` | agent model provider |
| `model` | No | None | agent model id |
| `cwd` | No | host `process.cwd()` | agent working directory |
| `agentPreset` | No | host default preset | agent preset id |
| `pollingTimeoutSec` | No | `30` | iLink long-polling timeout |
| `mergeWindowSec` | No | `5` | rapid-fire merge window |
| `approvalTimeoutSec` | No | `120` | approval timeout |
| `statePath` | No | `$DSH_HOME/channel-wechat/state.json` | state file path |

## Wiring example

See `cordis.patch.yml`. Credentials never land in the config file:

```bash
dsh credentials set WECHAT_TOKEN '...'        # iLink bot token
dsh credentials set WECHAT_ACCOUNT_ID '...'   # optional: iLink bot account id
```

## Capability facts (compared with Telegram)

| Fact | Telegram | WeChat |
|---|---|---|
| `formatTier` | `html` | `markdown` (the WeChat client renders markdown, passed through unchanged) |
| `maxMessageChars` | `4096` | `2000` |
| `supportsChoices` | `true` (inline keyboard) | `false` (approval/prompt degrades to numbered text) |
| `supportsEdit` | `true` | `false` (WeChat cannot edit sent messages) |
| `supportsTyping` | `true` | `true` (iLink `sendtyping`; silent no-op when the ticket is unavailable) |
| `streamingMode` | `progress` | `off` (no editing ability → final-only delivery) |

## Tool provisioning

Same as Telegram: the channel is a seam and registers no tools; when creating an agent it
**automatically joins the host default preset** (`dsh-agent-presets`), and `agentPreset` can
override it explicitly. See the `dsh-channel-telegram` README for details.

## Security

- `WECHAT_TOKEN` / `WECHAT_ACCOUNT_ID` go only through `ctx.credentials.resolve` and never land in the config file.
- The allowlist is required with no lenient default.
- The approval answerer answers only for its own agent; on timeout or for a non-own agent it always calls `next()`, never allowing by default.
- Self-message loopback filter: `from_user_id === platformAccountId` or `msg_type === 2` (bot message) is dropped outright.
- v1 does not handle media: messages with media keep only the `hasMedia` fact (no download, no CDN decryption); group chats are dropped.
