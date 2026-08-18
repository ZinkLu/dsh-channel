export interface RouteContext {
  readonly channel: string
  /** Instance discriminator for multi-account deployments; 'default' (or omitted) keeps the single-account session id. */
  readonly accountId?: string
  readonly boundSessions: Readonly<Record<string, string>> // chatKey → sessionId (store.bindings)
  readonly liveSessionIds: readonly string[] // projection of ctx.agents.list()
}

export type RouteDecision =
  | { kind: 'command'; command: string; args: string } // starts with /, handled locally
  | { kind: 'approval-reply'; raw: string } // handed to approval-render.parse
  | { kind: 'route'; sessionId: string; create: boolean } // delivery target
  | { kind: 'drop'; reason: 'group-unsupported' | 'empty' }

export interface RouterOptions {
  /** Predicate deciding "this looks like an approval reply"; injected by the consumer with pending context to avoid misjudging bare numbers. */
  isApprovalReply?: (text: string) => boolean
  /** sessionId prefix; default 'channel'. */
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

  // v1 does not route group chats (unclear ownership semantics + a large prompt-injection surface).
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

  // Default policy: one session per chat, with the sessionId convention channel:<channelId>[:<accountId>]:<chatKey>.
  // The account segment appears only for a non-default account, so single-account session ids are byte-for-byte unchanged.
  const account = ctx.accountId && ctx.accountId !== 'default' ? `:${ctx.accountId}` : ''
  const sessionId = `${prefix}:${ctx.channel}${account}:${msg.chatKey}`
  return { kind: 'route', sessionId, create: true }
}
