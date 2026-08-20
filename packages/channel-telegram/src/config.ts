import Schema from '@deepseek-ai/schemastery'
import { agentRoutingSchema, allowedUserIdsSchema, channelBehaviorSchema } from 'dsh-channel-kit'
import type { AgentRoutingConfig, ChannelBehaviorConfig } from 'dsh-channel-kit'

/** Settings namespace this provider registers (one per provider instance). */
export const CHANNEL_TELEGRAM_NS = 'channel-telegram'
/** Credential reference resolved through `ctx.credentials`; never part of the settings document. */
export const CREDENTIAL_TELEGRAM_BOT_TOKEN = 'TELEGRAM_BOT_TOKEN'

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
