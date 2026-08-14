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

  // 前缀递归收敛：前缀占预算，段数与前缀宽互相影响；5 轮收敛，失败退无前缀。
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
  // 无法在 5 轮内稳定：放弃前缀。
  return chunkWithoutNumbering(markdown, maxChars, countBy)
}

function chunkWithoutNumbering(markdown: string, maxChars: number, countBy: 'codepoint' | 'utf16'): string[] {
  const blocks = splitMarkdownBlocks(markdown)
  return packBlocks(blocks, maxChars, countBy)
}

/** 按 markdown 块切分；围栏代码块视为原子（不切断代码块）。 */
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
      // 不完整围栏保持字面量（不平衡围栏教训）
      if (!closed) {
        // 未闭合的 fence：当作普通段落继续收集，保持字面量
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
 * 超长单一原子块退化为硬切。代码块硬切时补围栏：每个切口收尾/重开，
 * 保持每段可渲染。纯文本段内优先在换行 / `。` / `. ` 处断。
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
    // 单行也放不下时硬切该行
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
    // 优先断点：换行 / 中文句号 / 英文句号+空格
    for (let i = maxChars; i >= Math.max(1, Math.floor(maxChars * 0.6)); i--) {
      const ch = rest[i]
      if (ch === '\n') {
        splitAt = i + 1 // 把换行留给上一段
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
      // 找不到优选断点时按码元截断
      splitAt = maxChars
      // 避免切断代理对（utf16 模式）
      if (countBy === 'utf16') {
        const code = rest.charCodeAt(splitAt - 1)
        if (code >= 0xd800 && code <= 0xdbff && splitAt < rest.length) {
          splitAt--
        }
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
