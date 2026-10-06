/**
 * Manager command surface (§6.2): deterministic slash commands over
 * `ctx.sessionManager`, as pure parse/render functions. The bridge executes
 * the parsed intents against the manager and renders replies through this
 * module — no decision logic and no state live on the bridge side.
 *
 * Two numbered namespaces coexist by design: approvals keep their `#n` reply
 * numbers (broker-owned), sessions use `/use n` with numbering that is stable
 * per chat until the next `/ls`.
 *
 * Without a session manager none of these commands exist: the bridge gates
 * this whole table on `ctx.sessionManager` being present (its `handleCommand`
 * never parses here otherwise) and answers with its historical
 * "Unknown command" reply (D4).
 */

// ---- parsing ----

export type ManagerCommand =
  | { kind: 'help' }
  | { kind: 'list-sessions'; workspace?: string }
  | { kind: 'list-workspaces' }
  | { kind: 'use'; target: string; take: boolean }
  | { kind: 'new'; target?: string; text?: string }
  | { kind: 'to'; target: string; text: string; take: boolean }
  | { kind: 'status'; target?: string }
  | { kind: 'tail'; target?: string }
  | { kind: 'stop'; target?: string }
  | { kind: 'watch'; target: string }
  | { kind: 'unwatch'; target?: string }
  | { kind: 'bind'; sessionId: string; take: boolean }
  | { kind: 'unknown'; command: string }

/** Split `/command args` into its parts (the caller guarantees the leading slash). */
export function parseManagerCommand(commandText: string): ManagerCommand {
  const match = /^\/([^\s@]+)\s*(.*)$/.exec(commandText.trim())
  const command = (match?.[1] ?? '').toLowerCase()
  const rawArgs = (match?.[2] ?? '').trim()
  const take = /(?:^|\s)--take(?:\s|$)/.test(rawArgs)
  const args = rawArgs.replace(/(?:^|\s)--take(?:\s|$)/g, ' ').trim()

  switch (command) {
    case 'start':
    case 'help':
      return { kind: 'help' }
    case 'ls':
      return args === '' ? { kind: 'list-sessions' } : { kind: 'list-sessions', workspace: args }
    case 'ws':
      return { kind: 'list-workspaces' }
    case 'use': {
      const target = firstToken(args)
      if (target === '') return { kind: 'unknown', command: 'use' }
      return { kind: 'use', target, take }
    }
    case 'new': {
      const target = firstToken(args)
      const rest = args.slice(target.length).trim()
      if (target === '') return { kind: 'new' }
      return rest === '' ? { kind: 'new', target } : { kind: 'new', target, text: rest }
    }
    case 'to': {
      const target = firstToken(args)
      const rest = args.slice(target.length).trim()
      if (target === '' || rest === '') return { kind: 'unknown', command: 'to' }
      return { kind: 'to', target, text: rest, take }
    }
    case 'status':
      return args === '' ? { kind: 'status' } : { kind: 'status', target: firstToken(args) }
    case 'tail':
      return args === '' ? { kind: 'tail' } : { kind: 'tail', target: firstToken(args) }
    case 'stop':
      return args === '' ? { kind: 'stop' } : { kind: 'stop', target: firstToken(args) }
    case 'watch': {
      const target = firstToken(args)
      if (target === '') return { kind: 'unknown', command: 'watch' }
      return { kind: 'watch', target }
    }
    case 'unwatch':
      return args === '' ? { kind: 'unwatch' } : { kind: 'unwatch', target: firstToken(args) }
    case 'bind': {
      const target = firstToken(args)
      if (target === '') return { kind: 'unknown', command: 'bind' }
      return { kind: 'bind', sessionId: target, take }
    }
    default:
      return { kind: 'unknown', command }
  }
}

function firstToken(args: string): string {
  const space = args.search(/\s/)
  return space === -1 ? args : args.slice(0, space)
}

/** Resolve a `/use n`-style target against the chat's stable numbering. */
export type TargetResolution =
  | { kind: 'numbered'; sessionId: string }
  | { kind: 'session-id'; sessionId: string }
  | { kind: 'unknown-number'; ref: string }

export function resolveSessionTarget(target: string, numbers: Readonly<Record<string, number>>): TargetResolution {
  if (/^\d+$/.test(target)) {
    const wanted = Number(target)
    for (const [sessionId, number] of Object.entries(numbers)) {
      if (number === wanted) return { kind: 'numbered', sessionId }
    }
    return { kind: 'unknown-number', ref: target }
  }
  return { kind: 'session-id', sessionId: target }
}

