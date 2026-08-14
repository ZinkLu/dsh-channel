import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createJsonFileStore } from 'dsh-channel-kit'
import { FeishuChannel } from './channel.js'
import { FeishuClient, FeishuWsClient } from './client.js'
import { FeishuBridge, type FeishuBridgeConfig } from './bridge.js'

export const name = 'dsh-channel-feishu'
export const inject = ['channels', 'agents', 'credentials'] as const

export interface FeishuConfig {
  /** Feishu user open_ids (starting with ou_) allowed to use the bot. Required, no permissive default. */
  allowedUserIds: string[]
  /** Feishu / Lark domain; defaults to feishu, set lark for Lark international. */
  domain?: 'feishu' | 'lark'
  provider: string
  model?: string
  cwd?: string
  agentPreset?: string
  mergeWindowSec: number
  approvalTimeoutSec: number
  statePath?: string
}

export const Config = Schema.object({
  allowedUserIds: Schema.array(Schema.string()).required(),
  domain: Schema.union(['feishu', 'lark'] as const).default('feishu'),
  provider: Schema.string().default('deepseek-official'),
  model: Schema.string(),
  cwd: Schema.string(),
  agentPreset: Schema.string(),
  mergeWindowSec: Schema.number().default(5),
  approvalTimeoutSec: Schema.number().default(120),
  statePath: Schema.string(),
})

export function resolveStatePath(config: FeishuConfig): string {
  if (config.statePath) return config.statePath
  const base = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, 'channel-feishu', 'state.json')
}

export function apply(ctx: Context, config: FeishuConfig) {
  const store = createJsonFileStore(resolveStatePath(config))
  const client = new FeishuClient({ domain: config.domain })

  const channel = new FeishuChannel({
    client,
    resolveCredentials: async () => {
      const appId = await ctx.credentials.resolve(credentialRef('FEISHU_APP_ID'))
      const appSecret = await ctx.credentials.resolve(credentialRef('FEISHU_APP_SECRET'))
      if (!appId?.value || !appSecret?.value) return undefined
      return { appId: appId.value, appSecret: appSecret.value }
    },
  })

  ctx.channels.register(channel)

  const bridge = new FeishuBridge(ctx, config as FeishuBridgeConfig, store, channel, client)
  ctx.effect(async () => {
    await bridge.start()
    return async () => {
      await bridge.stop()
    }
  }, 'channel-feishu.serve')
}

export { FeishuBridge, FeishuChannel, FeishuClient, FeishuWsClient }
export { decodeFrame, encodeFrame } from './proto.js'
export type { FeishuBridgeConfig } from './bridge.js'
export type { FeishuChannelOptions } from './channel.js'
export type * from './client.js'
export type * from './proto.js'
