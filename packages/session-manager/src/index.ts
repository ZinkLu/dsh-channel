/**
 * dsh-session-manager plugin entry.
 *
 * `ctx.sessionManager` — the channel-agnostic session layer: managed-session
 * registry, log-folded dispatch tasks, subscriptions + a durable ack'd
 * notification outbox, and the global `notify_user` tool. No channel package
 * appears anywhere in this package's dependency graph (D1/R3); consumers
 * (the channel kit today, a CLI or the web host tomorrow) find it through
 * `ctx.get('sessionManager')`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionManager, resolveManagerStatePath } from './manager.js'
import { sessionManagerConfigSchema, type SessionManagerConfig } from './config.js'

export const name = 'dsh-session-manager'
export const inject = ['agents', 'sessions'] as const

export const Config = sessionManagerConfigSchema()

export function apply(ctx: Context, config: SessionManagerConfig): void {
  // The Service constructor provides `ctx.sessionManager` synchronously, so
  // consumers composing after this plugin always see it; start() then opens
  // the durable store and installs the listeners/tool inside ctx.effect (R1:
  // everything reverses on unload).
  const manager = new SessionManager(ctx, config ?? {})
  ctx.effect(async () => {
    await manager.start()
    return async () => {
      await manager.stop()
    }
  }, 'session-manager.serve')
}

export { SessionManager, resolveManagerStatePath } from './manager.js'
export { sessionManagerConfigSchema } from './config.js'
export type { SessionManagerConfig } from './config.js'
export { notifyUserTool, NOTIFY_USER_DESCRIPTION } from './notify-tool.js'
export type { NotifyToolHost, NotifyToolExec, NotifyUserToolDefinition } from './notify-tool.js'
export {
  createMemoryManagerStore,
  createTableState,
  bindTableOps,
  pruneAckedNotifications,
  pruneSettledTasks,
} from './store.js'
export type { ManagerStore, TableState } from './store.js'
export { createJsonFileManagerStore } from './store/json-file.js'
export { openDomainManagerStore, managerDomainSpec, MANAGER_DOMAIN_NAME } from './store/domain.js'
export type { DomainFacilityLike, DomainStoreOptions } from './store/domain.js'
export { ALL_NOTIFICATION_KINDS } from './types.js'
export type {
  AdoptSessionOptions,
  AgentLike,
  CreateSessionOptions,
  DispatchOptions,
  ManagedSession,
  ManagerNotification,
  ManagerSubscription,
  ManagerTask,
  NotificationKind,
  SessionDetail,
  SessionView,
  TaskState,
  WorkspaceView,
} from './types.js'

// No `export default`: the 0.2 loader unwraps `exports.default` first, which
// would turn this module into a class plugin and silently drop the named
// `inject`/`apply`/`Config` above.