// ---- rendering: session list ----

export interface SessionListRow {
  readonly sessionId: string
  readonly title?: string
  readonly label?: string
  readonly cwd?: string
  readonly workspaceId?: string
  readonly running: boolean
  readonly blank: boolean
  readonly managed: boolean
  readonly foreign: boolean
  readonly pendingInteraction?: 'approval' | 'question'
  readonly watchers: number
  readonly updatedAt: number
  readonly activeTaskState?: 'queued' | 'running' | 'done' | 'failed' | 'crashed'
  readonly lastReason?: string
  readonly focused?: boolean
}

export interface SessionListOptions {
  readonly now: number
  /** workspaceId → display title (the manager's `workspaces()` rows). */
  readonly workspaceTitles?: Readonly<Record<string, string>>
  /** Render an inline keyboard (Telegram-class platforms). */
  readonly supportsChoices?: boolean
  /** callback_data byte budget; rows whose `focus:<id>` exceeds it drop the keyboard. */
  readonly maxValueBytes?: number
}

export interface SessionListRender {
  readonly text: string
  /** The fresh numbering, stable until the next /ls (persist per chat). */
  readonly numbers: Record<string, number>
  readonly choices: ReadonlyArray<{ id: string; label: string }>
}

const CHOICE_BYTE_BUDGET_FALLBACK = 64

export function renderSessionList(rows: readonly SessionListRow[], opts: SessionListOptions): SessionListRender {
  if (rows.length === 0) {
    return { text: 'No sessions yet — send a message to start one, or /new to create one.', numbers: {}, choices: [] }
  }

  const groups = groupByWorkspace(rows, opts.workspaceTitles ?? {})
  const lines: string[] = []
  const numbers: Record<string, number> = {}
  const choices: Array<{ id: string; label: string }> = []
  let next = 1

  for (const group of groups) {
    if (group.title !== undefined) lines.push(group.title)
    for (const row of group.rows) {
      const number = next++
      numbers[row.sessionId] = number
      lines.push(renderSessionRow(row, number, opts))
      if (opts.supportsChoices) {
        const id = `focus:${row.sessionId}`
        const budget = opts.maxValueBytes ?? CHOICE_BYTE_BUDGET_FALLBACK
        if (byteLength(id) <= budget) {
          choices.push({ id, label: truncateLabel(`#${number} ${rowTitle(row)}`, 40) })
        }
      }
    }
  }

  lines.push('')
  lines.push('/use <n> focus · /to <n> <text> one-shot · /status <n> · /stop <n> · /watch <n>')
  return { text: lines.join('\n'), numbers, choices }
}

interface WorkspaceGroup {
  title?: string
  rows: SessionListRow[]
}

function groupByWorkspace(rows: readonly SessionListRow[], workspaceTitles: Readonly<Record<string, string>>): WorkspaceGroup[] {
  const order: WorkspaceGroup[] = []
  const byKey = new Map<string, WorkspaceGroup>()
  for (const row of rows) {
    const key = row.workspaceId ?? row.cwd ?? ''
    let group = byKey.get(key)
    if (group === undefined) {
      const title = row.workspaceId !== undefined ? workspaceTitles[row.workspaceId] ?? undefined : row.cwd !== undefined ? pathLabel(row.cwd) : undefined
      group = { ...(title !== undefined ? { title } : {}), rows: [] }
      byKey.set(key, group)
      order.push(group)
    }
    group.rows.push(row)
  }
  for (const group of order) {
    group.rows.sort((a, b) => Number(b.focused ?? false) - Number(a.focused ?? false) || Number(b.running) - Number(a.running) || b.updatedAt - a.updatedAt)
  }
  // Named workspace groups first — most recently active group on top, ties
  // alphabetical — ungrouped sessions last.
  const named = order.filter((group) => group.title !== undefined)
  const groupActivity = (group: WorkspaceGroup) => group.rows.reduce((max, row) => Math.max(max, row.updatedAt), 0)
  named.sort((a, b) => groupActivity(b) - groupActivity(a) || a.title!.localeCompare(b.title!))
  return [...named, ...order.filter((group) => group.title === undefined)]
}

