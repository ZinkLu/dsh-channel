import Schema from '@deepseek-ai/schemastery'
import { agentRoutingSchema, channelBehaviorSchema, allowedUserIdsSchema } from './common.js'
import type { AgentRoutingConfig, ChannelBehaviorConfig } from './common.js'

export interface TelegramConfig extends AgentRoutingConfig, ChannelBehaviorConfig {
  /** Allowed Telegram user ids. Required, no permissive default. */
  allowedUserIds: number[]
  /** Long-poll timeout, in seconds. */
  pollingTimeoutSec: number
}

export function telegramConfigSchema() {
  return Schema.object({
    ...allowedUserIdsSchema('number'),
    ...agentRoutingSchema(),
    ...channelBehaviorSchema(),
    pollingTimeoutSec: Schema.number().default(30),
  })
}
