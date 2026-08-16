export interface ChunkOptions {
  maxChars: number
  numbering?: 'none' | 'prefix'
  countBy?: 'codepoint' | 'utf16'
}

const FULLWIDTH_PREFIX_RE = /^（\d+\/\d+）/

export function chunkText(markdown: string, opts: ChunkOptions): string[] {
  const { maxChars } = opts
  if (!Number.isFinite(maxChars) || maxChars <= 0) throw new Error('maxChars must be a positive finite number')
  const countBy = opts.countBy ?? 'codepoint'
  const numbering = opts.numbering ?? 'none'

  if (numbering !== 'prefix') {
    return chunkWithoutNumbering(markdown, maxChars, countBy)
  }

  // Prefix recursion to convergence: the prefix consumes budget, so segment count and prefix width affect each other; converge within 5 rounds, and fall back to no prefix on failure.
  let chunks = chunkWithoutNumbering(markdown, maxChars, countBy)
  for (let round = 0; round < 5; round++) {
    const count = chunks.length
    const maxPrefix = prefixWidth(count, countBy)
    if (maxPrefix >= maxChars) {
      chunks = chunkWithoutNumbering(markdown, 1, countBy)
      continue
    }
    const next = chunkWithoutNumbering(markdown, maxChars - maxPrefix, countBy)
    if (next.length === count) {
      return applyNumbering(next, countBy)
    }
    chunks = next
  }
  // If it does not stabilize within 5 rounds: give up the prefix.
  return chunkWithoutNumbering(markdown, maxChars, countBy)
}

function chunkWithoutNumbering(markdown: string, maxChars: number, countBy: 'codepoint' | 'utf16'): string[] {
  const blocks = splitMarkdownBlocks(markdown)
  return packBlocks(blocks, maxChars, countBy)
}

/** Split by markdown blocks; treat fenced code blocks as atomic (never cut a code block). */
export function splitMarkdownBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let i = 0

  const pushCurrent = () => {
    const text = current.join('\n')
    if (text.trim() !== '') blocks.push(text)
    current = []
  }

  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      pushCurrent()
      const fence = line
      const fenceLine = line
      const block: string[] = [fenceLine]
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
      // Incomplete fences stay literal (the unbalanced-fence lesson)
      if (!closed) {
        // Unclosed fence: keep collecting as a normal paragraph, preserving it literally
        current.push(...block)
      } else {
        blocks.push(block.join('\n'))
      }
      continue
    }
    if (trimmed === '') {
      pushCurrent()
      i++
      continue
    }
    current.push(line)
    i++
  }
  pushCurrent()
  return blocks
}

function packBlocks(blocks: readonly string[], maxChars: number, countBy: 'codepoint' | 'utf16'): string[] {
  const chunks: string[] = []
  let current: string[] = []

  for (const block of blocks) {
    const pieces = block.length > 0 && charLen(block, countBy) > maxChars ? hardSplit(block, maxChars, countBy) : [block]
    for (const piece of pieces) {
      const joined = [...current, piece].join('\n\n')
      if (current.length > 0 && charLen(joined, countBy) > maxChars) {
        chunks.push(current.join('\n\n'))
        current = [piece]
      } else if (charLen(piece, countBy) > maxChars) {
        if (current.length > 0) {
          chunks.push(current.join('\n\n'))
          current = []
        }
        chunks.push(piece)
      } else {
        current.push(piece)
      }
    }
  }
  if (current.length > 0) chunks.push(current.join('\n\n'))
  return chunks.length > 0 ? chunks : ['']
}

/**
 * An oversized single atomic block degrades to a hard split. When a code block is
 * hard-split, re-fence it: close/reopen at every cut so each piece stays renderable.
 * Within plain text, prefer breaking at newlines / `。` / `. `.
 */
