import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkText, splitMarkdownBlocks } from '../src/chunk.ts'

test('splitMarkdownBlocks keeps fenced code atomic', () => {
  const md = 'hello\n\n```js\nconst a = 1\nconst b = 2\n```\n\nworld'
  const blocks = splitMarkdownBlocks(md)
  assert.equal(blocks.length, 3)
  assert.match(blocks[1]!, /^```js\nconst a = 1/)
  assert.match(blocks[1]!, /```$/)
})

test('chunkText packs blocks greedily and does not split code block when possible', () => {
  const md = 'short\n\n```js\ncode here\n```'
  const chunks = chunkText(md, { maxChars: 100 })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0], md)
})

test('chunkText hard-splits oversized code blocks and re-fences each piece', () => {
  const line = 'x'.repeat(80)
  const md = `before\n\n\`\`\`js\n${line}\n${line}\n\`\`\``
  const chunks = chunkText(md, { maxChars: 120, countBy: 'utf16' })
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 120)
  }
  const codeChunks = chunks.filter((chunk) => chunk.startsWith('```js'))
  assert.ok(codeChunks.length >= 1)
  for (const chunk of codeChunks) {
    assert.ok(chunk.startsWith('```js'))
    assert.ok(chunk.trimEnd().endsWith('```'))
  }
})

test('chunkText numbering prefix converges', () => {
  const text = Array.from({ length: 10 }, (_, i) => `segment ${i} content`.repeat(20)).join('\n\n')
  const chunks = chunkText(text, { maxChars: 100, numbering: 'prefix' })
  assert.ok(chunks.length >= 2)
  for (let i = 0; i < chunks.length; i++) {
    assert.ok(chunks[i]!.startsWith(`（${i + 1}/${chunks.length}）`))
    assert.ok([...chunks[i]!].length <= 100)
  }
})

test('chunkText prefers sentence breaks but always respects maxChars', () => {
  const text = 'one. two. four. five.'
  const chunks = chunkText(text, { maxChars: 5 })
  for (const chunk of chunks) {
    assert.ok([...chunk].length <= 5)
  }
  assert.ok(chunks.length >= 2)
})

test('chunkText in codepoint mode never splits a surrogate pair at the boundary', () => {
  // '😀' (U+1F600) is two UTF-16 code units; here it straddles the maxChars cut point
  // (maxChars = 5 lands between the high surrogate at index 4 and low surrogate at index 5).
  const text = 'AAAA😀BB'
  const chunks = chunkText(text, { maxChars: 5 })
  for (const chunk of chunks) {
    assert.ok(hasNoLoneSurrogate(chunk), `chunk contains a lone surrogate: ${JSON.stringify(chunk)}`)
  }
  assert.deepEqual(chunks, ['AAAA', '😀BB'])
})

function hasNoLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false // lone low surrogate
    }
  }
  return true
}
