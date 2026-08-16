import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CHANNEL_WECHAT_NS, CREDENTIAL_WECHAT_TOKEN, wechatConfigSchema, type WeChatConfig } from 'dsh-channel-config'
import { createJsonFileStore } from 'dsh-channel-kit'
import { WeChatBridge, type WeChatBridgeConfig } from './bridge.js'
import { WeChatChannel } from './channel.js'
import { WeixinClient } from './client.js'

export const name = 'dsh-channel-wechat'
export const inject = ['channels', 'agents', 'credentials'] as const

export const Config = wechatConfigSchema()
export type { WeChatConfig } from 'dsh-channel-config'

export function resolveStatePath(config: WeChatConfig): string {
  if (config.statePath) return config.statePath
  const base = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  // Multi-account: scope the ledger under the account id; the default account keeps the v1 path unchanged.
  const dir = config.accountId && config.accountId !== 'default' ? join('channel-wechat', config.accountId) : 'channel-wechat'
  return join(base, dir, 'state.json')
}

export function apply(ctx: Context, config: WeChatConfig) {
  const store = createJsonFileStore(resolveStatePath(config))
  const client = new WeixinClient({ proxyUrl: config.proxyUrl })

  // Settings seam: resolved value = schema defaults < base(config) < user document.
  let source: () => WeChatConfig = () => config
  installSettingsSection(ctx, settingsNamespace(CHANNEL_WECHAT_NS), Config, config, {
    setSource: (current) => { source = current },
    onChange: () => {},
  })

  const channel = new WeChatChannel({
    client,
    accountId: config.accountId,
    resolveToken: async () => {
      const resolved = await ctx.credentials.resolve(credentialRef(CREDENTIAL_WECHAT_TOKEN))
      return resolved?.value
    },
  })

  ctx.channels.register(channel)

  const bridge = new WeChatBridge(ctx, () => source() as WeChatBridgeConfig, store, channel, client)
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
