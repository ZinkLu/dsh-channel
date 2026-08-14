import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderForTier, stripReasoningTags, stripToolCallMarkup } from '../src/format.ts'

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

test('stripToolCallMarkup removes a balanced <tool_calls> block', () => {
  const text = 'Sorry, let me check again:\n<tool_calls>\n<invoke name="Bash">\n<parameter name="command" string="true">date</parameter>\n</invoke>\n</tool_calls>'
  assert.equal(stripToolCallMarkup(text), 'Sorry, let me check again:')
})

test('stripToolCallMarkup keeps text before and after the block', () => {
  const text = 'before\n<tool_calls>\n<invoke name="Bash">\n<parameter name="command">date</parameter>\n</invoke>\n</tool_calls>\nafter'
  assert.equal(stripToolCallMarkup(text), 'before\n\nafter')
})

test('stripToolCallMarkup removes adjacent blocks', () => {
  const text = 'a<tool_calls><invoke name="Bash"><parameter name="command">x</parameter></invoke></tool_calls>b'
  assert.equal(stripToolCallMarkup(text), 'ab')
})

test('stripToolCallMarkup removes unbalanced leftover tags', () => {
  const text = '<tool_calls>\n<invoke name="Bash">\n<parameter name="command">date'
  assert.equal(stripToolCallMarkup(text), 'date')
})

test('stripToolCallMarkup is a no-op for ordinary text', () => {
  const text = 'Hello, today is **Friday**, `code` and [link](https://e.com)'
  assert.equal(stripToolCallMarkup(text), text)
})

test('stripReasoningTags removes reasoning and thinking blocks', () => {
  assert.equal(stripReasoningTags('a <reasoning>secret</reasoning> b'), 'a  b')
  assert.equal(stripReasoningTags('<thinking>t</thinking>x'), 'x')
})

test('stripReasoningTags removes preamble lines', () => {
  assert.equal(stripReasoningTags('Reasoning:\nactual output'), 'actual output')
  assert.equal(stripReasoningTags('Thinking:\nactual output'), 'actual output')
})

test('stripReasoningTags strict strips inside fences, preserve keeps them', () => {
  const fenced = '```\n<reasoning>literal</reasoning>\n```'
  assert.ok(stripReasoningTags(fenced, { mode: 'preserve' }).includes('<reasoning>literal</reasoning>'))
  assert.ok(!stripReasoningTags(fenced).includes('<reasoning>'))
})

test('stripReasoningTags is a no-op for ordinary text', () => {
  const text = 'A normal answer with `code` and [link](https://e.com)'
  assert.equal(stripReasoningTags(text), text)
})
