# dsh-channel

DSH 消息渠道契约包：`ctx.channels` 注册表、`Channel` 抽象基类、`channel/*` 事件词汇表、`MessageSourceMap.channel` 归并。零平台实现。

## 导出

- `ChannelRegistry`（default 导出也可直接作为 Cordis class 插件加载）
- `Channel`（抽象基类）
- `apply(ctx)`：安装 `ChannelRegistry` 到当前 context
- 类型：`InboundMessage` / `OutboundMessage` / `OutboundChoice` / `DeliveryReceipt` / `ChatType` / `ChannelStatus`

## 事件

| 事件 | 模式 | 说明 |
|---|---|---|
| `channel/message` | emit | provider 收到去重后的入站消息 |
| `channel/deliver` | waterfall | 出站投递；策略插件可包装/短路，观察者必须 `next()` |
| `channel/status` | emit | provider 连接状态 |

## 使用

```ts
import { Context } from '@deepseek-ai/cordis'
import { ChannelRegistry } from 'dsh-channel'

const ctx = new Context()
new ChannelRegistry(ctx)
// 或 ctx.plugin(ChannelRegistry)
```
