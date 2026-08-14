import { Channel, type ChatType, type OutboundChoice } from 'dsh-channel'
import type { FeishuClient, FeishuCredentials } from './client.js'

export interface FeishuChannelOptions {
  /** Re-resolve app credentials on every send; caching across operations is forbidden. */
  resolveCredentials: () => Promise<FeishuCredentials | undefined>
  client: FeishuClient
}

export class FeishuChannel extends Channel {
  readonly id = 'feishu'
  private readonly opts: FeishuChannelOptions

  constructor(opts: FeishuChannelOptions) {
    super()
    this.opts = opts
  }

  // Feishu text messages are capped at 4096 chars (same as openclaw/mimiclaw).
  get maxMessageChars(): number | undefined {
    return 4096
  }
  // Feishu text messages are plain text; rich text (post/card) needs complex structures, which v1 does not implement.
  get formatTier(): 'plain' | 'markdown' | 'html' {
    return 'plain'
  }
  // v1 does not implement interactive cards; approvals/questions degrade to numbered text.
  get supportsChoices(): boolean {
    return false
  }
  // Feishu supports editable messages (im.message.update), but v1 does not implement draft streaming.
  get supportsEdit(): boolean {
    return false
  }
  // Feishu bots have no typing indicator.
  get supportsTyping(): boolean {
    return false
  }
  get chatTypes(): readonly ChatType[] {
    return ['direct']
  }
  get streamingMode(): 'off' | 'block' | 'progress' {
    return 'off'
  }
  get supportsStatusText(): boolean {
    return false
  }
  get supportsThinking(): boolean {
    return false
  }
  get supportsMultiSelect(): boolean {
    return false
  }

  async send(
    chatKey: string,
    text: string,
    opts?: { choices?: readonly OutboundChoice[]; signal?: AbortSignal },
  ): Promise<{ platformMessageId: string }> {
    const credentials = await this.opts.resolveCredentials()
    if (!credentials) throw new Error('FEISHU_APP_ID / FEISHU_APP_SECRET are not configured')

    const token = await this.opts.client.getTenantAccessToken(credentials)
    const messageId = await this.opts.client.sendMessage(token, chatKey, text, { signal: opts?.signal })
    return { platformMessageId: messageId }
  }
}
