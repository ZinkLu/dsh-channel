# dsh-channel-telegram

The first `dsh-channel` provider: Telegram long polling, HTML rendering, inline-keyboard approval, delivery ledger, media send/receive.

> Media capabilities (design §10): `supportsMedia = true`. Inbound images are downloaded via
> `getFile` → `ctx.attachments.saveImage` → a model-visible image block (logged with the
> `user/message`); other media only carry `fileRef` facts. Outbound goes through `sendMedia` →
> `sendPhoto`/`sendDocument` (an `attachment` reference or a `cwd`-relative path; path escapes are rejected).

## Plugin entry point

```ts
export const name = 'dsh-channel-telegram'
export const inject = ['channels', 'agents', 'credentials']
export const Config = Schema.object({ ... })
export function apply(ctx, config) { ... }
```

The dsh loader recognizes `apply` / `inject` / `Config` from the module's named exports (this package has **no** default export).

## Configuration

| Field | Required | Default | Description |
|---|---|---|---|
| `allowedUserIds` | ✅ | none | Telegram user ids allowed to use the bot |
| `provider` | no | `deepseek-official` | agent model provider |
| `model` | no | none | agent model id |
| `cwd` | no | host `process.cwd()` | agent working directory (unset = same workspace as Web sessions) |
| `agentPreset` | no | host default preset | agent preset id; unset = join `dsh-agent-presets`'s default preset (`standard` for a standard deployment) |
| `pollingTimeoutSec` | no | `30` | Telegram long-polling timeout |
| `mergeWindowSec` | no | `5` | burst merge window |
| `approvalTimeoutSec` | no | `120` | approval timeout |
| `statePath` | no | `$DSH_HOME/channel-telegram/state.json` | state file path |

## Wiring example

See `cordis.patch.yml`.

## Tool provisioning (important)

The channel is a seam, not a tool provider — it **does not register tools itself**; but during
agent creation's `setup` it **auto-joins the host agent preset** (`dsh-agent-presets`):

- `agentPreset` unset → join the host default preset (`standard` for a standard web
  deployment); the agent gets the **exact same** tool/persona/skills capabilities as Web sessions.
- `agentPreset` set → join the specified preset (e.g. `minimal` / `code` / one you wrote).

So **don't hand-write a tool plugin or empty out the preset just to "give tools"**: that leaves
no `tools` in the agent's request, and the DeepSeek model would emit the tools it wants to call
as `<tool_calls>` XML plain text. The outbound path has another line of defense —
`stripToolCallMarkup` — that strips leaked markup, but the correct approach is to make the
preset join take effect.

## Security

- The bot token is read only via `ctx.credentials.resolve(credentialRef('TELEGRAM_BOT_TOKEN'))` and never written to a config file.
- The allowlist is required with no permissive default.
- The approval answerer only answers for its own agent; on timeout or for a non-owned agent it always calls `next()`, never defaulting to allowing.