function renderSessionRow(row: SessionListRow, number: number, opts: SessionListOptions): string {
  const glyph = rowGlyph(row)
  const parts = [`${glyph} ${number}`, rowTitle(row)]
  parts.push(statusSegment(row, opts.now))
  if (row.pendingInteraction !== undefined) parts.push(`⏳${row.pendingInteraction}`)
  if (row.foreign) parts.push('(foreign)')
  if (!row.managed && !row.foreign) parts.push('(live)')
  const line = parts.filter((part) => part !== '').join(' · ')
  return row.focused ? `${line} ◀` : line
}

function rowGlyph(row: SessionListRow): string {
  if (row.running) return '▶'
  if (row.activeTaskState === 'crashed' || row.lastReason === 'interrupted') return '✗'
  if (row.blank) return '·'
  return '✓'
}

function statusSegment(row: SessionListRow, now: number): string {
  if (row.blank) return '(blank)'
  if (row.running) return `running ${relativeTimeLabel(row.updatedAt, now)}`
  if (row.activeTaskState === 'crashed' || row.lastReason === 'interrupted') return 'crashed'
  if (row.activeTaskState === 'failed') return `failed ${relativeTimeLabel(row.updatedAt, now)}`
  if (row.activeTaskState === 'queued') return 'queued'
  const reason = row.lastReason === undefined || row.lastReason === 'completed' ? 'done' : row.lastReason
  return `${reason} ${relativeTimeLabel(row.updatedAt, now)}`
}

function rowTitle(row: SessionListRow): string {
  const title = row.title ?? row.label
  if (title !== undefined && title !== '') return `"${title}"`
  if (row.cwd !== undefined) return pathLabel(row.cwd)
  return shorten(row.sessionId)
}

// ---- rendering: workspaces ----

export interface WorkspaceListRow {
  readonly id: string
  readonly title: string
  readonly path?: string
  readonly sessionCount: number
}

export function renderWorkspaceList(rows: readonly WorkspaceListRow[]): { text: string; numbers: Record<string, number> } {
  if (rows.length === 0) return { text: 'No workspaces are registered; sessions group by their cwd instead.', numbers: {} }
  const numbers: Record<string, number> = {}
  const lines = rows.map((row, index) => {
    numbers[row.id] = index + 1
    const path = row.path !== undefined ? ` · ${row.path}` : ''
    return `${index + 1} ${row.title}${path} · ${row.sessionCount} session${row.sessionCount === 1 ? '' : 's'}`
  })
  return { text: lines.join('\n'), numbers }
}

// ---- rendering: session status ----

export interface SessionStatusInput {
  readonly sessionId: string
  readonly number?: number
  readonly title?: string
  readonly cwd?: string
  readonly running: boolean
  readonly blank: boolean
  readonly pendingInteraction?: 'approval' | 'question'
  readonly queued?: number
  readonly currentTool?: string
  readonly lastAssistantText?: string
  readonly lastError?: string
  readonly todos?: ReadonlyArray<{ content?: string; status?: string }>
  readonly watchers: number
  readonly lastReason?: string
  readonly updatedAt: number
  readonly now: number
}

export function renderSessionStatus(input: SessionStatusInput): string {
  const head = input.number !== undefined ? `#${input.number} ` : ''
  const title = input.title !== undefined && input.title !== '' ? `"${input.title}" ` : ''
  const where = input.cwd !== undefined ? `(${pathLabel(input.cwd)})` : `(${shorten(input.sessionId)})`
  const lines = [`${head}${title}${where}`.trim()]

  const state = input.running ? `▶ running${input.currentTool !== undefined ? ` · tool: ${input.currentTool}` : ''}` : input.blank ? '· blank (no messages yet)' : `✓ idle${input.lastReason !== undefined && input.lastReason !== 'completed' ? ` · last: ${input.lastReason}` : ''}`
  const extras: string[] = []
  if ((input.queued ?? 0) > 0) extras.push(`queued ${input.queued}`)
  if (input.watchers > 0) extras.push(`watched by ${input.watchers}`)
  extras.push(relativeTimeLabel(input.updatedAt, input.now))
  lines.push([state, ...extras].join(' · '))

  if (input.pendingInteraction !== undefined) {
    lines.push(input.pendingInteraction === 'approval' ? '⏳ waiting for an approval reply' : '⏳ waiting for an answer')
  }
  const todos = input.todos ?? []
  if (todos.length > 0) {
    const done = todos.filter((todo) => todo.status === 'completed' || todo.status === 'done').length
    lines.push(`todos ${done}/${todos.length}`)
    for (const todo of todos.slice(0, 5)) {
      const mark = todo.status === 'completed' || todo.status === 'done' ? '✓' : todo.status === 'in_progress' ? '▶' : '·'
      lines.push(`  ${mark} ${todo.content ?? ''}`)
    }
  }
  if (input.lastError !== undefined && input.lastError !== '') lines.push(`⚠️ ${truncate(input.lastError, 200)}`)
  if (input.lastAssistantText !== undefined && input.lastAssistantText !== '') lines.push(`last: ${truncate(input.lastAssistantText, 300)}`)
  return lines.join('\n')
}

