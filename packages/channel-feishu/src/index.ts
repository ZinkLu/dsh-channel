import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CHANNEL_FEISHU_NS, CREDENTIAL_FEISHU_APP_ID, CREDENTIAL_FEISHU_APP_SECRET, feishuConfigSchema, type FeishuConfig } from 'dsh-channel-config'
import { createJsonFileStore } from 'dsh-channel-kit'
import { FeishuBridge, type FeishuBridgeConfig } from './bridge.js'
import { FeishuChannel } from './channel.js'
import { FeishuClient, FeishuWsClient } from './client.js'

export const name = 'dsh-channel-feishu'
export const inject = ['channels', 'agents', 'credentials'] as const

export const Config = feishuConfigSchema()
export type { FeishuConfig } from 'dsh-channel-config'

export function resolveStatePath(config: FeishuConfig): string {
  if (config.statePath) return config.statePath
  const base = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, 'channel-feishu', 'state.json')
}

export function apply(ctx: Context, config: FeishuConfig) {
  const store = createJsonFileStore(resolveStatePath(config))
  const client = new FeishuClient({ domain: config.domain })

  // Settings seam: resolved value = schema defaults < base(config) < user document.
  let source: () => FeishuConfig = () => config
  installSettingsSection(ctx, settingsNamespace(CHANNEL_FEISHU_NS), Config, config, {
    setSource: (current) => { source = current },
    onChange: () => {},
  })

  const channel = new FeishuChannel({
    client,
    resolveCredentials: async () => {
      const appId = await ctx.credentials.resolve(credentialRef(CREDENTIAL_FEISHU_APP_ID))
      const appSecret = await ctx.credentials.resolve(credentialRef(CREDENTIAL_FEISHU_APP_SECRET))
      if (!appId?.value || !appSecret?.value) return undefined
      return { appId: appId.value, appSecret: appSecret.value }
    },
  })

  ctx.channels.register(channel)

  const bridge = new FeishuBridge(ctx, () => source() as FeishuBridgeConfig, store, channel, client)
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
