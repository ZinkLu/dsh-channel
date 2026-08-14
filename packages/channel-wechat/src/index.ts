import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createJsonFileStore } from 'dsh-channel-kit'
import { WeChatChannel } from './channel.js'
import { WeixinClient } from './client.js'
import { WeChatBridge, type WeChatBridgeConfig } from './bridge.js'

export const name = 'dsh-channel-wechat'
export const inject = ['channels', 'agents', 'credentials'] as const

export interface WeChatConfig {
  /** WeChat user ids allowed to use the bot (iLink-side from_user_id). Required; no lenient default. */
  allowedUserIds: string[]
  /** iLink bot account id; when unset, read from the WECHAT_ACCOUNT_ID credential. */
  accountId?: string
  provider: string
  model?: string
  cwd?: string
  agentPreset?: string
  pollingTimeoutSec: number
  mergeWindowSec: number
  approvalTimeoutSec: number
  statePath?: string
}

export const Config = Schema.object({
  allowedUserIds: Schema.array(Schema.string()).required(),
  accountId: Schema.string(),
  provider: Schema.string().default('deepseek-official'),
  model: Schema.string(),
  cwd: Schema.string(),
  agentPreset: Schema.string(),
  pollingTimeoutSec: Schema.number().default(30),
  mergeWindowSec: Schema.number().default(5),
  approvalTimeoutSec: Schema.number().default(120),
  statePath: Schema.string(),
})

export function resolveStatePath(config: WeChatConfig): string {
  if (config.statePath) return config.statePath
  const base = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, 'channel-wechat', 'state.json')
}

export function apply(ctx: Context, config: WeChatConfig) {
  const store = createJsonFileStore(resolveStatePath(config))
  const client = new WeixinClient()

  const channel = new WeChatChannel({
    client,
    resolveToken: async () => {
      const resolved = await ctx.credentials.resolve(credentialRef('WECHAT_TOKEN'))
      return resolved?.value
    },
  })

  ctx.channels.register(channel)

  const bridge = new WeChatBridge(ctx, config as WeChatBridgeConfig, store, channel, client)
  ctx.effect(async () => {
    await bridge.start()
    return async () => {
      await bridge.stop()
    }
  }, 'channel-wechat.serve')
}

export { WeChatBridge, WeChatChannel, WeixinClient }
export type { WeChatBridgeConfig } from './bridge.js'
export type { WeChatChannelOptions } from './channel.js'
export type * from './client.js'