// ---- rendering: one-line replies ----

export function renderFocusReply(input: { number?: number; title?: string; sessionId: string; workspaceTitle?: string }): string {
  const ref = input.number !== undefined ? `#${input.number}` : shorten(input.sessionId)
  const title = input.title !== undefined && input.title !== '' ? ` "${input.title}"` : ''
  const where = input.workspaceTitle !== undefined ? ` (${input.workspaceTitle})` : ''
  return `Focused ${ref}${title}${where}`
}

export function renderForeignConfirm(ref: string): string {
  return `⚠️ this session was not started by this host; resuming it here while another process has it open would corrupt its log — reply \`/use ${ref} --take\` to adopt`
}

export function renderUnknownNumber(ref: string): string {
  return `Unknown number ${ref} — run /ls to see the current numbering.`
}

export function renderUnknownSession(sessionId: string): string {
  return `No such session: ${sessionId}`
}

export function renderWatchReply(input: { number?: number; title?: string; sessionId: string }): string {
  return `👀 watching ${describeRef(input)}`
}

export function renderUnwatchReply(input: { number?: number; title?: string; sessionId: string }): string {
  return `Stopped watching ${describeRef(input)}`
}

export function renderStopReply(input: { number?: number; title?: string; sessionId: string; wasRunning: boolean }): string {
  return input.wasRunning ? `⏹ stopped ${describeRef(input)}` : `${describeRef(input)} is not running`
}

export function renderNewReply(input: { number?: number; title?: string; sessionId: string; cwd?: string }): string {
  const where = input.cwd !== undefined ? ` (${pathLabel(input.cwd)})` : ''
  return `✅ Created ${describeRef(input)}${where} — messages in this chat now go to it`
}

export function renderDispatchReply(input: { number?: number; title?: string; sessionId: string; mode: string }): string {
  return `➡️ dispatched to ${describeRef(input)} (${input.mode})`
}

export function renderTailReply(text: string | undefined): string {
  if (text === undefined || text === '') return '(no assistant text yet)'
  return text
}

export const MANAGER_HELP_TEXT = [
  'Available commands:',
  '/ls [ws] - List sessions (numbers are stable until the next /ls)',
  '/use <n|id> - Focus a session; free text goes to it (--take adopts a foreign one)',
  '/new [ws|path] [text] - New session, focused; optional first message',
  '/to <n> <text> - One-shot dispatch without changing focus (--take adopts a foreign one)',
  '/status [n] - Running/idle, tool, todos, pending interactions',
  '/tail [n] - Last assistant text',
  '/stop [n] - Cancel the running turn',
  '/watch <n> / /unwatch [n] - Result notifications for a session',
  '/ws - List workspaces',
  '/bind <sessionId> - Adopt + focus a session by id',
  '/help - This help',
].join('\n')

// ---- shared helpers ----

function describeRef(input: { number?: number; title?: string; sessionId: string }): string {
  const ref = input.number !== undefined ? `#${input.number}` : shorten(input.sessionId)
  const title = input.title !== undefined && input.title !== '' ? ` "${input.title}"` : ''
  return `${ref}${title}`
}

export function relativeTimeLabel(timestamp: number, now: number): string {
  const delta = Math.max(0, now - timestamp)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function pathLabel(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== '')
  return segments[segments.length - 1] ?? path
}

function shorten(sessionId: string): string {
  const parts = sessionId.split(':')
  const tail = parts[parts.length - 1] ?? sessionId
  return tail.length > 12 ? `${tail.slice(0, 8)}…` : tail
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function truncateLabel(label: string, max: number): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}
