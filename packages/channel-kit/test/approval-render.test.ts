import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseApprovalReply, renderApproval } from '../src/approval-render.ts'

const pending = [
  { num: 1, requestId: 'r1', toolName: 'Bash', expiresAt: Date.now() + 60_000 },
  { num: 2, requestId: 'r2', toolName: 'Read', expiresAt: Date.now() + 60_000 },
]

test('renderApproval produces choices when supported', () => {
  const out = renderApproval({ toolName: 'Bash', reason: 'rm -rf', num: 1 }, { supportsChoices: true })
  assert.equal(out.kind, 'choices')
  if (out.kind !== 'choices') return
  assert.deepEqual(out.choices, [
    { id: 'appr:1:1', label: '批准' },
    { id: 'appr:1:0', label: '拒绝' },
  ])
})

test('renderApproval falls back to numbered text when no buttons', () => {
  const out = renderApproval({ toolName: 'Bash', num: 1 }, { supportsChoices: false })
  assert.equal(out.kind, 'text')
  if (out.kind !== 'text') return
  assert.match(out.text, /#1/)
  assert.match(out.text, /回复 1 批准 \/ 2 拒绝/)
})

test('parseApprovalReply parses choiceId', () => {
  assert.deepEqual(parseApprovalReply({ choiceId: 'appr:1:1' }, pending), { kind: 'answer', num: 1, outcome: 'allowed-once' })
  assert.deepEqual(parseApprovalReply({ choiceId: 'appr:2:0' }, pending), { kind: 'answer', num: 2, outcome: 'rejected' })
  assert.deepEqual(parseApprovalReply({ choiceId: 'appr:9:1' }, pending), { kind: 'not-an-answer' })
})

test('parseApprovalReply handles single-pending bare numbers and words', () => {
  const one = [pending[0]!]
  assert.deepEqual(parseApprovalReply({ text: '1' }, one), { kind: 'answer', num: 1, outcome: 'allowed-once' })
  assert.deepEqual(parseApprovalReply({ text: '2' }, one), { kind: 'answer', num: 1, outcome: 'rejected' })
  assert.deepEqual(parseApprovalReply({ text: '批准' }, one), { kind: 'answer', num: 1, outcome: 'allowed-once' })
  assert.deepEqual(parseApprovalReply({ text: '拒绝' }, one), { kind: 'answer', num: 1, outcome: 'rejected' })
})

test('bare numbers with multiple pending are not answers', () => {
  assert.deepEqual(parseApprovalReply({ text: '1' }, pending), { kind: 'not-an-answer' })
})

test('numbered replies require the pending to exist', () => {
  assert.deepEqual(parseApprovalReply({ text: '#2 1' }, pending), { kind: 'answer', num: 2, outcome: 'allowed-once' })
  assert.deepEqual(parseApprovalReply({ text: '#3 1' }, pending), { kind: 'not-an-answer' })
})

test('expired pending is ignored', () => {
  const expired = [{ ...pending[0]!, expiresAt: Date.now() - 1000 }]
  assert.deepEqual(parseApprovalReply({ text: '1' }, expired), { kind: 'not-an-answer' })
})
