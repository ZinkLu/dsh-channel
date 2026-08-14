import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createJsonFileStore } from 'dsh-channel-kit'
import { TelegramChannel } from './channel.js'
import { TelegramClient } from './client.js'
import { TelegramBridge, type TelegramBridgeConfig } from './bridge.js'

export const name = 'dsh-channel-telegram'
export const inject = ['channels', 'agents', 'credentials'] as const

export interface TelegramConfig {
  /** 允许的 Telegram user id。必填、无宽松默认（提示注入的前门）。 */
  allowedUserIds: number[]
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
  allowedUserIds: Schema.array(Schema.number()).required(),
  provider: Schema.string().default('deepseek-official'),
  model: Schema.string(),
  cwd: Schema.string(),
  agentPreset: Schema.string(),
  pollingTimeoutSec: Schema.number().default(30),
  mergeWindowSec: Schema.number().default(5),
  approvalTimeoutSec: Schema.number().default(120),
  statePath: Schema.string(),
})

export function resolveStatePath(config: TelegramConfig): string {
  if (config.statePath) return config.statePath
  const base = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, 'channel-telegram', 'state.json')
}

export function apply(ctx: Context, config: TelegramConfig) {
  const store = createJsonFileStore(resolveStatePath(config))
  const client = new TelegramClient()
  const cwd = config.cwd ?? process.cwd()
  const channel = new TelegramChannel({
    client,
    resolveToken: async () => {
      const resolved = await ctx.credentials.resolve(credentialRef('TELEGRAM_BOT_TOKEN'))
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

  const bridge = new TelegramBridge(ctx, config as TelegramBridgeConfig, store, channel, client)
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
