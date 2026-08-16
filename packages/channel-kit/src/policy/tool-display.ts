/**
 * Tool call/result → a single line of "human-readable" text.
 *
 * Aligned with openclaw's `tool-display.ts`: `resolveToolDisplay` splits name+args into
 * `{emoji,label,detail}`; the shell family (bash/exec/shell/pwsh, or arguments with a
 * `command`) puts the command on its own line; `formatToolLine` / `formatToolResultLine`
 * produce the final text, always truncated + redacted.
 */

const TOOL_META: Record<string, { emoji: string; label: string }> = {
  bash: { emoji: '🛠️', label: 'Bash' },
  exec: { emoji: '🛠️', label: 'Exec' },
  shell: { emoji: '🛠️', label: 'Shell' },
  pwsh: { emoji: '🛠️', label: 'PowerShell' },
  fs: { emoji: '📁', label: 'File' },
  read: { emoji: '📖', label: 'Read' },
  write: { emoji: '✍️', label: 'Write' },
  edit: { emoji: '✏️', label: 'Edit' },
  web: { emoji: '🔎', label: 'Web Search' },
  web_search: { emoji: '🔎', label: 'Web Search' },
  subagent: { emoji: '🤖', label: 'Subagent' },
  ralph: { emoji: '🔄', label: 'Ralph' },
  workflow: { emoji: '🔀', label: 'Workflow' },
  ask_user: { emoji: '❓', label: 'Ask' },
}
const FALLBACK_EMOJI = '🧩'
const SHELL_NAMES = new Set(['bash', 'exec', 'shell', 'pwsh'])

export interface ToolDisplay {
  readonly emoji: string
  readonly label: string
  readonly detail?: string
}

export interface ToolLineOptions {
  /** 'compact' = short summary; 'verbose' = expanded arguments. */
  detailMode: 'compact' | 'verbose'
  /** Whether to output the shell command as the whole line; default 'status' (semantic summary only). */
  commandText?: 'status' | 'raw'
  /** Detail cap (code points); default 40. */
  maxDetailChars?: number
}

/** Parse a tool name + raw arguments JSON string into a display model. When argsJson fails to parse, detail is omitted. */
export function resolveToolDisplay(name: string, argsJson?: string): ToolDisplay {
  const key = name.toLowerCase()
  const meta = TOOL_META[key]
  return {
    emoji: meta?.emoji ?? FALLBACK_EMOJI,
    label: meta?.label ?? name,
    detail: extractDetail(argsJson),
  }
}

/** Tool call line: `"🛠️ Bash: cmd"` (for shell with raw, `"🛠️ cmd"` as the whole line). */
export function formatToolLine(display: ToolDisplay, opts: ToolLineOptions): string {
  const maxDetailChars = opts.maxDetailChars ?? 40
  const detail = truncate(display.detail ?? '', maxDetailChars)
  if (isShellName(display.label) && opts.commandText === 'raw' && detail !== '') {
    return `${display.emoji} ${detail}`
  }
  if (detail === '') return `${display.emoji} ${display.label}`
  return `${display.emoji} ${display.label}: ${detail}`
}

/** Tool result line: `"✅ Bash · 0.4s"` / `"⛔ Bash · errored"`. */
export function formatToolResultLine(name: string, opts: { ok: boolean; durationMs?: number; summary?: string }): string {
  const display = resolveToolDisplay(name)
  const mark = opts.ok ? '✅' : '⛔'
  const duration = opts.durationMs !== undefined ? ` · ${formatDuration(opts.durationMs)}` : ''
  const summary = opts.summary !== undefined && opts.summary !== '' ? ` · ${truncate(opts.summary, 40)}` : ''
  return `${mark} ${display.label}${duration}${summary}`
}

function extractDetail(argsJson?: string): string | undefined {
  if (argsJson === undefined) return undefined
  let args: unknown
  try {
    args = JSON.parse(argsJson)
  } catch {
    return undefined
  }
  if (args === null || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  for (const key of ['command', 'path', 'file', 'query', 'q', 'url', 'text', 'message', 'question']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function isShellName(label: string): boolean {
  return SHELL_NAMES.has(label.toLowerCase())
}

function truncate(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…'
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
