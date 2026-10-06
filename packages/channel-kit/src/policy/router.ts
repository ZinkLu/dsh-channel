/**
 * Router: platform conversation → dsh session.
 *
 * The upstream decision is a resolver chain (backlog §2.2 tri-state): each
 * resolver returns a hit, `null` (explicit rejection — stops the chain), or
 * `undefined` (no opinion — the next resolver speaks). Every hit carries a
 * `provenance` tag so consumers can tell WHY a message landed on a session.
 *
 * The default chain is exactly the historical behavior:
 *   1. focus      — the chat's stored binding (the manager-era focus pointer)
 *   2. convention — one session per chat, `channel:<id>[:<account>]:<chatKey>`
 *
 * A `SessionManager` consumer does not add a resolver here: the focus pointer
 * lives in the same `boundSessions` map, and the manager's own session ids
 * arrive through `/use`-written bindings. The chain is the seam where a
 * stricter policy (per-chat upstream veto) would plug in.
 */

export interface RouteContext {
  readonly channel: string
  /** Instance discriminator for multi-account deployments; 'default' (or omitted) keeps the single-account session id. */
  readonly accountId?: string
  readonly boundSessions: Readonly<Record<string, string>> // chatKey → sessionId (store.bindings)
  readonly liveSessionIds: readonly string[] // projection of ctx.agents.list()
}

/** Why a message landed on the session it did. */
export type UpstreamProvenance = 'focus' | 'convention' | (string & {})

export interface UpstreamResolution {
  readonly sessionId: string
  readonly create: boolean
  readonly provenance: UpstreamProvenance
}

export interface RouteMessage {
  chatKey: string
  text: string
  chatType: 'direct' | 'group' | 'thread'
  mentionsBot?: boolean
}

/**
 * One link of the upstream chain. Return a hit to resolve, `null` to reject
 * the message explicitly (the chain stops, route() drops it), `undefined` to
 * pass — pure and synchronous, so the chain stays testable without a bridge.
 */
export type UpstreamResolver = (msg: RouteMessage, ctx: RouteContext) => UpstreamResolution | null | undefined

export type RouteDecision =
  | { kind: 'command'; command: string; args: string } // starts with /, handled locally
  | { kind: 'approval-reply'; raw: string } // handed to approval-render.parse
  | { kind: 'route'; sessionId: string; create: boolean; provenance: UpstreamProvenance } // delivery target
  | { kind: 'drop'; reason: 'group-unsupported' | 'empty' | 'rejected' }

export interface RouterOptions {
  /** Predicate deciding "this looks like an approval reply"; injected by the consumer with pending context to avoid misjudging bare numbers. */
  isApprovalReply?: (text: string) => boolean
  /** sessionId prefix; default 'channel'. */
  sessionIdPrefix?: string
  /** Override the default [focus, convention] upstream chain. */
  resolvers?: readonly UpstreamResolver[]
}

/** The stored binding is the chat's focus pointer (`/use`, `/bind`, `/new` write it). */
export const focusResolver: UpstreamResolver = (msg, ctx) => {
  const bound = ctx.boundSessions[msg.chatKey]
  if (bound === undefined || bound === '') return undefined
  return { sessionId: bound, create: false, provenance: 'focus' }
}

/**
 * Default policy: one session per chat, with the sessionId convention
 * `<prefix>:<channelId>[:<accountId>]:<chatKey>`. The account segment appears
 * only for a non-default account, so single-account session ids are
 * byte-for-byte unchanged.
 */
export function conventionResolver(prefix = 'channel'): UpstreamResolver {
  return (msg, ctx) => {
    const account = ctx.accountId && ctx.accountId !== 'default' ? `:${ctx.accountId}` : ''
    return { sessionId: `${prefix}:${ctx.channel}${account}:${msg.chatKey}`, create: true, provenance: 'convention' }
  }
}

/** The historical chain, in order. */
export const defaultUpstreamResolvers: readonly UpstreamResolver[] = [focusResolver, conventionResolver()]

/** Run the chain: first hit wins, `null` rejects, exhausting the chain rejects. */
export function resolveUpstream(
  msg: RouteMessage,
  ctx: RouteContext,
  resolvers: readonly UpstreamResolver[] = defaultUpstreamResolvers,
): UpstreamResolution | null {
  for (const resolver of resolvers) {
    const result = resolver(msg, ctx)
    if (result === null) return null
    if (result !== undefined) return result
  }
  return null
}

export function route(
  msg: { chatKey: string; text: string; chatType: 'direct' | 'group' | 'thread'; mentionsBot?: boolean },
  ctx: RouteContext,
  opts: RouterOptions = {},
): RouteDecision {
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

  const prefix = opts.sessionIdPrefix ?? 'channel'
  const chain = opts.resolvers ?? (prefix === 'channel' ? defaultUpstreamResolvers : [focusResolver, conventionResolver(prefix)])
  const upstream = resolveUpstream(msg, ctx, chain)
  if (upstream === null) return { kind: 'drop', reason: 'rejected' }
  return { kind: 'route', sessionId: upstream.sessionId, create: upstream.create, provenance: upstream.provenance }
}
