import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePromptReply, renderPrompt, type PendingPrompt } from '../src/prompt-render.ts'

const caps = { supportsChoices: true, supportsMultiSelect: false }

function pending(overrides: Partial<PendingPrompt> = {}): PendingPrompt {
  return {
    num: 1,
    requestId: 'r1',
    question: '选哪个？',
    options: ['A', 'B'],
    multiSelect: false,
    allowFreeText: false,
    expiresAt: Date.now() + 60_000,
    resolve() {},
    ...overrides,
  }
}

test('renderPrompt produces choices with prompt:<num>:<idx> ids', () => {
  const out = renderPrompt({ num: 1, question: '选哪个？', options: ['A', 'B'] }, caps)
  assert.equal(out.kind, 'choices')
  if (out.kind !== 'choices') return
  assert.deepEqual(out.choices, [
    { id: 'prompt:1:0', label: 'A' },
    { id: 'prompt:1:1', label: 'B' },
  ])
  assert.match(out.text, /选哪个/)
})

test('renderPrompt marks the recommended option', () => {
  const out = renderPrompt({ num: 1, question: 'q', options: ['A', 'B'], recommendedIndex: 0 }, caps)
  assert.equal(out.kind, 'choices')
  if (out.kind !== 'choices') return
  assert.equal(out.choices[0]!.label, 'A (Recommended)')
})

test('renderPrompt falls back to numbered text without buttons', () => {
  const out = renderPrompt({ num: 1, question: 'q', options: ['A', 'B'] }, { supportsChoices: false, supportsMultiSelect: false })
  assert.equal(out.kind, 'text')
  if (out.kind !== 'text') return
  assert.match(out.text, /1\. A/)
  assert.match(out.text, /2\. B/)
})

test('renderPrompt honours maxOptions by degrading to text', () => {
  const out = renderPrompt(
    { num: 1, question: 'q', options: ['A', 'B', 'C'] },
    { supportsChoices: true, supportsMultiSelect: false, presentationLimits: { maxOptions: 2 } },
  )
  assert.equal(out.kind, 'text')
})

test('parsePromptReply parses choiceId', () => {
  const reply = parsePromptReply({ choiceId: 'prompt:1:1' }, [pending()])
  assert.deepEqual(reply, { kind: 'answer', num: 1, answer: { selected: ['B'] } })
})

test('parsePromptReply parses #n and bare numbers', () => {
  assert.deepEqual(parsePromptReply({ text: '#1 B' }, [pending()]), { kind: 'answer', num: 1, answer: { selected: ['B'] } })
  assert.deepEqual(parsePromptReply({ text: '2' }, [pending()]), { kind: 'answer', num: 1, answer: { selected: ['B'] } })
  assert.deepEqual(parsePromptReply({ text: 'A' }, [pending()]), { kind: 'answer', num: 1, answer: { selected: ['A'] } })
})

test('parsePromptReply supports multi-select numbers', () => {
  const entry = pending({ multiSelect: true })
  assert.deepEqual(parsePromptReply({ text: '1, 2' }, [entry]), { kind: 'answer', num: 1, answer: { selected: ['A', 'B'] } })
})

test('parsePromptReply captures free text when allowed', () => {
  const entry = pending({ allowFreeText: true })
  assert.deepEqual(parsePromptReply({ text: '随便写点什么' }, [entry]), { kind: 'answer', num: 1, answer: { selected: [], custom: '随便写点什么' } })
})

test('parsePromptReply rejects bare numbers when multiple pending', () => {
  const two = [pending(), pending({ num: 2, requestId: 'r2' })]
  assert.deepEqual(parsePromptReply({ text: '1' }, two), { kind: 'not-an-answer' })
})

test('parsePromptReply ignores expired pending', () => {
  const expired = pending({ expiresAt: Date.now() - 1000 })
  assert.deepEqual(parsePromptReply({ text: '1' }, [expired]), { kind: 'not-an-answer' })
})
