export type FormatTier = 'plain' | 'markdown' | 'html'

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
      // 保留围栏行原文（用户可辨）
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
        // 不平衡围栏：保持字面量（残缺 <pre> 会被 Telegram 整条拒收）。
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
  // 表头后必须紧跟 |---| 分隔行
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
  // 去掉分隔行，按列对齐。
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
  // 行内代码去反引号；粗体去星号；链接 t (u)。
  let text = line
  text = text.replace(/`([^`]*)`/g, '$1')
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  text = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
  return text
}

function renderHtmlInline(line: string): string {
  // 先统一 HTML 转义，再用占位符保护行内代码，避免 bold/链接处理破坏 code 内容。
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
  text = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // 还原行内代码。
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => `<code>${codeSpans[Number(index)] ?? ''}</code>`)

  return text
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
