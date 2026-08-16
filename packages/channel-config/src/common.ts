import Schema from '@deepseek-ai/schemastery'

/**
 * Shared configuration fragments for every dsh-channel provider. Each fragment
 * pairs a hand-written business interface (fields that can be absent are marked
 * optional, matching their runtime shape) with a schema-dict constructor whose
 * return type TS infers — the two are kept separate on purpose, since
 * schemastery's `ObjectT` marks every field required even when no `default` is
 * declared. The field names must stay in sync; the test suite guards that.
 */

/** Agent routing shared by all three providers. */
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

/** Channel behavior and persistence shared by all three providers. */
export interface ChannelBehaviorConfig {
  mergeWindowSec: number
  approvalTimeoutSec: number
  statePath?: string
  /** Inbound media size cap in bytes (providers that download media enforce it). Default 20 MiB. */
  maxInboundMediaBytes: number
}

export function channelBehaviorSchema() {
  return {
    mergeWindowSec: Schema.number().default(5),
    approvalTimeoutSec: Schema.number().default(120),
    statePath: Schema.string(),
    maxInboundMediaBytes: Schema.number().default(20 * 1024 * 1024),
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
