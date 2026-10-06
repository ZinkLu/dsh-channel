/**
 * The global `notify_user` tool (§5.3): the agent-side half of "call me back
 * when you're done". Registered by the manager plugin on the ordinary plugin
 * ctx (the global tool layer, visible to every agent including web-UI
 * sessions), and re-registered per agent inside the manager's own `setup()`
 * as the preset-restriction fallback (V2).
 *
 * dsh-tools is an optional peer and is NOT imported: the definition is built
 * as a plain object matching `ToolDefinition`'s structural contract (name /
 * description / parameters / output.{schema, render} / execute) and handed to
 * a duck-typed `register`.
 */
import type { NotificationKind } from './types.js'

/** What the tool needs from the manager; kept narrow so the tool stays testable. */
export interface NotifyToolHost {
  notify(sessionId: string, text: string, opts?: { when?: 'now' | 'done'; kind?: NotificationKind }): Promise<number>
}

/** Structural view of one tool execution context (dsh-tools' ToolRunContext). */
export interface NotifyToolExec {
  agent?: { id?: string }
}

export interface NotifyUserToolDefinition {
  readonly name: 'notify_user'
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: { delivered?: number } | undefined): Array<{ type: 'text'; text: string }>
  }
  execute(args: { text?: unknown; when?: unknown }, exec: NotifyToolExec): Promise<{ delivered: number }>
}

export const NOTIFY_USER_DESCRIPTION =
  'Send a short message to the user on their messaging app. when="done" delivers it once this session goes idle, with the outcome attached.'

export function notifyUserTool(host: NotifyToolHost): NotifyUserToolDefinition {
  return {
    name: 'notify_user',
    description: NOTIFY_USER_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to deliver to the user. Keep it short.' },
        when: {
          type: 'string',
          enum: ['now', 'done'],
          description: 'Deliver immediately ("now"), or once this session goes idle with the outcome attached ("done"). Defaults to "now".',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { delivered: { type: 'number', description: 'How many subscribers the message will reach.' } },
        required: ['delivered'],
        additionalProperties: false,
      },
      render(_args, value) {
        const delivered = value?.delivered ?? 0
        return [
          {
            type: 'text',
            text: delivered > 0 ? `Notification queued for ${delivered} subscriber(s).` : 'No subscriber is watching this session; the notification was dropped.',
          },
        ]
      },
    },
    async execute(args, exec) {
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      const sessionId = exec?.agent?.id
      if (text === '' || sessionId === undefined || sessionId === '') return { delivered: 0 }
      const when = args?.when === 'done' ? 'done' : 'now'
      const delivered = await host.notify(String(sessionId), text, { when })
      return { delivered }
    },
  }
}
