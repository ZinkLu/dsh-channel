import { Channel, type ChatType, type OutboundChoice } from 'dsh-channel'
import type { FeishuClient, FeishuCredentials } from './client.js'

export interface FeishuChannelOptions {
  /** 每次发送时重新解析 app 凭据；禁止跨操作缓存。 */
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

  // 飞书 text 消息上限 4096 字符（openclaw/mimiclaw 同款）。
  get maxMessageChars(): number | undefined {
    return 4096
  }
  // 飞书 text 消息是纯文本；富文本（post/card）需复杂结构，v1 不做。
  get formatTier(): 'plain' | 'markdown' | 'html' {
    return 'plain'
  }
  // v1 不做交互式卡片，审批/提问降级编号文本。
  get supportsChoices(): boolean {
    return false
  }
  // 飞书可编辑消息（im.message.update），但 v1 不做草稿流式。
  get supportsEdit(): boolean {
    return false
  }
  // 飞书 bot 无 typing 指示。
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
