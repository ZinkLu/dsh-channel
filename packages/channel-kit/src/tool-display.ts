/**
 * 工具调用/结果 → 一行"人话"。
 *
 * 对齐 openclaw 的 `tool-display.ts`：`resolveToolDisplay` 把 name+args 拆成
 * `{emoji,label,detail}`，shell 族（bash/exec/shell/pwsh 或参数带 command）把命令
 * 作为整行；`formatToolLine` / `formatToolResultLine` 出最终文本，永远截断 + 脱敏。
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
  /** 'compact'=短摘要；'verbose'=展开参数。 */
  detailMode: 'compact' | 'verbose'
  /** shell 命令是否整行输出；默认 'status'（只出语义摘要）。 */
  commandText?: 'status' | 'raw'
  /** 详情上限（码点）；默认 40。 */
  maxDetailChars?: number
}

/** 把工具名 + 原始参数 JSON 字符串解析成呈现模型。argsJson 解析失败时 detail 缺省。 */
export function resolveToolDisplay(name: string, argsJson?: string): ToolDisplay {
  const key = name.toLowerCase()
  const meta = TOOL_META[key]
  return {
    emoji: meta?.emoji ?? FALLBACK_EMOJI,
    label: meta?.label ?? name,
    detail: extractDetail(argsJson),
  }
}

/** 工具调用行：`"🛠️ Bash: cmd"`（shell 且 raw 时 `"🛠️ cmd"` 整行）。 */
export function formatToolLine(display: ToolDisplay, opts: ToolLineOptions): string {
  const maxDetailChars = opts.maxDetailChars ?? 40
  const detail = truncate(display.detail ?? '', maxDetailChars)
  if (isShellName(display.label) && opts.commandText === 'raw' && detail !== '') {
    return `${display.emoji} ${detail}`
  }
  if (detail === '') return `${display.emoji} ${display.label}`
  return `${display.emoji} ${display.label}: ${detail}`
}

/** 工具结果行：`"✅ Bash · 0.4s"` / `"⛔ Bash · 出错了"`。 */
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
