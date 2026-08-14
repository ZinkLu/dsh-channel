import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderForTier } from '../src/format.ts'

test('markdown tier returns source unchanged', () => {
  const md = '**bold** `code` [t](u)'
  assert.equal(renderForTier(md, 'markdown'), md)
})

test('html tier renders code, bold, links and escapes other html', () => {
  const md = '**bold** `a < b` [link](https://e.com?x=1&y=2) <script>'
  const html = renderForTier(md, 'html')
  assert.ok(html.includes('<b>bold</b>'))
  assert.ok(html.includes('<code>a &lt; b</code>'))
  assert.ok(html.includes('<a href="https://e.com?x=1&amp;y=2">link</a>'))
  assert.ok(html.includes('&lt;script&gt;'))
})

test('html tier turns fenced code into pre with escaped content', () => {
  const md = '```js\nconst a = 1 < 2;\n```'
  const html = renderForTier(md, 'html')
  assert.ok(html.includes('<pre>const a = 1 &lt; 2;</pre>'))
})

test('html tier keeps unbalanced fences literal', () => {
  const md = '```js\nnever closed'
  const html = renderForTier(md, 'html')
  assert.ok(html.includes('```js'))
  assert.ok(!html.includes('<pre>'))
})

test('plain tier removes inline markdown and keeps table aligned', () => {
  const md = '**bold** `code` [t](u)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'
  const plain = renderForTier(md, 'plain')
  assert.ok(plain.includes('bold code t (u)'))
  assert.ok(plain.includes('a | b'))
  assert.ok(plain.includes('1 | 2'))
})

test('html tier renders table as pre', () => {
  const md = '| a | b |\n| --- | --- |\n| 1 | 2 |'
  const html = renderForTier(md, 'html')
  assert.ok(html.includes('<pre>'))
  assert.ok(html.includes('a | b'))
})
