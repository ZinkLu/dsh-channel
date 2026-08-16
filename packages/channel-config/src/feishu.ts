import Schema from '@deepseek-ai/schemastery'
import { agentRoutingSchema, channelBehaviorSchema, allowedUserIdsSchema } from './common.js'
import type { AgentRoutingConfig, ChannelBehaviorConfig } from './common.js'

export interface FeishuConfig extends AgentRoutingConfig, ChannelBehaviorConfig {
  /** Feishu user open_ids (starting with ou_) allowed to use the bot. Required. */
  allowedUserIds: string[]
  /** Feishu / Lark domain; defaults to feishu, set lark for Lark international. */
  domain?: 'feishu' | 'lark'
}

export function feishuConfigSchema() {
  return Schema.object({
    ...allowedUserIdsSchema('string'),
    ...agentRoutingSchema(),
    ...channelBehaviorSchema(),
    domain: Schema.union(['feishu', 'lark'] as const).default('feishu'),
  })
}
