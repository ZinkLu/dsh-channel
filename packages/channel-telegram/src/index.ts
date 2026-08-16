import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CHANNEL_TELEGRAM_NS, CREDENTIAL_TELEGRAM_BOT_TOKEN, telegramConfigSchema, type TelegramConfig } from 'dsh-channel-config'
import { createJsonFileStore } from 'dsh-channel-kit'
import { TelegramBridge, type TelegramBridgeConfig } from './bridge.js'
import { TelegramChannel } from './channel.js'
import { TelegramClient } from './client.js'

export const name = 'dsh-channel-telegram'
export const inject = ['channels', 'agents', 'credentials'] as const

export const Config = telegramConfigSchema()
export type { TelegramConfig } from 'dsh-channel-config'

export function resolveStatePath(config: TelegramConfig): string {
  if (config.statePath) return config.statePath
  const base = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  // Multi-account: scope the ledger under the account id; the default account keeps the v1 path unchanged.
  const dir = config.accountId && config.accountId !== 'default' ? join('channel-telegram', config.accountId) : 'channel-telegram'
  return join(base, dir, 'state.json')
}

export function apply(ctx: Context, config: TelegramConfig) {
  const store = createJsonFileStore(resolveStatePath(config))
  const client = new TelegramClient({ proxyUrl: config.proxyUrl })
  const cwd = config.cwd ?? process.cwd()

  // Settings seam: resolved value = schema defaults < base(config) < user document.
  let source: () => TelegramConfig = () => config
  installSettingsSection(ctx, settingsNamespace(CHANNEL_TELEGRAM_NS), Config, config, {
    setSource: (current) => { source = current },
    onChange: () => {},
  })

  const channel = new TelegramChannel({
    client,
    accountId: config.accountId,
    resolveToken: async () => {
      const resolved = await ctx.credentials.resolve(credentialRef(CREDENTIAL_TELEGRAM_BOT_TOKEN))
      return resolved?.value
    },
    readImage: async (ref: ImageAttachmentRef) => {
      const attachments = ctx.get('attachments') as { readImage(ref: ImageAttachmentRef): Promise<{ data: Uint8Array }> } | undefined
      if (attachments === undefined) throw new Error('attachments service is not available')
      const stored = await attachments.readImage(ref)
      return stored.data
    },
    readFile: async (filePath: string) => {
      const abs = resolve(cwd, filePath)
      const rel = relative(resolve(cwd), abs)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`filePath escapes workspace: ${filePath}`)
      }
      const bytes = new Uint8Array(await readFile(abs))
      return { bytes, name: basename(filePath) }
    },
  })

  ctx.channels.register(channel)

  const bridge = new TelegramBridge(ctx, () => source() as TelegramBridgeConfig, store, channel, client)
  ctx.effect(async () => {
    await bridge.start()
    return async () => {
      await bridge.stop()
    }
  }, 'channel-telegram.serve')
}

export { TelegramBridge, TelegramChannel, TelegramClient }
export type { TelegramBridgeConfig } from './bridge.js'
export type { TelegramChannelOptions } from './channel.js'
export type * from './client.js'
