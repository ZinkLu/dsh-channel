import Schema from '@deepseek-ai/schemastery'

/**
 * Plugin-entry config for `dsh-session-manager` (0.2 settings model: the config
 * IS the plugin entry's `config:` in the profile patch; a non-volatile change
 * restarts the plugin).
 *
 * Everything is optional: with zero config the manager creates sessions on the
 * host defaults (registry-default preset, `process.cwd()`), stores its tables in
 * `$DSH_HOME/session-manager/state.json` (or the storage domain when composed),
 * and `notify_user` without watchers delivers nowhere.
 */
export interface ConciergeConfig {
  /** Pre-register the concierge session (design §15): a well-known `manager:concierge` row, tools on its own scope, and the re-awaken loop. Default false. */
  enable?: boolean
  /** `/ls` label for the concierge row; default "concierge". */
  label?: string
  /** Preset forced onto the concierge agent; unset = the host default preset. */
  agentPreset?: string
  /** The concierge's own absolute cwd; unset = the manager cwd. */
  cwd?: string
  /** System-prompt instructions for the concierge; default = the built-in text (design §15.5). */
  instructions?: string
}

export interface SessionManagerConfig {
  /** Default provider route for sessions this manager creates (host default when unset). */
  provider?: string
  /** Default model for created sessions. */
  model?: string
  /** Default absolute cwd for created sessions; falls back to `process.cwd()`. */
  cwd?: string
  /** Default agent preset id; unset = the preset registry's default. */
  agentPreset?: string
  /** JSON fallback store path; unset = `$DSH_HOME/session-manager/state.json`. Only used when `ctx.storageDomain` is absent. */
  statePath?: string
  /**
   * Subscriber keys that receive `notify` and `error` for sessions with no
   * watcher of their own (e.g. a browser-opened session calling notify_user).
   * Channel convention: `channel:<id>[:<accountId>]:<chatKey>`. Deliberately
   * NOT subscribed to turn-end: every idle web session would buzz the phone.
   */
  defaultSubscribers?: string[]
  /** The concierge agent (design §15); absent/`enable:false` = no concierge, byte-identical §14 behavior. */
  concierge?: ConciergeConfig
}

export function sessionManagerConfigSchema() {
  return Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
    cwd: Schema.string(),
    agentPreset: Schema.string(),
    statePath: Schema.string(),
    defaultSubscribers: Schema.array(Schema.string()),
    concierge: Schema.object({
      enable: Schema.boolean().default(false),
      label: Schema.string(),
      agentPreset: Schema.string(),
      cwd: Schema.string(),
      instructions: Schema.string(),
    }),
  })
}
