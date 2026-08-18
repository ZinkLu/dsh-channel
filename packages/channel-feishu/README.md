# dsh-channel-feishu

The Feishu / Lark provider for `dsh-channel`, using Open API for sending + **long-connection
(WebSocket) mode** for inbound, with no public address and no webhook required.

> The only differences from Telegram/WeChat are transport and capability facts:
> `formatTier: 'plain'` (Feishu text messages are plain text), `supportsChoices: false` (v1 has no
> interactive cards), `supportsTyping: false` (bots have no typing), `supportsEdit: false` (v1 has
> no draft streaming). merge / route / approval / prompt / ledger all reuse `dsh-channel-kit`, with
> **zero changes** to `dsh-channel` and `dsh-channel-kit` (A5).

## Plugin entry

```ts
export const name = 'dsh-channel-feishu'
export const inject = ['channels', 'agents', 'credentials']
export const Config = Schema.object({ ... })
export function apply(ctx, config) { ... }
```

## Configuration

| Field | Required | Default | Description |
|---|---|---|---|
| `allowedUserIds` | ✅ | none | Feishu user `open_id`s (`ou_`-prefixed) allowed to use the bot |
| `domain` | no | `feishu` | `feishu` (Feishu) or `lark` (Lark international) |
| `provider` | no | `deepseek-official` | agent model provider |
| `model` | no | none | agent model id |
| `cwd` | no | host `process.cwd()` | agent working directory |
| `agentPreset` | no | host default preset | agent preset id |
| `mergeWindowSec` | no | `5` | burst-merge window |
| `approvalTimeoutSec` | no | `120` | approval timeout |
| `statePath` | no | `$DSH_HOME/channel-feishu/state.json` | state file path |

## Credentials and onboarding

1. Create a self-built app on the [Feishu Open Platform](https://open.feishu.cn/) and get the
   **App ID / App Secret**.
2. Enable the `im:message` and `im:message:send_as_bot` scopes (to send and receive messages).
3. Choose **long-connection mode** for event subscription and subscribe to `im.message.receive_v1`.
4. Credentials go only through `ctx.credentials`, never into the config file:

```bash
dsh credentials set FEISHU_APP_ID 'cli_xxx'
dsh credentials set FEISHU_APP_SECRET 'xxx'
```

## Capability facts (three-platform comparison)

| Fact | Telegram | WeChat | Feishu |
|---|---|---|---|
| `formatTier` | `html` | `markdown` | `plain` |
| `maxMessageChars` | `4096` | `2000` | `4096` |
| `supportsChoices` | `true` | `false` | `false` |
| `supportsEdit` | `true` | `false` | `false` |
| `supportsTyping` | `true` | `true` | `false` |
| `streamingMode` | `progress` | `off` | `off` |

## Long connection vs webhook

This package defaults to **long-connection mode** (`POST /callback/ws/endpoint` to get the wss
address + protobuf envelope send/receive), so the process opens a persistent connection directly
with Feishu. If the host already has an HTTP service and wants to use webhooks, it can reuse this
package's `bridge.handleEvent(event)` as the event entry point (it is also the long-connection
client's internal callback); `dsh-channel` / `dsh-channel-kit` are unchanged.

## Tool provisioning

Same as Telegram: the channel is a seam and registers no tools; creating an agent **auto-joins the
host default preset**.

## Security

- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` go only through `ctx.credentials.resolve`, never into the config file.
- The allowlist is required with no permissive default (open_id is the prompt-injection front door).
- The approval answerer only answers for its own agent; on timeout or for a non-own agent it always calls `next()`, never defaulting to allowing.
- v1 only processes `text` messages; non-text messages only retain the `hasMedia` fact; group chats (`chat_type=group`) are dropped.
