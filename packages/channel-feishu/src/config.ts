import Schema from '@deepseek-ai/schemastery'
import { agentRoutingSchema, allowedUserIdsSchema, channelBehaviorSchema } from 'dsh-channel-kit'
import type { AgentRoutingConfig, ChannelBehaviorConfig } from 'dsh-channel-kit'

/** Settings namespace this provider registers (one per provider instance). */
export const CHANNEL_FEISHU_NS = 'channel-feishu'
/** Credential references resolved through `ctx.credentials`; never part of the settings document. */
export const CREDENTIAL_FEISHU_APP_ID = 'FEISHU_APP_ID'
export const CREDENTIAL_FEISHU_APP_SECRET = 'FEISHU_APP_SECRET'

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
