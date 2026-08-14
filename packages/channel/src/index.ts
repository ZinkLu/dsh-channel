import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

declare module '@deepseek-ai/cordis' {
  interface Context {
    channels: ChannelRegistry
  }
  interface Events {
    /**
     * 一条归一化的入站消息已被某 provider 接收（去重后）。
     * 观察性事件：策略插件在此做审计/统计；不承载路由决定。
     * @mode emit
     */
    'channel/message'(msg: InboundMessage): void
    /**
     * 一次出站投递。策略插件可包装（改写文本、限流延迟）或
     * 短路（返回 suppressed receipt 拦下消息）；纯观察者必须调 next()。
     * innermost 默认值 = 注册表定位 Channel 并调用其 send。
     * @mode waterfall
     */
    'channel/deliver'(out: OutboundMessage, next: () => Promise<DeliveryReceipt>): Promise<DeliveryReceipt>
    /**
     * provider 连接状态变化（connecting/connected/disconnected/fatal）。
     * @mode emit
     */
    'channel/status'(channelId: string, status: ChannelStatus, error?: Error): void
    /**
     * provider 已把某条呈现帧推给平台（流式草稿/状态行/终态）。
     * 观察性事件：策略插件在此审计流式/工具流量；不承载路由或拦截决定。
     * @mode emit
     */
    'channel/present'(frame: PresentationFrame): void
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    channel: {
      kind: 'channel'
      /** provider id，如 'telegram' */
      channel: string
      /** 平台会话键（私聊=chat id，群=chat id；含义由 provider 定义，稳定即可） */
      chatKey: string
      /** 发送者平台 id */
      senderId: string
      /** 组成这条 user/message 的平台消息 id（merge 合并后可多条） */
      messageIds: string[]
    }
  }
}

/** 入站媒体事实（交接元数据，不下载字节）。图片经 provider 下载后走 `ctx.attachments.saveImage` 成模型可见块。 */
export interface InboundMedia {
  readonly kind: 'image' | 'document' | 'audio' | 'video'
  /** 平台侧文件引用（provider 定义，如 Telegram file_id / Feishu file_key）——交接事实，不下载字节 */
  readonly fileRef: string
  readonly mimeType?: string
  readonly fileName?: string
}

/** 平台无关的入站消息。media 只保留占位描述（provider 定义 fileRef），字节由 provider 按需下载。 */
export interface InboundMessage {
  readonly channel: string // provider id
  readonly chatKey: string // 稳定会话键
  readonly senderId: string
  readonly senderName?: string
  readonly messageId: string // 平台消息 id（去重键）
  readonly chatType: ChatType // 'direct' | 'group' | 'thread'
  readonly text: string
  readonly timestamp: number // epoch ms
  /** 是否带媒体：merge 据此"带附件不合并"。 */
  readonly hasMedia: boolean
  /** 媒体事实（fileRef + 元数据）；hasMedia 的展开。 */
  readonly media?: readonly InboundMedia[]
  /** 群聊中是否 @ 了机器人（provider 判定；v1 群聊不路由，仅记录） */
  readonly mentionsBot?: boolean
}

/** 出站媒体（可移植载荷：图片走 attachment 引用，文档走 cwd 相对路径，绝不裸传宿主绝对路径）。 */
export interface OutboundMedia {
  readonly kind: 'image' | 'document'
  /** 图片：ctx.attachments 的引用（不裸传宿主路径，防路径泄漏 + R7）。 */
  readonly attachment?: ImageAttachmentRef
  /** 文档：agent workspace（cwd）内的相对路径；字节由 provider 读取并锚定 cwd。 */
  readonly filePath?: string
  readonly caption?: string
}

/** 出站消息：语义内容 + 呈现意图，分段/转义是 provider 的事 */
export interface OutboundMessage {
  readonly channel: string
  readonly chatKey: string
  /** markdown 源文本；provider 按自身 formatTier 降级渲染 */
  readonly markdown: string
  /** 结构化选项（审批/澄清）；无按钮平台由消费方预先降级为编号文本 */
  readonly choices?: readonly OutboundChoice[]
  /** 出站媒体（supportsMedia 平台逐条 sendMedia；非支持平台降级为文本提示） */
  readonly media?: readonly OutboundMedia[]
  /** 幂等键：同 key 的重复 deliver 应被 ledger 挡下 */
  readonly deliveryKey: string
  /** 溯源（审计用）：来自哪个 session 的哪个事件 */
  readonly origin?: { sessionId: string; seq?: number }
  /** 呈现意图：终态 / 新建草稿 / 编辑草稿 / 状态行。策略插件据此决定是否拦截/改写。 */
  readonly presentation?: PresentationIntent
  /** presentation='draft-edit' 时指向的草稿平台消息 id。 */
  readonly editTarget?: string
}

