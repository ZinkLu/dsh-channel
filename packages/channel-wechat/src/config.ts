import Schema from '@deepseek-ai/schemastery'
import { agentRoutingSchema, allowedUserIdsSchema, channelBehaviorSchema } from 'dsh-channel-kit'
import type { AgentRoutingConfig, ChannelBehaviorConfig } from 'dsh-channel-kit'

/** Settings namespace this provider registers (one per provider instance). */
export const CHANNEL_WECHAT_NS = 'channel-wechat'
/** Credential references resolved through `ctx.credentials`; never part of the settings document. */
export const CREDENTIAL_WECHAT_TOKEN = 'WECHAT_TOKEN'
export const CREDENTIAL_WECHAT_ACCOUNT_ID = 'WECHAT_ACCOUNT_ID'

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
