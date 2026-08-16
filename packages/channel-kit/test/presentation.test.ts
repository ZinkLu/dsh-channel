import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assistantMessageText, defaultPresentationPolicy, projectSessionEvent, type PresentationPolicy } from '../src/policy/presentation.ts'
import { emptyStreamState, type StreamCaps, type StreamInput } from '../src/policy/stream.ts'

const progressCaps: StreamCaps = { streamingMode: 'progress', supportsEdit: true, supportsStatusText: false, thinkingLevel: 'off' }

test('projectSessionEvent splits the reasoning block from the visible text', () => {
  const inputs = projectSessionEvent(
    { type: 'assistant/message', seq: 1, data: { message: { role: 'assistant', content: [
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: 'hi there' },
    ] } } },
    () => undefined,
  )
  assert.deepEqual(inputs.map((input) => input.kind), ['reasoning-block', 'assistant-message'])
  assert.equal((inputs[0] as { text: string }).text, 'let me think')
  assert.equal((inputs[1] as { text: string }).text, 'hi there')
})

test('projectSessionEvent ignores events it does not know', () => {
  assert.deepEqual(projectSessionEvent({ type: 'unknown', seq: 1, data: {} }, () => undefined), [])
})

test('assistantMessageText strips reasoning/tool-call markup from visible text', () => {
  assert.equal(assistantMessageText({ content: [{ type: 'text', text: 'a <reasoning>x</reasoning> b' }] }), 'a  b')
})

test('a custom renderToolCall flows into reduce (the seam is real, not a fake)', () => {
  const policy: PresentationPolicy = { ...defaultPresentationPolicy, renderToolCall: () => '🔧 CUSTOM-TOOL' }
  const input: StreamInput = { kind: 'tool-call', callId: 'c1', name: 'Bash', arguments: '{}' }

  let state = policy.reduce(emptyStreamState, { kind: 'turn-start' }, progressCaps, 0, policy).state
  state = policy.reduce(state, input, progressCaps, 0, policy).state // arms the 1500ms gate
  const frames = policy.reduce(state, { kind: 'tick' }, progressCaps, 2000, policy).frames // gate fires → draft

  const draft = frames.find((frame) => frame.kind === 'draft')
  assert.ok(draft && draft.kind === 'draft')
  assert.match(draft.text, /CUSTOM-TOOL/)
})

test('thinkingLevel on emits one status line for the final reasoning block, then coalesces', () => {
  const caps: StreamCaps = { ...progressCaps, thinkingLevel: 'on' }
  const policy = defaultPresentationPolicy

  let state = policy.reduce(emptyStreamState, { kind: 'turn-start' }, caps, 0, policy).state
  let result = policy.reduce(state, { kind: 'reasoning-block', text: 'think' }, caps, 0, policy)
  state = result.state
  assert.ok(result.frames.some((frame) => frame.kind === 'status-line'))

  // A second reasoning unit in the same turn is coalesced (no spam).
  result = policy.reduce(state, { kind: 'reasoning-block', text: 'think again' }, caps, 0, policy)
  assert.ok(!result.frames.some((frame) => frame.kind === 'status-line'))
})

test('thinkingLevel off never emits a status line', () => {
  const policy = defaultPresentationPolicy
  const result = policy.reduce(emptyStreamState, { kind: 'reasoning-block', text: 'think' }, progressCaps, 0, policy)
  assert.ok(!result.frames.some((frame) => frame.kind === 'status-line'))
})
