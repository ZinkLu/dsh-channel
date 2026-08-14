export interface RouteContext {
  readonly channel: string
  readonly boundSessions: Readonly<Record<string, string>> // chatKey → sessionId（store.bindings）
  readonly liveSessionIds: readonly string[] // ctx.agents.list() 投影
}

export type RouteDecision =
  | { kind: 'command'; command: string; args: string } // /开头，本地处理
  | { kind: 'approval-reply'; raw: string } // 交给 approval-render.parse
  | { kind: 'route'; sessionId: string; create: boolean } // 投递目标
  | { kind: 'drop'; reason: 'group-unsupported' | 'empty' }

export interface RouterOptions {
  /** 判定"看起来像审批应答"的谓词；由消费方注入 pending 上下文，避免裸数字误判。 */
  isApprovalReply?: (text: string) => boolean
  /** sessionId 前缀；默认 'channel'。 */
  sessionIdPrefix?: string
}

export function route(
  msg: { chatKey: string; text: string; chatType: 'direct' | 'group' | 'thread'; mentionsBot?: boolean },
  ctx: RouteContext,
  opts: RouterOptions = {},
): RouteDecision {
  const prefix = opts.sessionIdPrefix ?? 'channel'
  const text = msg.text.trim()

  if (text === '') return { kind: 'drop', reason: 'empty' }

  // v1 群聊不路由（chatnode 立场：iLink 群语义不清 + 提示注入面大）。
  if (msg.chatType !== 'direct') {
    return { kind: 'drop', reason: 'group-unsupported' }
  }

  if (text.startsWith('/')) {
    const space = text.search(/\s/)
    const command = space === -1 ? text.slice(1) : text.slice(1, space)
    const args = space === -1 ? '' : text.slice(space + 1).trim()
    return { kind: 'command', command: command.toLowerCase(), args }
  }

  if (opts.isApprovalReply?.(text)) {
    return { kind: 'approval-reply', raw: msg.text }
  }

  const bound = ctx.boundSessions[msg.chatKey]
  if (bound) {
    return { kind: 'route', sessionId: bound, create: false }
  }

  // 默认策略：每 chat 一会话，sessionId 约定 channel:<channelId>:<chatKey>。
  const sessionId = `${prefix}:${ctx.channel}:${msg.chatKey}`
  return { kind: 'route', sessionId, create: true }
}
