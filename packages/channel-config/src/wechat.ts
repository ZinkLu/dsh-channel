import Schema from '@deepseek-ai/schemastery'
import { agentRoutingSchema, channelBehaviorSchema, allowedUserIdsSchema } from './common.js'
import type { AgentRoutingConfig, ChannelBehaviorConfig } from './common.js'

export interface WeChatConfig extends AgentRoutingConfig, ChannelBehaviorConfig {
  /** WeChat user ids allowed to use the bot (iLink-side from_user_id). Required. */
  allowedUserIds: string[]
  /** iLink bot account id (platform-side); when unset, read from the WECHAT_ACCOUNT_ID credential. */
  platformAccountId?: string
  /** Long-poll timeout, in seconds. */
  pollingTimeoutSec: number
}

export function wechatConfigSchema() {
  return Schema.object({
    ...allowedUserIdsSchema('string'),
    ...agentRoutingSchema(),
    ...channelBehaviorSchema(),
    pollingTimeoutSec: Schema.number().default(30),
    platformAccountId: Schema.string(),
  })
}
