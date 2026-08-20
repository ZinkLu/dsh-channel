import Schema from '@deepseek-ai/schemastery'

/**
 * Shared configuration fragments for every dsh-channel provider. Each fragment
 * pairs a hand-written business interface (fields that can be absent are marked
 * optional, matching their runtime shape) with a schema-dict constructor whose
 * return type TS infers — the two are kept separate on purpose, since
 * schemastery's `ObjectT` marks every field required even when no `default` is
 * declared. The field names must stay in sync; the test suite guards that.
 *
 * A provider composes its own config from these fragments plus its platform
 * fields (see any provider's `src/config.ts`); nothing platform-specific lives
 * here, so adding a platform touches no line of this file.
 */

/** Agent routing shared by every provider. */
export interface AgentRoutingConfig {
  provider: string
  model?: string
  cwd?: string
  agentPreset?: string
}

export function agentRoutingSchema() {
  return {
    provider: Schema.string().default('deepseek-official'),
    model: Schema.string(),
    cwd: Schema.string(),
    agentPreset: Schema.string(),
  }
}

/** Channel behavior and persistence shared by every provider. */
export interface ChannelBehaviorConfig {
  mergeWindowSec: number
  approvalTimeoutSec: number
  /** Max wait to acquire the per-sessionId turn guard before a visible rejection. Default 120 (bridge-side). */
  sessionTurnTimeoutSec?: number
  statePath?: string
  /** Inbound media size cap in bytes (providers that download media enforce it). Default 20 MiB. */
  maxInboundMediaBytes: number
  /** Instance discriminator for multi-account deployments (disambiguates two bots of the same platform). Default 'default'. */
  accountId?: string
  /** Outbound HTTP proxy URL (http://[user:pass@]host:port); threads into the provider client's fetch. */
  proxyUrl?: string
}

export function channelBehaviorSchema() {
  return {
    mergeWindowSec: Schema.number().default(5),
    approvalTimeoutSec: Schema.number().default(120),
    sessionTurnTimeoutSec: Schema.number(),
    statePath: Schema.string(),
    maxInboundMediaBytes: Schema.number().default(20 * 1024 * 1024),
    accountId: Schema.string(),
    proxyUrl: Schema.string(),
  }
}

/**
 * Allowlist of platform ids permitted to use the bot. The element type depends
 * on the platform's id space: Telegram ids are numbers, WeChat/Feishu ids are
 * strings. Required with no default — the front door for prompt injection.
 */
export function allowedUserIdsSchema(elem: 'number'): { allowedUserIds: Schemastery<number[], number[]> }
export function allowedUserIdsSchema(elem: 'string'): { allowedUserIds: Schemastery<string[], string[]> }
export function allowedUserIdsSchema(elem: 'number' | 'string') {
  const idSchema = elem === 'number' ? Schema.number() : Schema.string()
  return { allowedUserIds: Schema.array(idSchema).required() } as
    | { allowedUserIds: Schemastery<number[], number[]> }
    | { allowedUserIds: Schemastery<string[], string[]> }
}
