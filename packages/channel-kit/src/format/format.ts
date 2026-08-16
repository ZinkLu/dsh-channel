export type FormatTier = 'plain' | 'markdown' | 'html'

/**
 * Strip DeepSeek-native tool-call markup that leaked into assistant text.
 *
 * A model with no structured tool channel (or an adapter that failed to
 * parse its native tool-call emission) writes the call out as plain text:
 *
 * ```
 * <tool_calls>
 * <invoke name="Bash">
 * <parameter name="command" string="true">date</parameter>
 * </invoke>
 * </tool_calls>
 * ```
 *
 * A channel must never surface model tool-call internals to end users, so
 * this is the last-mile guard: it removes balanced blocks, leftover tags from
 * a truncated stream, and the blank runs the removal leaves behind.
 */
export function stripToolCallMarkup(text: string): string {
  let result = text
  // Remove balanced <tool_calls>…</tool_calls> blocks; repeat for adjacent blocks.
  let previous = ''
  while (result !== previous) {
    previous = result
    result = result.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '')
  }
  // Remove unbalanced/leftover tags (a truncated stream can leave these).
  result = result.replace(/<\/?tool_calls\s*>/g, '')
  result = result.replace(/<\/?invoke\b[^>]*>/g, '')
  result = result.replace(/<\/?parameter\b[^>]*>/g, '')
  // Collapse the blank runs the removal left behind and trim edges.
  return result.replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, '\n\n').trim()
}

/**
 * Strip reasoning/thinking content from *visible* text (same as openclaw's
 * `stripReasoningTagsFromText`): remove `<reasoning>`/`<thinking>` tag blocks and
 * `Reasoning:`/`Thinking:` preamble lines.
 *
 * `mode:'preserve'` protects code fences with placeholders so tags inside fences stay
 * literal; `strict` strips everywhere. Together with `stripToolCallMarkup` this is the
 * last gate that "never leaks model-internal bytes to the user".
 */
export function stripReasoningTags(text: string, opts: { mode?: 'strict' | 'preserve' } = {}): string {
  const mode = opts.mode ?? 'strict'
  const normalized = text.replace(/\r\n?/g, '\n')
  const stripped = mode === 'preserve' ? stripOutsideFences(normalized) : stripAll(normalized)
  return stripped.replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, '\n\n').trim()
}

function stripAll(text: string): string {
  let result = text
  let previous = ''
  while (result !== previous) {
    previous = result
    result = result.replace(/<(?:reasoning|thinking)>[\s\S]*?<\/(?:reasoning|thinking)>/gi, '')
  }
  result = result.replace(/<\/?(?:reasoning|thinking)\s*>/gi, '')
  return stripPreambleLines(result)
}

function stripPreambleLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(?:Reasoning|Thinking)\s*[:：]\s*$/i.test(line))
    .join('\n')
}

function stripOutsideFences(text: string): string {
  const fences: string[] = []
  const protectedText = text.replace(/```[\s\S]*?```/g, (fence) => {
    const index = fences.length
    fences.push(fence)
    return `\u0000${index}\u0000`
  })
  const stripped = stripAll(protectedText)
  return stripped.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => fences[Number(index)] ?? '')
}

export function renderForTier(markdown: string, tier: FormatTier): string {
  if (tier === 'markdown') return markdown
  const normalized = markdown.replace(/\r\n?/g, '\n')

  if (tier === 'html') {
    return renderHtml(normalized)
  }
  return renderPlain(normalized)
}

function renderPlain(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()

    if (trimmed.startsWith('```')) {
      // Keep the fence lines as-is (so the user can recognize them)
      out.push(line)
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        out.push(lines[i]!)
        i++
      }
      if (i < lines.length) out.push(lines[i]!)
      i++
      continue
    }

    if (isTableBlock(lines, i)) {
      const block = collectTableBlock(lines, i)
      out.push(...renderTableAligned(block))
      i += block.length
      continue
    }

    out.push(renderPlainInline(line))
    i++
  }

  return out.join('\n')
}

function renderHtml(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()

    if (trimmed.startsWith('```')) {
      const block: string[] = [line]
      i++
      let closed = false
      while (i < lines.length) {
        block.push(lines[i]!)
        if (lines[i]!.trim().startsWith('```')) {
          closed = true
          i++
          break
        }
        i++
      }
      if (closed) {
        const inner = block.slice(1, -1).join('\n')
        out.push(`<pre>${escapeHtml(inner)}</pre>`)
      } else {
        // Unbalanced fence: keep it literal (a broken <pre> gets the whole message rejected by Telegram).
        out.push(...block.map((item) => escapeHtml(item)))
      }
      continue
    }

    if (isTableBlock(lines, i)) {
      const block = collectTableBlock(lines, i)
      out.push(`<pre>${escapeHtml(renderTableAligned(block).join('\n'))}</pre>`)
      i += block.length
      continue
    }

    out.push(renderHtmlInline(line))
    i++
  }

  return out.join('\n')
}

function isTableBlock(lines: readonly string[], start: number): boolean {
  if (start >= lines.length) return false
  if (!lines[start]!.includes('|')) return false
  // The header must be followed immediately by a |---| separator row
  if (start + 1 >= lines.length) return false
  const sep = lines[start + 1]!
  return sep.includes('|') && /^\s*\|?[\s:|-]+\|?[\s:|-]*$/.test(sep) && /---/.test(sep)
}

function collectTableBlock(lines: readonly string[], start: number): string[] {
  const block = [lines[start]!, lines[start + 1]!]
  let i = start + 2
  while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
    block.push(lines[i]!)
    i++
  }
  return block
}

function renderTableAligned(block: readonly string[]): string[] {
  // Drop the separator row and align columns.
  const rows = block
    .filter((_, index) => index !== 1)
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
  const columnCount = Math.max(...rows.map((row) => row.length))
  const widths = Array.from({ length: columnCount }, () => 0)
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) widths[c] = Math.max(widths[c]!, [...row[c]!].length)
  }
  return rows.map((row) =>
    Array.from({ length: columnCount }, (_, c) => (row[c] ?? '').padEnd(widths[c]!, ' ')).join(' | ').trimEnd(),
  )
}

function renderPlainInline(line: string): string {
  // Inline code loses backticks; bold loses asterisks; links become t (u).
  let text = line
  text = text.replace(/`([^`]*)`/g, '$1')
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  text = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
  return text
}

function renderHtmlInline(line: string): string {
  // Escape HTML first, then protect inline code with placeholders so bold/link handling cannot corrupt code contents.
  const escaped = escapeHtml(line)
  const codeSpans: string[] = []
  const withCodeProtected = escaped.replace(/`([^`]*)`/g, (_, code: string) => {
    const index = codeSpans.length
    codeSpans.push(code)
    return `\u0000${index}\u0000`
  })

  let text = withCodeProtected
  text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  text = text.replace(/__([^_]+)__/g, '<b>$1</b>')
  // `escapeHtml` deliberately leaves `"` alone (it renders fine as body text),
  // so the href — the one place a `"` would close the attribute and let the rest
  // of a model-authored URL become markup — is escaped here.
  text = text.replace(
    /\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, label: string, href: string) => `<a href="${href.replace(/"/g, '&quot;')}">${label}</a>`,
  )

  // Restore inline code.
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => `<code>${codeSpans[Number(index)] ?? ''}</code>`)

  return text
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