function hardSplit(text: string, maxChars: number, countBy: 'codepoint' | 'utf16'): string[] {
  if (charLen(text, countBy) <= maxChars) return [text]
  if (isFencedCodeBlock(text)) {
    return hardSplitCodeBlock(text, maxChars, countBy)
  }
  return hardSplitText(text, maxChars, countBy)
}

function isFencedCodeBlock(text: string): boolean {
  return /^```[^\n]*\n/.test(text) && /\n```\s*$/.test(text)
}

function hardSplitCodeBlock(text: string, maxChars: number, countBy: 'codepoint' | 'utf16'): string[] {
  const lines = text.split('\n')
  const open = lines[0]!
  const close = lines[lines.length - 1]!
  const info = open.slice(3).trim()
  const inner = lines.slice(1, -1)
  const openLen = charLen(open, countBy)
  const closeLen = charLen(close, countBy)
  const budget = Math.max(1, maxChars - openLen - closeLen)
  const pieces: string[] = []
  let current: string[] = []
  let currentLen = 0

  const flush = () => {
    if (current.length === 0) return
    pieces.push([open, ...current, close].join('\n'))
    current = []
    currentLen = 0
  }

  for (const line of inner) {
    const lineLen = charLen(line, countBy)
    // When a single line still does not fit, hard-split that line
    if (lineLen > budget) {
      flush()
      const subPieces = hardSplitText(line, budget, countBy)
      for (const sub of subPieces) {
        pieces.push([open, sub, close].join('\n'))
      }
      continue
    }
    const nextLen = currentLen + lineLen + (current.length > 0 ? 1 : 0)
    if (current.length > 0 && nextLen > budget) {
      flush()
    }
    current.push(line)
    currentLen += lineLen + (current.length > 1 ? 1 : 0)
  }
  flush()
  return pieces.length > 0 ? pieces : [[open, close].join('\n')]
}

function hardSplitText(text: string, maxChars: number, countBy: 'codepoint' | 'utf16'): string[] {
  const pieces: string[] = []
  let rest = text
  while (charLen(rest, countBy) > maxChars) {
    let splitAt = -1
    // Preferred break points: newline / Chinese full stop / English period + space
    for (let i = maxChars; i >= Math.max(1, Math.floor(maxChars * 0.6)); i--) {
      const ch = rest[i]
      if (ch === '\n') {
        splitAt = i + 1 // leave the newline with the previous piece
        break
      }
      if (ch === '。') {
        splitAt = i + 1
        break
      }
      if (ch === '.' && rest[i + 1] === ' ') {
        splitAt = i + 2
        break
      }
    }
    if (splitAt <= 0) {
      // When no preferred break point is found, truncate by code unit
      splitAt = maxChars
      // Avoid splitting a surrogate pair. The slice index is always a UTF-16 code
      // unit regardless of countBy (which only changes how the budget is counted),
      // so this guard must apply in both 'utf16' and 'codepoint' modes.
      const code = rest.charCodeAt(splitAt - 1)
      if (code >= 0xd800 && code <= 0xdbff && splitAt < rest.length) {
        splitAt--
      }
    }
    pieces.push(rest.slice(0, splitAt).trimEnd())
    rest = rest.slice(splitAt).trimStart()
  }
  if (rest.length > 0) pieces.push(rest)
  return pieces.length > 0 ? pieces : ['']
}

function prefixWidth(count: number, countBy: 'codepoint' | 'utf16'): number {
  let max = 0
  for (let i = 1; i <= count; i++) {
    const w = charLen(`（${i}/${count}）`, countBy)
    if (w > max) max = w
  }
  return max
}

function applyNumbering(chunks: readonly string[], countBy: 'codepoint' | 'utf16'): string[] {
  const count = chunks.length
  return chunks.map((chunk, index) => {
    const clean = chunk.replace(FULLWIDTH_PREFIX_RE, '')
    return `（${index + 1}/${count}）${clean}`
  })
}

export function charLen(text: string, countBy: 'codepoint' | 'utf16'): number {
  return countBy === 'utf16' ? text.length : [...text].length
}
