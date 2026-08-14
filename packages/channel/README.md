# dsh-channel

DSH message channel contract package: the `ctx.channels` registry, the `Channel` abstract base class, the `channel/*` event vocabulary, and `MessageSourceMap.channel` merging. Zero platform implementations.

## Exports

- `ChannelRegistry` (the default export can also be loaded directly as a Cordis class plugin)
- `Channel` (abstract base class)
- `apply(ctx)`: installs `ChannelRegistry` onto the current context
- Types: `InboundMessage` / `OutboundMessage` / `OutboundChoice` / `DeliveryReceipt` / `ChatType` / `ChannelStatus`

## Events

| Event | Mode | Description |
|---|---|---|
| `channel/message` | emit | provider received a deduplicated inbound message |
| `channel/deliver` | waterfall | outbound delivery; policy plugins can wrap/short-circuit, observers must call `next()` |
| `channel/status` | emit | provider connection status |

## Usage

```ts
import { Context } from '@deepseek-ai/cordis'
import { ChannelRegistry } from 'dsh-channel'

const ctx = new Context()
new ChannelRegistry(ctx)
// or ctx.plugin(ChannelRegistry)
```
