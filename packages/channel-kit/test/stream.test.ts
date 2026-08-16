import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyStreamState, streamReduce, type StreamCaps, type StreamFrame } from '../src/policy/stream.ts'

const progressCaps: StreamCaps = { streamingMode: 'progress', supportsEdit: true, supportsStatusText: false, thinkingLevel: 'off' }
const offCaps: StreamCaps = { streamingMode: 'off', supportsEdit: true, supportsStatusText: false, thinkingLevel: 'off' }

function frames(state = emptyStreamState, caps = progressCaps, ...inputs: Array<{ kind: string } & Record<string, unknown>>): StreamFrame[] {
  let s = state
  const out: StreamFrame[] = []
  for (const input of inputs) {
    const r = streamReduce(s, input as never, caps, 0)
    s = r.state
    out.push(...r.frames)
  }
  return out
}

test('off mode emits final only on assistant-message', () => {
  const fs = frames(emptyStreamState, offCaps,
    { kind: 'tool-call', callId: 'c', name: 'Bash', arguments: '{}' },
    { kind: 'assistant-message', text: 'done' },
  )
  assert.deepEqual(fs.filter((f) => f.kind !== 'noop'), [{ kind: 'final', text: 'done' }])
})

test('progress mode gates the draft behind the timer', () => {
  let s = emptyStreamState
  let r = streamReduce(s, { kind: 'turn-start' }, progressCaps, 100)
  s = r.state
  r = streamReduce(s, { kind: 'tool-call', callId: 'c', name: 'Bash', arguments: '{"command":"npm test"}' }, progressCaps, 100)
  s = r.state
  // Gate not triggered: only arm the timer, no draft yet.
  assert.deepEqual(r.frames, [{ kind: 'arm-timer', at: 1600 }])
  assert.equal(s.draftStarted, false)

  r = streamReduce(s, { kind: 'tick' }, progressCaps, 1700)
  s = r.state
  assert.equal(s.draftStarted, true)
  assert.deepEqual(r.frames, [{ kind: 'draft', text: 'Working…\n🛠️ Bash: npm test' }])

  r = streamReduce(s, { kind: 'tool-result', callId: 'c', name: 'Bash', ok: true, durationMs: 400 }, progressCaps, 1800)
  s = r.state
  assert.deepEqual(r.frames, [{ kind: 'draft', text: 'Working…\n🛠️ Bash: npm test\n✅ Bash · 400ms' }])
})

test('progress mode finalizes draft then emits final on assistant-message', () => {
  let s = emptyStreamState
  s = streamReduce(s, { kind: 'turn-start' }, progressCaps, 0).state
  s = streamReduce(s, { kind: 'tool-call', callId: 'c', name: 'Bash', arguments: '{}' }, progressCaps, 0).state
  s = streamReduce(s, { kind: 'tick' }, progressCaps, 2000).state
  const r = streamReduce(s, { kind: 'assistant-message', text: 'done' }, progressCaps, 2100)
  assert.deepEqual(r.frames, [{ kind: 'draft-finalize', editFailed: false }, { kind: 'final', text: 'done' }])
  assert.equal(r.state.draftStarted, false)
})

test('progress mode finalizes draft on turn-end without final', () => {
  let s = emptyStreamState
  s = streamReduce(s, { kind: 'tool-call', callId: 'c', name: 'Bash', arguments: '{}' }, progressCaps, 0).state
  s = streamReduce(s, { kind: 'tick' }, progressCaps, 2000).state
  const r = streamReduce(s, { kind: 'turn-end', reason: 'completed' }, progressCaps, 2100)
  assert.deepEqual(r.frames, [{ kind: 'draft-finalize', editFailed: false }])
})

test('quick turn never starts a draft (no tick before assistant-message)', () => {
  const fs = frames(emptyStreamState, progressCaps,
    { kind: 'tool-call', callId: 'c', name: 'Bash', arguments: '{}' },
    { kind: 'assistant-message', text: 'fast' },
  )
  assert.ok(!fs.some((f) => f.kind === 'draft'))
  assert.deepEqual(fs.filter((f) => f.kind === 'final'), [{ kind: 'final', text: 'fast' }])
})

test('edit-failed flips to append-tail status lines and resets on final', () => {
  let s = emptyStreamState
  s = streamReduce(s, { kind: 'turn-start' }, progressCaps, 0).state
  s = streamReduce(s, { kind: 'tool-call', callId: 'c', name: 'Bash', arguments: '{}' }, progressCaps, 0).state
  s = streamReduce(s, { kind: 'tick' }, progressCaps, 2000).state
  assert.equal(s.draftText, 'Working…\n🛠️ Bash')
  assert.equal(s.editFailed, false)

  const failed = streamReduce(s, { kind: 'edit-failed', visiblePrefix: 'Working…\n🛠️ Bash' }, progressCaps, 2100)
  s = failed.state
  assert.equal(s.editFailed, true)
  assert.equal(s.visiblePrefix, 'Working…\n🛠️ Bash')

  const tail = streamReduce(s, { kind: 'tool-result', callId: 'c', name: 'Bash', ok: true, durationMs: 400 }, progressCaps, 2200)
  assert.deepEqual(tail.frames, [{ kind: 'status-line', text: '✅ Bash · 400ms' }])

  const final = streamReduce(tail.state, { kind: 'assistant-message', text: 'done' }, progressCaps, 2300)
  // The frame carries the edit-failure fact forward: the bridge must retain the
  // preview (it still holds text the user saw) instead of deleting it.
  assert.deepEqual(final.frames, [{ kind: 'draft-finalize', editFailed: true }, { kind: 'final', text: 'done' }])
  assert.equal(final.state.editFailed, false)
})