export interface OutboundChoice {
  readonly id: string
  readonly label: string
}

export interface DeliveryReceipt {
  readonly status: 'sent' | 'suppressed' | 'failed'
  /** 平台侧消息 id（分段则为多条） */
  readonly platformMessageIds?: readonly string[]
  readonly error?: string
}

/** 呈现意图：终态消息 / 新建草稿 / 编辑已有草稿 / 状态行。 */
export type PresentationIntent = 'final' | 'draft-new' | 'draft-edit' | 'status-line'

/** 呈现上限（openclaw ChannelPresentationCapabilities.limits 的缩小版）。均 undefined=无已知上限。 */
export interface PresentationLimits {
  /** 单条消息最多按钮数；超限降级编号文本。 */
  readonly maxOptions?: number
  /** 按钮文字上限（码点）；超限截断加 `…`。 */
  readonly maxLabelLength?: number
  /** 回调数据（callback_data/value）上限（字节）；如 Telegram=64。 */
  readonly maxValueBytes?: number
}

/**
 * 呈现帧：provider 已把某条呈现事实推给平台（channel/present 事件的 payload）。
 * 与 OutboundMessage 的区别：OutboundMessage 是"投递请求"（走 deliver waterfall，
 * 可被策略插件包装/短路），PresentationFrame 是"已发生的呈现事实"（emit，只读）。
 */
export type PresentationFrame =
  | { readonly kind: 'final'; readonly channel: string; readonly chatKey: string; readonly deliveryKey: string; readonly text: string }
  | { readonly kind: 'draft-new'; readonly channel: string; readonly chatKey: string; readonly draftKey: string; readonly text: string }
  | { readonly kind: 'draft-edit'; readonly channel: string; readonly chatKey: string; readonly draftKey: string; readonly editTarget: string; readonly text: string }
  | { readonly kind: 'draft-finalize'; readonly channel: string; readonly chatKey: string; readonly draftKey: string }
  | { readonly kind: 'draft-discard'; readonly channel: string; readonly chatKey: string; readonly draftKey: string }
  | { readonly kind: 'status-line'; readonly channel: string; readonly chatKey: string; readonly text: string }

export type ChatType = 'direct' | 'group' | 'thread'
export type ChannelStatus = 'connecting' | 'connected' | 'disconnected' | 'fatal'

/**
 * 平台 provider 的抽象基类。普通抽象类而非 Service（对齐 LlmAdapter）：
 * 生命周期由 provider 插件自己的 fiber 承载，注册经 ctx.channels.register()。
 * 必选面故意极小；能力差异一律走"能力事实 + 降级"。
 */
export abstract class Channel {
  /** 稳定 provider id（'telegram'、'discord'…），注册表键 */
  abstract readonly id: string

  // ---- 能力事实：基类保守默认，实现覆盖 ----

  /** 单条消息最大字符数；undefined = 无已知上限 */
  get maxMessageChars(): number | undefined {
    return undefined
  }
  /** 富文本档位：消费方据此选择 format 降级路径 */
  get formatTier(): 'plain' | 'markdown' | 'html' {
    return 'plain'
  }
  /** 是否支持结构化选项（按钮/卡片）；false 时审批降级为编号回复 */
  get supportsChoices(): boolean {
    return false
  }
  /** 是否支持编辑已发消息（草稿式流式的前提，v2） */
  get supportsEdit(): boolean {
    return false
  }
  /** 是否支持 typing 指示 */
  get supportsTyping(): boolean {
    return false
  }
  /** 支持的会话形态 */
  get chatTypes(): readonly ChatType[] {
    return ['direct']
  }

  // ---- 呈现能力事实：基类保守默认（照抄 FileSystem.sandboxMode 写法）----

  /** 流式档位。'off'=只终态；'progress'=一条可编辑状态草稿+终态；'block'=分块草稿（v2）。
   *  需要 supportsEdit 才能是非 off；无编辑能力的平台永远 off。 */
  get streamingMode(): 'off' | 'block' | 'progress' {
    return 'off'
  }
  /** 是否以文本呈现"正在做 X…"状态行（hermes supports_status_text，Slack 类）；textless 平台保持 false。 */
  get supportsStatusText(): boolean {
    return false
  }
  /** 是否向渠道下放 reasoning/thinking 内容；默认 false（不泄漏思考链）。 */
  get supportsThinking(): boolean {
    return false
  }
  /** 呈现上限（按钮数/按钮文字/回调数据）。 */
  get presentationLimits(): PresentationLimits {
    return {}
  }
  /** 是否支持多选选项；false 时多选降级为"逐条单选 + 文本补充"。 */
  get supportsMultiSelect(): boolean {
    return false
  }
  /** 是否支持发送媒体（图片/文档）。false 时出站媒体降级为"无法投递"文本。 */
  get supportsMedia(): boolean {
    return false
  }

