import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatToolLine, formatToolResultLine, resolveToolDisplay } from '../src/policy/tool-display.ts'

test('resolveToolDisplay maps known tools to emoji+label', () => {
  assert.deepEqual(resolveToolDisplay('Bash', '{"command":"npm test"}'), { emoji: '🛠️', label: 'Bash', detail: 'npm test' })
  assert.deepEqual(resolveToolDisplay('web_search', '{"query":"foo"}'), { emoji: '🔎', label: 'Web Search', detail: 'foo' })
})

test('resolveToolDisplay falls back for unknown tools', () => {
  const display = resolveToolDisplay('mystery_tool')
  assert.equal(display.emoji, '🧩')
  assert.equal(display.label, 'mystery_tool')
  assert.equal(display.detail, undefined)
})

test('resolveToolDisplay tolerates unparseable args', () => {
  assert.equal(resolveToolDisplay('Bash', '{not json').detail, undefined)
})

test('formatToolLine renders label: detail', () => {
  const line = formatToolLine({ emoji: '🔎', label: 'Web Search', detail: 'foo' }, { detailMode: 'compact' })
  assert.equal(line, '🔎 Web Search: foo')
})

test('formatToolLine renders shell command as whole line in raw mode', () => {
  const line = formatToolLine({ emoji: '🛠️', label: 'Bash', detail: 'npm test' }, { detailMode: 'compact', commandText: 'raw' })
  assert.equal(line, '🛠️ npm test')
})

test('formatToolLine truncates long detail', () => {
  const line = formatToolLine({ emoji: '🛠️', label: 'Bash', detail: 'x'.repeat(100) }, { detailMode: 'compact', maxDetailChars: 10 })
  assert.equal([...line].length, [...'🛠️ Bash: '].length + 10)
  assert.ok(line.endsWith('…'))
})

test('formatToolResultLine renders success and failure', () => {
  assert.equal(formatToolResultLine('Bash', { ok: true, durationMs: 400 }), '✅ Bash · 400ms')
  assert.equal(formatToolResultLine('Bash', { ok: true, durationMs: 1400 }), '✅ Bash · 1.4s')
  assert.match(formatToolResultLine('Bash', { ok: false, summary: 'non-zero exit' }), /^⛔ Bash · non-zero exit$/)
})