  // ---- 必选行为 ----

  /**
   * 发送一段已按平台约束渲染好的文本（可选附带 choices）。
   * 分段由调用方完成；实现只负责单条上行与错误报告。
   */
  abstract send(
    chatKey: string,
    text: string,
    opts?: {
      choices?: readonly OutboundChoice[]
      signal?: AbortSignal
    },
  ): Promise<{ platformMessageId: string }>

  // ---- 可选行为：默认无害降级 ----

  /** typing 指示；默认 no-op */
  async sendTyping(_chatKey: string): Promise<void> {}

  /**
   * 发送一条媒体（图片/文档）。仅 `supportsMedia` 平台实现；基类抛错（hermes
   * send_image/send_file 的"可选方法 + 降级"同款——消费方应先查 supportsMedia）。
   */
  async sendMedia(
    _chatKey: string,
    _media: OutboundMedia,
    _opts?: { signal?: AbortSignal },
  ): Promise<{ platformMessageId: string }> {
    throw new Error(`${this.id} does not support media`)
  }
}

/** 把注册表作为服务安装到当前上下文（插件入口）。 */
export function apply(ctx: Context): void {
  new ChannelRegistry(ctx)
}

export class ChannelRegistry extends Service {
  private entries = new Map<string, Channel>()

  constructor(ctx: Context) {
    super(ctx, 'channels')
  }

  /**
   * 注册一个 provider。重复 id 抛错。经 ctx.effect 返回 disposer：
   * provider 卸载时注册自动回收。
   */
  register(channel: Channel): () => void {
    return this.ctx.effect(() => {
      if (this.entries.has(channel.id)) {
        throw new Error(`channel "${channel.id}" is already registered`)
      }
      this.entries.set(channel.id, channel)
      return () => {
        this.entries.delete(channel.id)
      }
    }, 'channels.register()') as () => void
  }

  get(id: string): Channel | undefined {
    return this.entries.get(id)
  }

  list(): Channel[] {
    return [...this.entries.values()]
  }

  /** provider 收到去重后的入站消息时调用：归一化断言 + 广播 */
  ingest(msg: InboundMessage): void {
    assertInboundMessage(msg)
    this.ctx.emit('channel/message', msg)
  }

  /**
   * 出站统一入口：走 channel/deliver waterfall，innermost 默认值定位
   * provider 并 send。策略插件（限流/脱敏/审计）在 waterfall 上包装或短路。
   */
  async deliver(out: OutboundMessage): Promise<DeliveryReceipt> {
    return this.ctx.waterfall('channel/deliver', out, async (): Promise<DeliveryReceipt> => {
      const channel = this.entries.get(out.channel)
      if (channel === undefined) return { status: 'failed', error: `no channel "${out.channel}"` }
      try {
        const platformMessageIds: string[] = []
        // 文本（空文本不出站，仅媒体时不发空气泡）。
        if (out.markdown !== '') {
          const result = await channel.send(out.chatKey, out.markdown, { choices: out.choices })
          platformMessageIds.push(result.platformMessageId)
        }
        // 媒体：supportsMedia 平台走 sendMedia；否则降级为"无法投递"文本（hermes 教训：绝不回显宿主路径）。
        for (const media of out.media ?? []) {
          if (channel.supportsMedia) {
            const result = await channel.sendMedia(out.chatKey, media)
            platformMessageIds.push(result.platformMessageId)
          } else {
            const result = await channel.send(out.chatKey, mediaUnsupportedText(media.kind))
            platformMessageIds.push(result.platformMessageId)
          }
        }
        return { status: 'sent', platformMessageIds }
      } catch (error) {
        return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
      }
    })
  }
}

export default ChannelRegistry

function mediaUnsupportedText(kind: 'image' | 'document'): string {
  return kind === 'image' ? '⚠️ 无法投递图片附件。' : '⚠️ 无法投递文件附件。'
}

function assertInboundMessage(msg: InboundMessage): void {
  if (!msg.channel) throw new Error('InboundMessage.channel must be a non-empty string')
  if (!msg.chatKey) throw new Error('InboundMessage.chatKey must be a non-empty string')
  if (!msg.senderId) throw new Error('InboundMessage.senderId must be a non-empty string')
  if (!msg.messageId) throw new Error('InboundMessage.messageId must be a non-empty string')
  if (!Number.isFinite(msg.timestamp)) throw new Error('InboundMessage.timestamp must be a finite number')
}
